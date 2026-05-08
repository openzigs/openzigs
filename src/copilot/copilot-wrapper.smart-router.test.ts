/**
 * Phase 3.5 wiring tests for `CopilotWrapperService`:
 *   - smart router decides per-request when both providers are configured
 *   - audit logger captures the routing decision
 *   - cost meter receives a row tagged with the routed providerKind
 *   - privacy mode short-circuits routing
 *   - RouterPrivacyError surfaces when privacy mode is on but no local provider
 *
 * Tests use a `FakeCopilotClient` and a `FakeSession` that emit the same SDK
 * events the real client does (`assistant.message_delta`, `session.idle`,
 * `assistant.usage`).
 */
import { describe, expect, it, vi } from "vitest";
import {
  CopilotWrapperService,
  type CostMeterLike,
  type AuditLoggerLike,
  type ProviderConfig,
} from "./copilot-wrapper.js";
import { RouterPrivacyError } from "./smart-router.js";

class FakeSession {
  readonly sessionId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, Array<(event: any) => void>>();
  constructor(sessionId = "fake") {
    this.sessionId = sessionId;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any) => void): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const handlers = this.handlers.get(event) ?? [];
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  }
  async sendAndWait({ prompt }: { prompt: string }) {
    if (!prompt) throw new Error("missing prompt");
    this.emit("assistant.message_delta", { data: { deltaContent: "ok" } });
    this.emit("assistant.usage", { data: { inputTokens: 200, outputTokens: 50 } });
    this.emit("session.idle", {});
  }
  async destroy() {
    /* noop */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, payload: any) {
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }
}

class FakeCopilotClient {
  public lastSessionConfig:
    | { provider?: { type?: string; baseUrl?: string }; sessionId?: string }
    | null = null;
  public sessions: FakeSession[] = [];
  async start() {
    /* noop */
  }
  async createSession(config: {
    provider?: { type?: string; baseUrl?: string };
    sessionId?: string;
  }) {
    this.lastSessionConfig = config;
    const s = new FakeSession(config.sessionId ?? `s-${this.sessions.length}`);
    this.sessions.push(s);
    return s;
  }
  async resumeSession(_id: string): Promise<FakeSession> {
    throw new Error("no resume");
  }
  async stop() {
    return [] as Error[];
  }
}

vi.mock("../config/user-model.js", () => ({
  getUserSelectedModel: vi.fn().mockResolvedValue(undefined),
}));

const localProvider: ProviderConfig = {
  type: "local-copilot",
  endpoint: "http://127.0.0.1:11434/v1",
  model: "gemma4:26b",
};
const cloudProvider: ProviderConfig = {
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
};

interface CapturedAudit {
  event: string;
  category: string;
  details: Record<string, unknown>;
}

interface CapturedCost {
  sessionId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  providerKind: "local-copilot" | "cloud";
  cloudEquivalentModelId?: string;
}

const buildHarness = (overrides: {
  smartRouter?: { enabled: boolean; cloudThresholdTokens: number };
  privacyMode?: "off" | "session" | "global";
  withLocal?: boolean;
  withCloud?: boolean;
}) => {
  const audits: CapturedAudit[] = [];
  const costs: CapturedCost[] = [];
  const auditLogger: AuditLoggerLike = {
    log: async (entry) => {
      audits.push({
        event: entry.event,
        category: entry.category,
        details: entry.details,
      });
      return entry;
    },
  };
  const costMeter: CostMeterLike = {
    record: (input) => {
      costs.push({
        sessionId: input.sessionId,
        modelId: input.modelId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        providerKind: input.providerKind,
        cloudEquivalentModelId: input.cloudEquivalentModelId,
      });
      return input;
    },
  };
  const client = new FakeCopilotClient();
  const wrapper = new CopilotWrapperService({
    client,
    localProvider: overrides.withLocal === false ? undefined : localProvider,
    cloudProvider: overrides.withCloud === false ? undefined : cloudProvider,
    smartRouter: overrides.smartRouter,
    privacyMode: overrides.privacyMode,
    costMeter,
    auditLogger,
    cloudEquivalentModelId: "gpt-4.1",
  });
  return { client, wrapper, audits, costs };
};

const drain = async (gen: AsyncGenerator<string>) => {
  const out: string[] = [];
  for await (const c of gen) out.push(c);
  return out.join("");
};

describe("CopilotWrapperService — smart router wiring", () => {
  it("routes small prompts to local and audit-logs the decision", async () => {
    const { client, wrapper, audits, costs } = buildHarness({
      smartRouter: { enabled: true, cloudThresholdTokens: 4096 },
    });
    await drain(wrapper.chat("Hello world", { conversationId: "conv-a" }));

    // Provider on the SDK call must match the local-copilot endpoint
    const provider = client.lastSessionConfig?.provider;
    expect(provider?.type).toBe("openai"); // local-copilot maps to openai
    expect(provider?.baseUrl).toBe("http://127.0.0.1:11434/v1");

    const decision = audits.find((a) => a.event === "router.decision");
    expect(decision).toBeDefined();
    expect(decision?.details.router).toBe("local");
    expect(decision?.details.reason).toBe("below_threshold_local");
    expect(decision?.details.inputTokens).toBeLessThan(4096);

    // Cost row: local kind, would-have-cost > 0 because cloud equivalent set
    expect(costs).toHaveLength(1);
    expect(costs[0].providerKind).toBe("local-copilot");
    expect(costs[0].cloudEquivalentModelId).toBe("gpt-4.1");
    expect(costs[0].inputTokens).toBe(200);
    expect(costs[0].outputTokens).toBe(50);
  });

  it("routes large prompts to cloud and tags the cost row", async () => {
    const { client, wrapper, audits, costs } = buildHarness({
      smartRouter: { enabled: true, cloudThresholdTokens: 256 },
    });
    // 8000-char prompt → ~2000 tokens, well over threshold of 256
    const big = "a".repeat(8000);
    await drain(wrapper.chat(big, { conversationId: "conv-b" }));

    const provider = client.lastSessionConfig?.provider;
    expect(provider?.baseUrl).toBe("https://api.openai.com/v1");

    const decision = audits.find((a) => a.event === "router.decision");
    expect(decision?.details.router).toBe("cloud");
    expect(decision?.details.reason).toBe("above_threshold_cloud");

    expect(costs).toHaveLength(1);
    expect(costs[0].providerKind).toBe("cloud");
    expect(costs[0].cloudEquivalentModelId).toBeUndefined();
  });

  it("global privacy mode forces local regardless of token count", async () => {
    const { client, wrapper, audits, costs } = buildHarness({
      smartRouter: { enabled: true, cloudThresholdTokens: 256 },
      privacyMode: "global",
    });
    const big = "x".repeat(50_000);
    await drain(wrapper.chat(big, { conversationId: "conv-c" }));

    expect(client.lastSessionConfig?.provider?.baseUrl).toBe(
      "http://127.0.0.1:11434/v1",
    );
    const decision = audits.find((a) => a.event === "router.decision");
    expect(decision?.details.reason).toBe("privacy_mode_local");
    expect(costs[0].providerKind).toBe("local-copilot");
  });

  it("privacy mode without local provider throws RouterPrivacyError", async () => {
    const { wrapper } = buildHarness({
      privacyMode: "global",
      withLocal: false,
    });
    await expect(
      drain(wrapper.chat("anything", { conversationId: "conv-priv" })),
    ).rejects.toBeInstanceOf(RouterPrivacyError);
  });

  it("disabled smart router always picks cloud, audit reason = router_disabled", async () => {
    const { client, wrapper, audits } = buildHarness({
      smartRouter: { enabled: false, cloudThresholdTokens: 4096 },
    });
    await drain(wrapper.chat("tiny", { conversationId: "conv-d" }));

    expect(client.lastSessionConfig?.provider?.baseUrl).toBe(
      "https://api.openai.com/v1",
    );
    const decision = audits.find((a) => a.event === "router.decision");
    expect(decision?.details.router).toBe("cloud");
    expect(decision?.details.reason).toBe("router_disabled");
  });

  it("setSmartRouterConfig updates routing live without reconstruction", async () => {
    const { client, wrapper, audits } = buildHarness({
      smartRouter: { enabled: true, cloudThresholdTokens: 4096 },
    });
    // First call — small prompt → local
    await drain(wrapper.chat("small", { conversationId: "conv-e1" }));
    expect(client.lastSessionConfig?.provider?.baseUrl).toBe(
      "http://127.0.0.1:11434/v1",
    );
    // Toggle off via the new setter, then call again → must go cloud
    wrapper.setSmartRouterConfig({ enabled: false });
    await drain(wrapper.chat("small", { conversationId: "conv-e2" }));
    expect(client.lastSessionConfig?.provider?.baseUrl).toBe(
      "https://api.openai.com/v1",
    );
    // Two router decisions audit-logged
    const decisions = audits.filter((a) => a.event === "router.decision");
    expect(decisions).toHaveLength(2);
    expect(decisions[1].details.reason).toBe("router_disabled");
  });

  it("when only one provider is set, smart router does NOT engage (legacy path)", async () => {
    // Cloud-only setup → no router decision audited.
    const { wrapper, audits, costs } = buildHarness({
      withLocal: false,
    });
    await drain(wrapper.chat("anything", { conversationId: "conv-f" }));
    expect(audits.find((a) => a.event === "router.decision")).toBeUndefined();
    // Cost meter still records the call as cloud-kind (default fallback).
    expect(costs[0].providerKind).toBe("cloud");
  });
});

describe("CopilotWrapperService — cost meter integration", () => {
  it("records actual local-copilot call with cloud equivalent for would-have-cost", async () => {
    const { wrapper, costs } = buildHarness({
      smartRouter: { enabled: true, cloudThresholdTokens: 4096 },
    });
    await drain(wrapper.chat("hello", { conversationId: "c-1" }));
    expect(costs).toHaveLength(1);
    expect(costs[0].providerKind).toBe("local-copilot");
    expect(costs[0].cloudEquivalentModelId).toBe("gpt-4.1");
  });

  it("records actual cloud call without cloud-equivalent override", async () => {
    const { wrapper, costs } = buildHarness({
      smartRouter: { enabled: true, cloudThresholdTokens: 1 },
    });
    await drain(wrapper.chat("trigger cloud", { conversationId: "c-2" }));
    expect(costs[0].providerKind).toBe("cloud");
    expect(costs[0].cloudEquivalentModelId).toBeUndefined();
  });

  it("swallows cost-meter errors so a meter outage never breaks chat", async () => {
    const { wrapper } = buildHarness({
      smartRouter: { enabled: true, cloudThresholdTokens: 4096 },
    });
    // Replace the meter with one that always throws
    wrapper.setCostMeter({
      record: () => {
        throw new Error("meter is down");
      },
    });
    // Chat must complete normally despite the meter throwing.
    const out = await drain(wrapper.chat("ok", { conversationId: "c-3" }));
    expect(out).toContain("ok");
  });
});
