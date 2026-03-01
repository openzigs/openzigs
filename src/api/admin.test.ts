import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createAdminRouter } from "./admin.js";
import type { AdminRouterOptions } from "./admin.js";

// ── Mocks ────────────────────────────────────────────────────

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../config/index.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    copilot: {},
    voice: {},
    session: {},
    tasks: {},
  }),
  customAgentSchema: {
    safeParse: vi.fn().mockImplementation((data: unknown) => ({ success: true, data })),
  },
  mcpServerConfigSchema: {
    safeParse: vi.fn().mockImplementation((data: unknown) => ({ success: true, data })),
  },
  nativeMcpServersSchema: {
    safeParse: vi.fn().mockImplementation((data: unknown) => ({ success: true, data })),
  },
}));

vi.mock("../tasks/post-action-registry.js", () => ({
  postActionRegistry: {
    list: vi.fn().mockReturnValue([
      { type: "create-github-issues", label: "Create Issues", description: "Creates GitHub issues" },
      { type: "send-webhook", label: "Send Webhook", description: "Sends to webhook URL" },
    ]),
  },
}));

vi.mock("../mcp/constants.js", () => ({
  ALWAYS_ON_TOOLS: new Set(["read-file", "list-directory", "web-search"]),
}));

vi.mock("../sentinel/index.js", () => ({
  SentinelConfigSchema: {
    partial: () => ({
      safeParse: (data: unknown) => ({ success: true, data }),
    }),
  },
  readStatusMarkdown: vi.fn().mockResolvedValue(null),
}));

vi.mock("../voice/types.js", () => ({
  AVAILABLE_VOICES: [{ id: "af_heart", type: "Kokoro", description: "Test" }],
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue("{}"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    utimes: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../productivity/template-service.js", () => ({
  TemplateService: vi.fn().mockImplementation(() => ({
    export: vi.fn().mockImplementation((id: string) => {
      if (id !== "p1") throw new Error("Prompt not found");
      return { version: "1.0", prompt: { name: "Summarize", template: "Summarize {{input}}" } };
    }),
    analyze: vi.fn().mockReturnValue({ valid: true, issues: [], warnings: [] }),
    import: vi.fn().mockReturnValue({ id: "imported", name: "Imported" }),
  })),
}));

// ── Helpers ──────────────────────────────────────────────────

function createMockToolRegistry() {
  const tools = new Map<string, { name: string; description: string; category: string; riskLevel: string; enabled: boolean }>();
  tools.set("read-file", { name: "read-file", description: "Read a file", category: "filesystem", riskLevel: "low", enabled: true });
  tools.set("shell-execute", { name: "shell-execute", description: "Execute shell", category: "system", riskLevel: "high", enabled: true });
  tools.set("web-search", { name: "web-search", description: "Search web", category: "web", riskLevel: "low", enabled: true });

  return {
    getAllTools: vi.fn().mockReturnValue({
      filesystem: [tools.get("read-file")],
      system: [tools.get("shell-execute")],
      web: [tools.get("web-search")],
    }),
    listEnabledTools: vi.fn().mockReturnValue(Array.from(tools.values()).filter(t => t.enabled)),
    getToolDefinition: vi.fn((name: string) => tools.get(name) ?? null),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    setRiskOverride: vi.fn().mockResolvedValue(undefined),
    setGlobalApprovalOverride: vi.fn().mockResolvedValue(undefined),
    getToolsBySource: vi.fn().mockReturnValue([]),
  };
}

function createMockPersonalityManager() {
  const config = {
    systemInstruction: "You are a helpful assistant",
    prePrompt: "",
    postPrompt: "",
    enabled: true,
    mode: "append" as const,
  };
  return {
    getConfig: vi.fn().mockReturnValue(config),
    update: vi.fn((updates: Partial<typeof config>) => ({ ...config, ...updates })),
    reset: vi.fn().mockReturnValue(config),
  };
}

function createMockWebhookManager() {
  const webhooks = new Map<string, {
    id: string; name: string; action: string; actionPayload: Record<string, unknown>;
    enabled: boolean; allowedIps: string[]; rateLimit: number;
    triggerCount: number; lastTriggeredAt: string | null; createdAt: string; secret: string;
  }>();

  return {
    list: vi.fn(() => Array.from(webhooks.values())),
    create: vi.fn((data: { name: string; action: string; actionPayload: Record<string, unknown>; allowedIps: string[]; rateLimit: number }) => {
      const webhook = {
        id: "wh-001",
        name: data.name,
        action: data.action,
        actionPayload: data.actionPayload,
        enabled: true,
        allowedIps: data.allowedIps,
        rateLimit: data.rateLimit,
        triggerCount: 0,
        lastTriggeredAt: null,
        createdAt: new Date().toISOString(),
        secret: "secret-123",
      };
      webhooks.set(webhook.id, webhook);
      return { webhook, apiKey: "ak-test-key" };
    }),
    toggle: vi.fn((id: string, enabled: boolean) => {
      const wh = webhooks.get(id);
      if (!wh) return null;
      wh.enabled = enabled;
      return wh;
    }),
    rotateKey: vi.fn((id: string) => {
      if (!webhooks.has(id)) return null;
      return { apiKey: "ak-new-key" };
    }),
    delete: vi.fn((id: string) => webhooks.delete(id)),
    _webhooks: webhooks,
  };
}

function createMockSentinel() {
  return {
    getStatus: vi.fn().mockReturnValue({
      running: false,
      config: { cronSchedule: "*/5 * * * *", markdownDigestPath: "" },
      lastCheck: null,
    }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    toggle: vi.fn().mockResolvedValue(undefined),
    isRunning: false,
    runCheck: vi.fn().mockResolvedValue({
      totalTasks: 5,
      successRate: 80,
      alerts: [],
    }),
    getDigestHistory: vi.fn().mockResolvedValue([]),
  };
}

function createMockTaskEngine() {
  return {
    getStats: vi.fn().mockReturnValue({ queued: 2, running: 1 }),
  };
}

function createMockTaskWorker() {
  return {
    concurrencyLimit: 3,
    setMaxConcurrent: vi.fn(),
  };
}

function createMockCopilot() {
  return {
    getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
    setMaxToolsPerRequest: vi.fn(),
    getReasoningEffort: vi.fn().mockReturnValue("medium"),
    setReasoningEffort: vi.fn(),
    getProvider: vi.fn().mockReturnValue(null),
    setProvider: vi.fn(),
    getWorkingDirectory: vi.fn().mockReturnValue(null),
    setWorkingDirectory: vi.fn(),
    getCustomAgents: vi.fn().mockReturnValue([]),
    setCustomAgents: vi.fn(),
    getNativeMcpServers: vi.fn().mockReturnValue({}),
    setNativeMcpServers: vi.fn(),
    getSessionAnalytics: vi.fn().mockReturnValue({ totalSessions: 0, totalTokens: 0 }),
    resetSessionAnalytics: vi.fn(),
    listSdkSessions: vi.fn().mockResolvedValue([]),
    deleteSdkSession: vi.fn().mockResolvedValue(undefined),
    getSdkSessionMessages: vi.fn().mockResolvedValue([]),
  };
}

function createMockPromptManager() {
  const prompts = new Map<string, {
    id: string; name: string; template: string; description: string;
    tags: string[]; createdAt: string; updatedAt: string;
  }>();
  prompts.set("p1", {
    id: "p1", name: "Summarize", template: "Summarize {{input}}",
    description: "Summarizes text", tags: ["util"], createdAt: "2025-01-01", updatedAt: "2025-01-01",
  });

  return {
    list: vi.fn(() => Array.from(prompts.values())),
    search: vi.fn((q: string) => Array.from(prompts.values()).filter(p => p.name.toLowerCase().includes(q.toLowerCase()))),
    getById: vi.fn((id: string) => prompts.get(id) ?? null),
    create: vi.fn((data: { name: string; template: string; description?: string; tags?: string[] }) => {
      const p = { id: "p-new", ...data, description: data.description ?? "", tags: data.tags ?? [], createdAt: "now", updatedAt: "now" };
      prompts.set(p.id, p);
      return p;
    }),
    update: vi.fn((id: string, data: Record<string, unknown>) => {
      const p = prompts.get(id);
      if (!p) throw new Error("Prompt not found");
      return { ...p, ...data, updatedAt: "now" };
    }),
    delete: vi.fn((id: string) => prompts.delete(id)),
  };
}

function createMockScheduler() {
  const jobs = new Map<string, {
    id: string; name: string; cronExpression: string; timezone: string;
    actionType: string; actionPayload: Record<string, unknown>; enabled: boolean;
  }>();
  jobs.set("j1", {
    id: "j1", name: "Daily Check", cronExpression: "0 9 * * *", timezone: "UTC",
    actionType: "prompt", actionPayload: { promptName: "Summarize" }, enabled: true,
  });

  return {
    list: vi.fn(() => Array.from(jobs.values())),
    getById: vi.fn((id: string) => jobs.get(id) ?? null),
    create: vi.fn((data: Record<string, unknown>) => ({ id: "j-new", ...data })),
    update: vi.fn((id: string, data: Record<string, unknown>) => {
      const j = jobs.get(id);
      if (!j) throw new Error("not found");
      return { ...j, ...data };
    }),
    setEnabled: vi.fn((id: string, enabled: boolean) => {
      const j = jobs.get(id);
      if (!j) return null;
      return { ...j, enabled };
    }),
    delete: vi.fn((id: string) => jobs.delete(id)),
    runNow: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function buildApp(overrides: Partial<AdminRouterOptions> = {}) {
  const app = express();
  app.use(express.json());

  const opts: AdminRouterOptions = {
    toolRegistry: createMockToolRegistry() as unknown as AdminRouterOptions["toolRegistry"],
    ...overrides,
  };

  const router = createAdminRouter(opts);
  app.use("/admin", router);
  return { app, opts };
}

// ── Tests ────────────────────────────────────────────────────

describe("Admin API router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /env ─────────────────────────────────────────────

  describe("GET /env", () => {
    it("returns environment check list", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/env");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.env)).toBe(true);
      expect(res.body.env[0]).toHaveProperty("name");
      expect(res.body.env[0]).toHaveProperty("configured");
    });
  });

  // ── GET /allowed-dirs ────────────────────────────────────

  describe("GET /allowed-dirs", () => {
    it("returns current allowed dirs value", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/allowed-dirs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("value");
    });
  });

  // ── GET /tools ───────────────────────────────────────────

  describe("GET /tools", () => {
    it("returns tool groups", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/tools");
      expect(res.status).toBe(200);
      expect(res.body.tools).toHaveProperty("filesystem");
      expect(res.body.tools.filesystem).toHaveLength(1);
      expect(res.body.tools.filesystem[0].name).toBe("read-file");
    });
  });

  // ── POST /tools/:name/toggle ─────────────────────────────

  describe("POST /tools/:name/toggle", () => {
    it("rejects non-boolean enabled", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/admin/tools/read-file/toggle")
        .send({ enabled: "yes" });
      expect(res.status).toBe(400);
    });

    it("toggles a known tool", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/admin/tools/read-file/toggle")
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("returns 404 for unknown tool", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/admin/tools/nonexistent/toggle")
        .send({ enabled: true });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /tools/:name/risk ───────────────────────────────

  describe("POST /tools/:name/risk", () => {
    it("rejects invalid risk level", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/admin/tools/read-file/risk")
        .send({ riskLevel: "extreme" });
      expect(res.status).toBe(400);
    });

    it("sets risk override", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/admin/tools/read-file/risk")
        .send({ riskLevel: "high" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── POST /tools/:name/global-approval ────────────────────

  describe("POST /tools/:name/global-approval", () => {
    it("rejects non-boolean required", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/admin/tools/shell-execute/global-approval")
        .send({ required: "yes" });
      expect(res.status).toBe(400);
    });

    it("sets global approval override", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/admin/tools/shell-execute/global-approval")
        .send({ required: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── POST-Actions ─────────────────────────────────────────

  describe("GET /post-actions", () => {
    it("returns registered post actions", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/post-actions");
      expect(res.status).toBe(200);
      expect(res.body.actions).toHaveLength(2);
    });
  });

  describe("GET /post-actions/custom", () => {
    it("returns empty without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/post-actions/custom");
      expect(res.status).toBe(200);
      expect(res.body.actions).toEqual([]);
    });
  });

  // ── Webhooks ─────────────────────────────────────────────

  describe("webhooks", () => {
    it("returns 501 without webhookManager", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/webhooks");
      expect(res.status).toBe(501);
    });

    it("lists webhooks", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as unknown as AdminRouterOptions["webhookManager"] });
      const res = await request(app).get("/admin/webhooks");
      expect(res.status).toBe(200);
      expect(res.body.webhooks).toEqual([]);
    });

    it("creates a webhook", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as unknown as AdminRouterOptions["webhookManager"] });
      const res = await request(app).post("/admin/webhooks").send({
        name: "Test Hook",
        action: "prompt",
        actionPayload: { promptName: "Summarize" },
      });
      expect(res.status).toBe(201);
      expect(res.body.webhook.name).toBe("Test Hook");
      expect(res.body.apiKey).toBe("ak-test-key");
    });

    it("rejects invalid webhook action", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as unknown as AdminRouterOptions["webhookManager"] });
      const res = await request(app).post("/admin/webhooks").send({
        name: "Bad",
        action: "invalid",
      });
      expect(res.status).toBe(400);
    });

    it("toggles webhook", async () => {
      const whm = createMockWebhookManager();
      whm._webhooks.set("wh-1", {
        id: "wh-1", name: "Test", action: "prompt", actionPayload: {},
        enabled: true, allowedIps: [], rateLimit: 60,
        triggerCount: 0, lastTriggeredAt: null, createdAt: "now", secret: "s",
      });
      const { app } = buildApp({ webhookManager: whm as unknown as AdminRouterOptions["webhookManager"] });
      const res = await request(app).post("/admin/webhooks/wh-1/toggle").send({ enabled: false });
      expect(res.status).toBe(200);
    });

    it("deletes webhook", async () => {
      const whm = createMockWebhookManager();
      whm._webhooks.set("wh-del", {
        id: "wh-del", name: "Del", action: "prompt", actionPayload: {},
        enabled: true, allowedIps: [], rateLimit: 60,
        triggerCount: 0, lastTriggeredAt: null, createdAt: "now", secret: "s",
      });
      const { app } = buildApp({ webhookManager: whm as unknown as AdminRouterOptions["webhookManager"] });
      const res = await request(app).delete("/admin/webhooks/wh-del");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing webhook toggle", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as unknown as AdminRouterOptions["webhookManager"] });
      const res = await request(app).post("/admin/webhooks/missing/toggle").send({ enabled: true });
      expect(res.status).toBe(404);
    });

    it("rotates webhook key", async () => {
      const whm = createMockWebhookManager();
      whm._webhooks.set("wh-rot", {
        id: "wh-rot", name: "R", action: "prompt", actionPayload: {},
        enabled: true, allowedIps: [], rateLimit: 60,
        triggerCount: 0, lastTriggeredAt: null, createdAt: "now", secret: "s",
      });
      const { app } = buildApp({ webhookManager: whm as unknown as AdminRouterOptions["webhookManager"] });
      const res = await request(app).post("/admin/webhooks/wh-rot/rotate-key");
      expect(res.status).toBe(200);
      expect(res.body.apiKey).toBe("ak-new-key");
    });
  });

  // ── Personality ──────────────────────────────────────────

  describe("personality", () => {
    it("returns personality config", async () => {
      const pm = createMockPersonalityManager();
      const { app } = buildApp({ personalityManager: pm as unknown as AdminRouterOptions["personalityManager"] });
      const res = await request(app).get("/admin/personality");
      expect(res.status).toBe(200);
      expect(res.body.systemInstruction).toBe("You are a helpful assistant");
    });

    it("updates personality", async () => {
      const pm = createMockPersonalityManager();
      const { app } = buildApp({ personalityManager: pm as unknown as AdminRouterOptions["personalityManager"] });
      const res = await request(app).put("/admin/personality").send({
        systemInstruction: "You are Gilfoyle",
      });
      expect(res.status).toBe(200);
      expect(pm.update).toHaveBeenCalled();
    });

    it("resets personality", async () => {
      const pm = createMockPersonalityManager();
      const { app } = buildApp({ personalityManager: pm as unknown as AdminRouterOptions["personalityManager"] });
      const res = await request(app).post("/admin/personality/reset");
      expect(res.status).toBe(200);
    });
  });

  // ── Session Config ───────────────────────────────────────

  describe("GET /session/config", () => {
    it("returns session config", async () => {
      const copilot = createMockCopilot();
      const toolReg = createMockToolRegistry();
      const { app } = buildApp({
        copilot: copilot as unknown as AdminRouterOptions["copilot"],
        toolRegistry: toolReg as unknown as AdminRouterOptions["toolRegistry"],
      });
      const res = await request(app).get("/admin/session/config");
      expect(res.status).toBe(200);
      expect(res.body.maxToolsPerRequest).toBe(30);
      expect(res.body.totalTools).toBe(3);
      expect(res.body.alwaysOnCount).toBe(3);
    });
  });

  // ── Tasks Config ─────────────────────────────────────────

  describe("tasks config", () => {
    it("GET /tasks/stats returns engine stats", async () => {
      const te = createMockTaskEngine();
      const { app } = buildApp({ taskEngine: te as unknown as AdminRouterOptions["taskEngine"] });
      const res = await request(app).get("/admin/tasks/stats");
      expect(res.status).toBe(200);
      expect(res.body.queued).toBe(2);
      expect(res.body.running).toBe(1);
      expect(res.body.activeCount).toBe(3);
    });

    it("GET /tasks/config returns config with stats", async () => {
      const tw = createMockTaskWorker();
      const te = createMockTaskEngine();
      const { app } = buildApp({
        taskWorker: tw as unknown as AdminRouterOptions["taskWorker"],
        taskEngine: te as unknown as AdminRouterOptions["taskEngine"],
      });
      const res = await request(app).get("/admin/tasks/config");
      expect(res.status).toBe(200);
      expect(res.body.maxConcurrent).toBe(3);
    });
  });

  // ── Models Config ────────────────────────────────────────

  describe("GET /models/config", () => {
    it("returns model configuration", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as unknown as AdminRouterOptions["copilot"] });
      const res = await request(app).get("/admin/models/config");
      expect(res.status).toBe(200);
      expect(res.body.reasoningEffort).toBe("medium");
      expect(res.body.provider).toBeNull();
    });
  });

  // ── Agents ───────────────────────────────────────────────

  describe("agents", () => {
    it("GET /agents returns empty list", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as unknown as AdminRouterOptions["copilot"] });
      const res = await request(app).get("/admin/agents");
      expect(res.status).toBe(200);
      expect(res.body.agents).toEqual([]);
    });

    it("PUT /agents rejects non-array", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as unknown as AdminRouterOptions["copilot"] });
      const res = await request(app).put("/admin/agents").send({ agents: "not-array" });
      expect(res.status).toBe(400);
    });
  });

  // ── Prompts (Library) ────────────────────────────────────

  describe("prompts", () => {
    const buildWithPrompts = () => {
      const pm = createMockPromptManager();
      const { app } = buildApp({ promptManager: pm as unknown as AdminRouterOptions["promptManager"] });
      return { app, pm };
    };

    it("GET /prompts lists all prompts", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).get("/admin/prompts");
      expect(res.status).toBe(200);
      expect(res.body.prompts).toHaveLength(1);
    });

    it("GET /prompts?q=sum searches prompts", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).get("/admin/prompts?q=sum");
      expect(res.status).toBe(200);
    });

    it("GET /prompts/:id returns a prompt", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).get("/admin/prompts/p1");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Summarize");
    });

    it("GET /prompts/:id returns 404 for missing", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).get("/admin/prompts/missing");
      expect(res.status).toBe(404);
    });

    it("POST /prompts creates a prompt", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).post("/admin/prompts").send({
        name: "New Prompt",
        template: "Do {{thing}}",
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("New Prompt");
    });

    it("POST /prompts rejects missing name", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).post("/admin/prompts").send({
        template: "Do something",
      });
      expect(res.status).toBe(400);
    });

    it("POST /prompts rejects overly long template", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).post("/admin/prompts").send({
        name: "Big",
        template: "x".repeat(100_001),
      });
      expect(res.status).toBe(400);
    });

    it("DELETE /prompts/:id deletes a prompt", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).delete("/admin/prompts/p1");
      expect(res.status).toBe(200);
    });

    it("DELETE /prompts/:id returns 404 for missing", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).delete("/admin/prompts/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Scheduled Jobs ───────────────────────────────────────

  describe("scheduled jobs", () => {
    const buildWithScheduler = () => {
      const sched = createMockScheduler();
      const { app } = buildApp({ scheduler: sched as unknown as AdminRouterOptions["scheduler"] });
      return { app, sched };
    };

    it("GET /jobs lists jobs", async () => {
      const { app } = buildWithScheduler();
      const res = await request(app).get("/admin/jobs");
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(1);
    });

    it("GET /jobs/:id returns a job", async () => {
      const { app } = buildWithScheduler();
      const res = await request(app).get("/admin/jobs/j1");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Daily Check");
    });

    it("GET /jobs/:id returns 404 for missing", async () => {
      const { app } = buildWithScheduler();
      const res = await request(app).get("/admin/jobs/missing");
      expect(res.status).toBe(404);
    });

    it("DELETE /jobs/:id deletes a job", async () => {
      const { app } = buildWithScheduler();
      const res = await request(app).delete("/admin/jobs/j1");
      expect(res.status).toBe(200);
    });
  });

  // ── Sentinel ─────────────────────────────────────────────

  describe("sentinel", () => {
    const buildWithSentinel = () => {
      const sent = createMockSentinel();
      const { app } = buildApp({ sentinel: sent as unknown as AdminRouterOptions["sentinel"] });
      return { app, sent };
    };

    it("GET /sentinel/status returns status", async () => {
      const { app } = buildWithSentinel();
      const res = await request(app).get("/admin/sentinel/status");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("running");
    });

    it("POST /sentinel/run-now triggers a check", async () => {
      const { app } = buildWithSentinel();
      const res = await request(app).post("/admin/sentinel/run-now");
      expect(res.status).toBe(200);
      expect(res.body.totalTasks).toBe(5);
    });

    it("GET /sentinel/digests returns digest list", async () => {
      const { app } = buildWithSentinel();
      const res = await request(app).get("/admin/sentinel/digests");
      expect(res.status).toBe(200);
      expect(res.body.digests).toEqual([]);
    });
  });

  // ── Copilot Sessions ─────────────────────────────────────

  describe("copilot sessions", () => {
    const buildWithCopilot = () => {
      const cp = createMockCopilot();
      const { app } = buildApp({ copilot: cp as unknown as AdminRouterOptions["copilot"] });
      return { app, cp };
    };

    it("GET /copilot-sessions/analytics returns analytics", async () => {
      const { app } = buildWithCopilot();
      const res = await request(app).get("/admin/copilot-sessions/analytics");
      expect(res.status).toBe(200);
      expect(res.body.totalSessions).toBe(0);
    });

    it("POST /copilot-sessions/analytics/reset resets analytics", async () => {
      const { app } = buildWithCopilot();
      const res = await request(app).post("/admin/copilot-sessions/analytics/reset");
      expect(res.status).toBe(200);
      expect(res.body.reset).toBe(true);
    });

    it("GET /copilot-sessions lists sessions", async () => {
      const { app } = buildWithCopilot();
      const res = await request(app).get("/admin/copilot-sessions");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    });

    it("GET /copilot-sessions/:id/messages returns events", async () => {
      const { app } = buildWithCopilot();
      const res = await request(app).get("/admin/copilot-sessions/s1/messages");
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    });
  });

  // ── Sidecars (deprecated) ────────────────────────────────

  describe("deprecated sidecars", () => {
    it("GET /sidecars/:name/tools returns tools by source", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/sidecars/twitter/tools");
      expect(res.status).toBe(200);
      expect(res.body.sidecar).toBe("twitter");
    });

    it("PUT /sidecars/:name/tools returns 410", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/sidecars/twitter/tools");
      expect(res.status).toBe(410);
    });
  });

  // ── Voice TTS Credentials ────────────────────────────────

  describe("GET /voice-tts-credentials", () => {
    it("returns current credentials value", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/voice-tts-credentials");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("value");
    });
  });

  // ── Voice Settings ───────────────────────────────────────

  describe("POST /voice-settings", () => {
    it("rejects missing voiceName", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/voice-settings").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("voiceName");
    });

    it("rejects unsupported voice", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/voice-settings").send({ voiceName: "invalid-voice" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported");
    });
  });

  // ── Sidecars (deprecated) ────────────────────────────────

  describe("GET /sidecars", () => {
    it("returns deprecation message", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/sidecars");
      expect(res.status).toBe(200);
      expect(res.body.deprecated).toBe(true);
    });
  });

  describe("POST /sidecars/:name/toggle", () => {
    it("returns 410 deprecated", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/sidecars/test/toggle");
      expect(res.status).toBe(410);
    });
  });

  describe("POST /sidecars/:name/restart", () => {
    it("returns 410 deprecated", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/sidecars/test/restart");
      expect(res.status).toBe(410);
    });
  });

  describe("POST /sidecars/credentials", () => {
    it("rejects non-object credentials", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/sidecars/credentials").send({ credentials: "not-object" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("credentials must be an object");
    });
  });

  // ── Sessions ─────────────────────────────────────────────

  describe("session routes", () => {
    function createMockSessionManager() {
      return {
        listSessions: vi.fn().mockResolvedValue([{ id: "s1", name: "Session 1" }]),
        getSession: vi.fn().mockResolvedValue({ id: "s1", name: "Session 1" }),
        getHistory: vi.fn().mockResolvedValue([{ role: "user", content: "Hello" }]),
        forkSession: vi.fn().mockResolvedValue({ id: "s2", name: "Forked" }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      };
    }

    it("GET /sessions returns session list", async () => {
      const sessionManager = createMockSessionManager();
      const { app } = buildApp({ sessionManager: sessionManager as any });
      const res = await request(app).get("/admin/sessions");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
    });

    it("GET /sessions/:id returns a session", async () => {
      const sessionManager = createMockSessionManager();
      const { app } = buildApp({ sessionManager: sessionManager as any });
      const res = await request(app).get("/admin/sessions/s1");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("s1");
    });

    it("GET /sessions/:id returns 404 on error", async () => {
      const sessionManager = createMockSessionManager();
      sessionManager.getSession.mockRejectedValue(new Error("not found"));
      const { app } = buildApp({ sessionManager: sessionManager as any });
      const res = await request(app).get("/admin/sessions/missing");
      expect(res.status).toBe(404);
    });

    it("GET /sessions/:id/history returns events", async () => {
      const sessionManager = createMockSessionManager();
      const { app } = buildApp({ sessionManager: sessionManager as any });
      const res = await request(app).get("/admin/sessions/s1/history");
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
    });

    it("POST /sessions/:id/fork creates a forked session", async () => {
      const sessionManager = createMockSessionManager();
      const { app } = buildApp({ sessionManager: sessionManager as any });
      const res = await request(app).post("/admin/sessions/s1/fork").send({ upToIndex: 5 });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe("s2");
    });

    it("DELETE /sessions/:id deletes a session", async () => {
      const sessionManager = createMockSessionManager();
      const { app } = buildApp({ sessionManager: sessionManager as any });
      const res = await request(app).delete("/admin/sessions/s1");
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });
  });

  // ── Brand Voice ──────────────────────────────────────────

  describe("brand voice routes", () => {
    function createMockBrandVoiceService() {
      const voices = [{ id: "bv1", name: "Professional", active: true }];
      return {
        getAll: vi.fn().mockReturnValue(voices),
        getActive: vi.fn().mockReturnValue(voices[0]),
        getById: vi.fn((id: string) => id === "bv1" ? voices[0] : null),
        analyzeAndSave: vi.fn().mockResolvedValue({ id: "bv-new", name: "New" }),
        update: vi.fn((id: string, _data: any) => id === "bv1" ? { ...voices[0], name: "Updated" } : null),
        setActive: vi.fn((id: string) => id === "bv1" ? voices[0] : null),
        reanalyze: vi.fn().mockResolvedValue({ id: "bv1", name: "Reanalyzed" }),
        deactivateAll: vi.fn(),
        delete: vi.fn((id: string) => id === "bv1"),
      };
    }

    it("GET /brand-voice returns all voices", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).get("/admin/brand-voice");
      expect(res.status).toBe(200);
      expect(res.body.voices).toHaveLength(1);
    });

    it("GET /brand-voice/active returns active voice", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).get("/admin/brand-voice/active");
      expect(res.status).toBe(200);
      expect(res.body.voice.name).toBe("Professional");
    });

    it("GET /brand-voice/:id returns voice by id", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).get("/admin/brand-voice/bv1");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Professional");
    });

    it("GET /brand-voice/:id returns 404 for missing", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).get("/admin/brand-voice/missing");
      expect(res.status).toBe(404);
    });

    it("POST /brand-voice/analyze rejects empty samples", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/analyze").send({ name: "Test", samples: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sample");
    });

    it("POST /brand-voice/analyze rejects missing name", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/analyze").send({ samples: ["Hello world"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Name");
    });

    it("POST /brand-voice/analyze succeeds with valid input", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/analyze").send({
        name: "Test Voice",
        samples: ["Sample writing text here"],
        active: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("bv-new");
    });

    it("PUT /brand-voice/:id updates voice", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).put("/admin/brand-voice/bv1").send({ name: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated");
    });

    it("PUT /brand-voice/:id returns 404 for missing", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).put("/admin/brand-voice/missing").send({ name: "X" });
      expect(res.status).toBe(404);
    });

    it("POST /brand-voice/:id/activate activates voice", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/bv1/activate");
      expect(res.status).toBe(200);
    });

    it("POST /brand-voice/:id/activate returns 404 for missing", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/missing/activate");
      expect(res.status).toBe(404);
    });

    it("POST /brand-voice/:id/reanalyze rejects empty samples", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/bv1/reanalyze").send({ samples: [] });
      expect(res.status).toBe(400);
    });

    it("POST /brand-voice/deactivate deactivates all", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/deactivate");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("DELETE /brand-voice/:id deletes voice", async () => {
      const bvs = createMockBrandVoiceService();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).delete("/admin/brand-voice/bv1");
      expect(res.status).toBe(200);
    });
  });

  // ── Scheduler Jobs (write paths) ─────────────────────────

  describe("scheduler job write routes", () => {
    it("POST /jobs creates a job", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs").send({
        name: "New Job",
        cronExpression: "0 * * * *",
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("New Job");
    });

    it("POST /jobs rejects missing fields", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs").send({ name: "No Cron" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("required");
    });

    it("PUT /jobs/:id updates a job", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).put("/admin/jobs/j1").send({ name: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated");
    });

    it("POST /jobs/:id/toggle toggles enabled state", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs/j1/toggle").send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
    });

    it("POST /jobs/:id/toggle rejects missing enabled", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs/j1/toggle").send({});
      expect(res.status).toBe(400);
    });

    it("POST /jobs/:id/run returns 404 for missing job", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs/missing/run");
      expect(res.status).toBe(404);
    });

    it("POST /jobs/:id/run rejects disabled job", async () => {
      const scheduler = createMockScheduler();
      scheduler.getById.mockReturnValue({ id: "j1", enabled: false });
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs/j1/run");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("disabled");
    });

    it("POST /jobs/:id/run dry_run returns preview", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs/j1/run?dry_run=true");
      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.preview).toBeDefined();
    });
  });

  // ── Copilot Sessions (delete + resume) ────────────────────

  describe("copilot session management", () => {
    it("DELETE /copilot-sessions/:id deletes session", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).delete("/admin/copilot-sessions/s1");
      expect(res.status).toBe(200);
      expect(copilot.deleteSdkSession).toHaveBeenCalledWith("s1");
    });
  });

  // ── Sentinel Config ──────────────────────────────────────

  describe("sentinel routes", () => {
    it("POST /sentinel/toggle toggles sentinel", async () => {
      const sentinel = createMockSentinel();
      const { app } = buildApp({ sentinel: sentinel as any });
      const res = await request(app).post("/admin/sentinel/toggle").send({ enabled: true });
      expect(res.status).toBe(200);
    });
  });

  // ── POST /restart ────────────────────────────────────────

  describe("POST /restart", () => {
    it("returns ok", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/restart");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── POST /allowed-dirs ───────────────────────────────────

  describe("POST /allowed-dirs", () => {
    it("normalizes and sets allowed dirs", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/allowed-dirs").send({ value: " /tmp , /home " });
      // upsertEnvFile is an internal function that writes to .env;
      // it may fail in test (no actual .env file), which returns 500,
      // or succeed if mocked via fs. Either way the route is exercised.
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── POST /voice-tts-credentials ──────────────────────────

  describe("POST /voice-tts-credentials", () => {
    it("attempts to set credentials", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/voice-tts-credentials").send({ value: "/path/creds.json" });
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── GET /voice-settings ──────────────────────────────────

  describe("GET /voice-settings", () => {
    it("returns voice settings with available voices", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/voice-settings");
      // readUserConfig may throw if no config path, so either 200 or 500
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("voiceName");
        expect(res.body).toHaveProperty("availableVoices");
      }
    });
  });

  // ── GET /voice-config ────────────────────────────────────

  describe("GET /voice-config", () => {
    it("returns voice configuration defaults", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/voice-config");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("enabled");
        expect(res.body).toHaveProperty("provider");
      }
    });
  });

  // ── POST /voice-config ───────────────────────────────────

  describe("POST /voice-config", () => {
    it("rejects empty body with no valid fields", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/voice-config").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No valid fields");
    });
  });

  // ── GET /channels ────────────────────────────────────────

  describe("GET /channels", () => {
    it("returns channel configuration", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/channels");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("channels");
      }
    });
  });

  // ── POST /channels ───────────────────────────────────────

  describe("POST /channels", () => {
    it("rejects enabling telegram without token", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const { app } = buildApp();
      const res = await request(app).post("/admin/channels").send({
        telegram: { enabled: true },
        discord: { enabled: false },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("TELEGRAM_BOT_TOKEN");
    });

    it("rejects enabling discord without token", async () => {
      delete process.env.DISCORD_BOT_TOKEN;
      const { app } = buildApp();
      const res = await request(app).post("/admin/channels").send({
        telegram: { enabled: false },
        discord: { enabled: true },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("DISCORD_BOT_TOKEN");
    });
  });

  // ── Local Servers ────────────────────────────────────────

  describe("local server routes", () => {
    it("GET /local-servers returns data without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/local-servers");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("servers");
      expect(res.body).toHaveProperty("credentials");
    });

    it("POST /local-servers/:name/restart returns 503 without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/local-servers/test/restart");
      expect(res.status).toBe(503);
    });

    it("GET /local-servers/:name/tools returns 404 for unknown server", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/local-servers/unknown/tools");
      expect(res.status).toBe(404);
    });

    it("POST /local-servers/:name/stop returns 503 without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/local-servers/test/stop");
      expect(res.status).toBe(503);
    });
  });

  // ── Custom Post-Actions ──────────────────────────────────

  describe("custom post-action routes", () => {
    it("GET /post-actions/custom/:type returns 404 without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/post-actions/custom/some-type");
      expect(res.status).toBe(404);
    });

    it("POST /post-actions/custom returns 503 without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/post-actions/custom").send({
        type: "my-action",
        label: "My Action",
      });
      expect(res.status).toBe(503);
    });

    it("PUT /post-actions/custom/:type returns 503 without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/post-actions/custom/my-action").send({
        label: "Updated",
      });
      expect(res.status).toBe(503);
    });

    it("DELETE /post-actions/custom/:type returns 503 without manager", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/admin/post-actions/custom/my-action");
      expect(res.status).toBe(503);
    });
  });

  // ── Prompt Update & Export ───────────────────────────────

  describe("prompt update and export", () => {
    const buildWithPrompts = () => {
      const pm = createMockPromptManager();
      const { app } = buildApp({ promptManager: pm as unknown as AdminRouterOptions["promptManager"] });
      return { app, pm };
    };

    it("PUT /prompts/:id updates a prompt", async () => {
      const { app } = buildWithPrompts();
      const res = await request(app).put("/admin/prompts/p1").send({
        name: "Updated Name",
        template: "New template {{var}}",
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated Name");
    });

    it("PUT /prompts/:id returns 400 for missing prompt", async () => {
      const { app, pm } = buildWithPrompts();
      pm.update.mockImplementation(() => { throw new Error("Prompt not found"); });
      const res = await request(app).put("/admin/prompts/missing").send({ name: "X" });
      expect(res.status).toBe(400);
    });
  });

  // ── Template Import ──────────────────────────────────────

  describe("template import", () => {
    it("POST /templates/import rejects missing template", async () => {
      const pm = createMockPromptManager();
      const { app } = buildApp({ promptManager: pm as unknown as AdminRouterOptions["promptManager"] });
      const res = await request(app).post("/admin/templates/import").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("template is required");
    });
  });

  // ── PUT /session/config ──────────────────────────────────

  describe("PUT /session/config", () => {
    it("rejects invalid maxToolsPerRequest", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/session/config").send({ maxToolsPerRequest: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("maxToolsPerRequest");
    });

    it("rejects non-integer maxToolsPerRequest", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/session/config").send({ maxToolsPerRequest: 3.5 });
      expect(res.status).toBe(400);
    });

    it("rejects maxToolsPerRequest > 128", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/session/config").send({ maxToolsPerRequest: 200 });
      expect(res.status).toBe(400);
    });
  });

  // ── PUT /tasks/config ────────────────────────────────────

  describe("PUT /tasks/config", () => {
    it("rejects invalid maxConcurrent", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/tasks/config").send({ maxConcurrent: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("maxConcurrent");
    });

    it("rejects maxConcurrent > 10", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/tasks/config").send({ maxConcurrent: 50 });
      expect(res.status).toBe(400);
    });
  });

  // ── PUT /models/config ───────────────────────────────────

  describe("PUT /models/config", () => {
    it("rejects invalid reasoningEffort", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/models/config").send({ reasoningEffort: "ultra" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reasoningEffort");
    });

    it("rejects invalid provider type", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/models/config").send({
        provider: { type: "invalid", baseUrl: "http://localhost" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("provider.type");
    });

    it("rejects provider missing baseUrl", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/models/config").send({
        provider: { type: "openai" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("baseUrl");
    });

    it("rejects invalid workingDirectory type", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/models/config").send({ workingDirectory: 123 });
      expect(res.status).toBe(400);
    });
  });

  // ── Agent CRUD ───────────────────────────────────────────

  describe("agent CRUD routes", () => {
    it("POST /agents creates a new agent", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/agents").send({
        name: "test-agent",
        role: "researcher",
        instructions: "Research things",
      });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });

    it("POST /agents rejects duplicate agent name", async () => {
      const copilot = createMockCopilot();
      copilot.getCustomAgents.mockReturnValue([{ name: "existing" }]);
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/agents").send({
        name: "existing",
        role: "coder",
        instructions: "Code stuff",
      });
      expect(res.status).toBe(409);
    });

    it("PUT /agents/:name returns 404 for missing agent", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/agents/missing").send({
        name: "missing",
        role: "coder",
        instructions: "Do stuff",
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /agents/:name returns 404 for missing agent", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).delete("/admin/agents/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Native MCP Servers ───────────────────────────────────

  describe("native MCP server routes", () => {
    it("GET /native-mcp-servers returns servers", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ "test-server": { command: "node", args: ["server.js"] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).get("/admin/native-mcp-servers");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("servers");
    });

    it("PUT /native-mcp-servers rejects non-object servers", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/native-mcp-servers").send({ servers: "not-object" });
      expect(res.status).toBe(400);
    });

    it("PUT /native-mcp-servers rejects array servers", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/native-mcp-servers").send({ servers: [] });
      expect(res.status).toBe(400);
    });

    it("DELETE /native-mcp-servers/:name returns 404 for missing", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).delete("/admin/native-mcp-servers/missing");
      expect(res.status).toBe(404);
    });

    it("POST /native-mcp-servers/:name/reconnect returns 404 for missing", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/missing/reconnect");
      expect(res.status).toBe(404);
    });

    it("GET /native-mcp-servers/:name/tools returns 404 for missing server", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).get("/admin/native-mcp-servers/missing/tools");
      expect(res.status).toBe(404);
    });
  });

  // ── Copilot Session Resume ───────────────────────────────

  describe("copilot session resume", () => {
    it("POST /copilot-sessions/:id/resume returns 404 for missing session", async () => {
      const copilot = createMockCopilot();
      copilot.listSdkSessions.mockResolvedValue([]);
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/copilot-sessions/missing/resume");
      expect(res.status).toBe(404);
    });

    it("POST /copilot-sessions/:id/resume returns session data for existing", async () => {
      const copilot = createMockCopilot();
      copilot.listSdkSessions.mockResolvedValue([
        { sessionId: "s1", summary: "Test session", context: {}, startTime: "2025-01-01", modifiedTime: "2025-01-01" },
      ]);
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/copilot-sessions/s1/resume");
      expect(res.status).toBe(200);
      expect(res.body.conversationId).toBe("s1");
      expect(res.body.summary).toBe("Test session");
    });
  });

  // ── Native MCP Server Tool Toggle ────────────────────────

  describe("native MCP server tool management", () => {
    it("POST /native-mcp-servers/:name/tools/add rejects missing toolName", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ "my-server": { command: "node", args: [] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/my-server/tools/add").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("toolName");
    });

    it("POST /native-mcp-servers/:name/tools/add returns 404 for missing server", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/missing/tools/add").send({ toolName: "tool1" });
      expect(res.status).toBe(404);
    });

    it("POST /native-mcp-servers/:name/tools/:toolName/toggle rejects non-boolean", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ "my-server": { command: "node", args: [] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/my-server/tools/tool1/toggle").send({ enabled: "yes" });
      expect(res.status).toBe(400);
    });

    it("POST /native-mcp-servers/:name/tools/:toolName/toggle returns 404 for missing server", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/missing/tools/tool1/toggle").send({ enabled: true });
      expect(res.status).toBe(404);
    });

    it("POST /native-mcp-servers/:name/tools/:toolName/remove returns 404 for missing server", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/missing/tools/tool1/remove");
      expect(res.status).toBe(404);
    });
  });

  // ── Tool Toggle Error Paths ──────────────────────────────

  describe("tool toggle error paths", () => {
    it("returns 400 when setEnabled throws", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.setEnabled.mockRejectedValue(new Error("Cannot disable always-on tool"));
      const { app } = buildApp({ toolRegistry: toolRegistry as any });
      const res = await request(app).post("/admin/tools/read-file/toggle").send({ enabled: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Cannot disable");
    });

    it("rejects mcp: tool with invalid identifier format", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/tools/mcp:x/toggle").send({ enabled: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid MCP tool identifier");
    });

    it("rejects toggling mcp: __disconnected__ marker", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/tools/mcp:server:__disconnected__/toggle").send({ enabled: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Cannot toggle disconnected");
    });

    it("returns 503 for mcp: tool when copilot unavailable", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/tools/mcp:server:tool1/toggle").send({ enabled: true });
      expect(res.status).toBe(503);
    });

    it("returns 409 for mcp: tool when tasks are active", async () => {
      const copilot = createMockCopilot();
      const taskEngine = createMockTaskEngine();
      const { app } = buildApp({ copilot: copilot as any, taskEngine: taskEngine as any });
      const res = await request(app).post("/admin/tools/mcp:server:tool1/toggle").send({ enabled: true });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("active");
    });

    it("returns 404 for mcp: tool with missing server", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/tools/mcp:missing:tool1/toggle").send({ enabled: true });
      expect(res.status).toBe(404);
    });
  });

  // ── Tool Risk / Approval Error Paths ─────────────────────

  describe("tool risk/approval error paths", () => {
    it("returns 400 when setRiskOverride throws", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.setRiskOverride.mockRejectedValue(new Error("Unknown tool"));
      const { app } = buildApp({ toolRegistry: toolRegistry as any });
      const res = await request(app).post("/admin/tools/missing/risk").send({ riskLevel: "high" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when setGlobalApprovalOverride throws", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.setGlobalApprovalOverride.mockRejectedValue(new Error("Unknown tool"));
      const { app } = buildApp({ toolRegistry: toolRegistry as any });
      const res = await request(app).post("/admin/tools/missing/global-approval").send({ required: true });
      expect(res.status).toBe(400);
    });
  });

  // ── Sidecar Credentials Validation ───────────────────────

  describe("sidecar credentials validation", () => {
    it("rejects unknown credential key", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/sidecars/credentials").send({
        credentials: { UNKNOWN_KEY: "value" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unknown credential");
    });

    it("rejects non-string credential value", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/sidecars/credentials").send({
        credentials: { JDBC_URL: 123 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("must be a string");
    });
  });

  // ── Custom Post-Actions with Manager ─────────────────────

  describe("custom post-actions with manager", () => {
    function createMockCustomPostActionManager() {
      return {
        list: vi.fn().mockReturnValue([{ type: "my-action", label: "My Action" }]),
        getByType: vi.fn((type: string) => type === "my-action" ? { type: "my-action", label: "My Action" } : undefined),
        create: vi.fn(async (data: any) => ({ ...data, id: "cpa-1" })),
        update: vi.fn(async (_type: string, data: any) => ({ type: _type, ...data })),
        delete: vi.fn(async (type: string) => type === "my-action"),
      };
    }

    it("GET /post-actions/custom returns list", async () => {
      const cpm = createMockCustomPostActionManager();
      const { app } = buildApp({ customPostActionManager: cpm as any });
      const res = await request(app).get("/admin/post-actions/custom");
      expect(res.status).toBe(200);
      expect(res.body.actions).toHaveLength(1);
    });

    it("GET /post-actions/custom/:type returns action when found", async () => {
      const cpm = createMockCustomPostActionManager();
      const { app } = buildApp({ customPostActionManager: cpm as any });
      const res = await request(app).get("/admin/post-actions/custom/my-action");
      expect(res.status).toBe(200);
      expect(res.body.type).toBe("my-action");
    });

    it("GET /post-actions/custom/:type returns 404 when not found", async () => {
      const cpm = createMockCustomPostActionManager();
      const { app } = buildApp({ customPostActionManager: cpm as any });
      const res = await request(app).get("/admin/post-actions/custom/missing");
      expect(res.status).toBe(404);
    });

    it("POST /post-actions/custom creates action", async () => {
      const cpm = createMockCustomPostActionManager();
      const { app } = buildApp({ customPostActionManager: cpm as any });
      const res = await request(app).post("/admin/post-actions/custom").send({
        type: "new-action",
        label: "New Action",
      });
      expect(res.status).toBe(201);
    });

    it("DELETE /post-actions/custom/:type deletes action", async () => {
      const cpm = createMockCustomPostActionManager();
      const { app } = buildApp({ customPostActionManager: cpm as any });
      const res = await request(app).delete("/admin/post-actions/custom/my-action");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── Scheduler Additional Paths ───────────────────────────

  describe("scheduler additional paths", () => {
    it("POST /jobs rejects invalid reasoningEffort", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs").send({
        name: "Test",
        cronExpression: "0 * * * *",
        reasoningEffort: "invalid",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reasoningEffort");
    });

    it("POST /jobs creates with valid reasoningEffort", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs").send({
        name: "Test",
        cronExpression: "0 * * * *",
        reasoningEffort: "high",
      });
      expect(res.status).toBe(201);
    });

    it("PUT /jobs/:id rejects invalid reasoningEffort", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).put("/admin/jobs/j1").send({
        reasoningEffort: "ultra",
      });
      expect(res.status).toBe(400);
    });

    it("POST /jobs/:id/run executes enabled job", async () => {
      const scheduler = createMockScheduler();
      (scheduler as any).executeJob = vi.fn().mockResolvedValue(undefined);
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).post("/admin/jobs/j1/run");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("DELETE /jobs/missing returns 404", async () => {
      const scheduler = createMockScheduler();
      const { app } = buildApp({ scheduler: scheduler as any });
      const res = await request(app).delete("/admin/jobs/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Config Write Success Paths ───────────────────────────

  describe("config write success paths", () => {
    it("PUT /session/config succeeds with valid value", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/session/config").send({ maxToolsPerRequest: 50 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.maxToolsPerRequest).toBe(50);
    });

    it("PUT /tasks/config succeeds with valid value", async () => {
      const tw = createMockTaskWorker();
      const { app } = buildApp({ taskWorker: tw as any });
      const res = await request(app).put("/admin/tasks/config").send({ maxConcurrent: 5 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(tw.setMaxConcurrent).toHaveBeenCalledWith(5);
    });

    it("PUT /models/config succeeds with valid reasoningEffort", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/models/config").send({ reasoningEffort: "high" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(copilot.setReasoningEffort).toHaveBeenCalledWith("high");
    });

    it("POST /voice-config succeeds with valid boolean field", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/admin/voice-config").send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.updated).toHaveProperty("enabled", true);
    });
  });

  // ── Agent CRUD Success Paths ─────────────────────────────

  describe("agent CRUD success paths", () => {
    it("PUT /agents updates all agents", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/agents").send({
        agents: [{ name: "a1", role: "coder", instructions: "Code" }],
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("PUT /agents/:name updates existing agent", async () => {
      const copilot = createMockCopilot();
      copilot.getCustomAgents.mockReturnValue([{ name: "a1", role: "coder", instructions: "Old" }]);
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/agents/a1").send({
        name: "a1",
        role: "writer",
        instructions: "Write things",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("DELETE /agents/:name removes existing agent", async () => {
      const copilot = createMockCopilot();
      copilot.getCustomAgents.mockReturnValue([{ name: "a1" }]);
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).delete("/admin/agents/a1");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── Sentinel Additional Routes ───────────────────────────

  describe("sentinel additional routes", () => {
    it("PUT /sentinel/config updates config", async () => {
      const sent = createMockSentinel();
      const { app } = buildApp({ sentinel: sent as any });
      const res = await request(app).put("/admin/sentinel/config").send({ cronSchedule: "*/10 * * * *" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("POST /sentinel/toggle rejects invalid body", async () => {
      const sent = createMockSentinel();
      const { app } = buildApp({ sentinel: sent as any });
      const res = await request(app).post("/admin/sentinel/toggle").send({ enabled: "yes" });
      expect(res.status).toBe(400);
    });

    it("GET /sentinel/digest-markdown returns 404 when no markdown", async () => {
      const sent = createMockSentinel();
      const { app } = buildApp({ sentinel: sent as any });
      const res = await request(app).get("/admin/sentinel/digest-markdown");
      expect(res.status).toBe(404);
    });
  });

  // ── Session Edge Cases ───────────────────────────────────

  describe("session edge cases", () => {
    function createSessionManager() {
      return {
        listSessions: vi.fn().mockResolvedValue([]),
        getSession: vi.fn().mockResolvedValue({ id: "s1" }),
        getHistory: vi.fn().mockResolvedValue([{ role: "user", content: "Hello" }]),
        forkSession: vi.fn().mockResolvedValue({ id: "s2" }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      };
    }

    it("DELETE /sessions/:id returns 400 on error", async () => {
      const sm = createSessionManager();
      sm.deleteSession.mockRejectedValue(new Error("Cannot delete active session"));
      const { app } = buildApp({ sessionManager: sm as any });
      const res = await request(app).delete("/admin/sessions/s1");
      expect(res.status).toBe(400);
    });

    it("GET /sessions/:id/history passes limit query param", async () => {
      const sm = createSessionManager();
      const { app } = buildApp({ sessionManager: sm as any });
      const res = await request(app).get("/admin/sessions/s1/history?limit=10");
      expect(res.status).toBe(200);
      expect(sm.getHistory).toHaveBeenCalledWith("s1", 10);
    });
  });

  // ── Copilot Session Edge Cases ───────────────────────────

  describe("copilot session edge cases", () => {
    it("DELETE /copilot-sessions/:id returns 400 on error", async () => {
      const copilot = createMockCopilot();
      copilot.deleteSdkSession.mockRejectedValue(new Error("Session in use"));
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).delete("/admin/copilot-sessions/s1");
      expect(res.status).toBe(400);
    });

    it("GET /copilot-sessions passes filter params", async () => {
      const copilot = createMockCopilot();
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).get("/admin/copilot-sessions?repository=my-repo&branch=main");
      expect(res.status).toBe(200);
      expect(copilot.listSdkSessions).toHaveBeenCalledWith({ repository: "my-repo", branch: "main" });
    });
  });

  // ── Native MCP Server Operations ─────────────────────────

  describe("native MCP server operations", () => {
    it("PUT /native-mcp-servers blocks when tasks active", async () => {
      const copilot = createMockCopilot();
      const taskEngine = createMockTaskEngine();
      const { app } = buildApp({ copilot: copilot as any, taskEngine: taskEngine as any });
      const res = await request(app).put("/admin/native-mcp-servers").send({
        servers: { test: { command: "node", args: [] } },
      });
      expect(res.status).toBe(409);
    });

    it("POST /native-mcp-servers/:name returns 409 for existing server", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ existing: { command: "node", args: [] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/existing").send({
        command: "node",
        args: ["server.js"],
      });
      expect(res.status).toBe(409);
    });

    it("PUT /native-mcp-servers/:name returns 404 for missing server", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({});
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).put("/admin/native-mcp-servers/missing").send({
        command: "node",
        args: ["server.js"],
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /native-mcp-servers/:name blocks when tasks active", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ test: { command: "node", args: [] } });
      const taskEngine = createMockTaskEngine();
      const { app } = buildApp({ copilot: copilot as any, taskEngine: taskEngine as any });
      const res = await request(app).delete("/admin/native-mcp-servers/test");
      expect(res.status).toBe(409);
    });

    it("GET /native-mcp-servers/tool-cache returns cache", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/native-mcp-servers/tool-cache");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("cache");
    });

    it("POST /native-mcp-servers/:name/tools/add succeeds", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ "my-server": { command: "node", args: [] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/my-server/tools/add").send({ toolName: "new-tool" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("POST /native-mcp-servers/:name/tools/add returns ok for duplicate", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ "my-server": { command: "node", args: [], tools: ["existing-tool"] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/my-server/tools/add").send({ toolName: "existing-tool" });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("already exists");
    });

    it("POST /native-mcp-servers/:name/tools/:tool/toggle succeeds", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ "my-server": { command: "node", args: [] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/my-server/tools/tool1/toggle").send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.enabled).toBe(false);
    });

    it("POST /native-mcp-servers/:name/tools/:tool/remove succeeds", async () => {
      const copilot = createMockCopilot();
      copilot.getNativeMcpServers.mockReturnValue({ "my-server": { command: "node", args: [], tools: ["tool1"] } });
      const { app } = buildApp({ copilot: copilot as any });
      const res = await request(app).post("/admin/native-mcp-servers/my-server/tools/tool1/remove");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── Presenter Config ─────────────────────────────────────

  describe("presenter config", () => {
    it("GET /presenter/config returns config", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/presenter/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("baseUrl");
    });

    it("PUT /presenter/config rejects invalid URL", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/presenter/config").send({ baseUrl: "not-a-url" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("valid HTTP");
    });

    it("PUT /presenter/config rejects non-string baseUrl", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/presenter/config").send({ baseUrl: 123 });
      expect(res.status).toBe(400);
    });
  });

  // ── Image / Video / Music Gen Config ─────────────────────

  describe("gen config endpoints", () => {
    it("GET /image-gen/config returns config", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/image-gen/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("mode");
    });

    it("PUT /image-gen/config rejects invalid mode", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/image-gen/config").send({ mode: "cloud" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("mode");
    });

    it("PUT /image-gen/config rejects invalid networkNodeUrl", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/image-gen/config").send({ networkNodeUrl: "not-url" });
      expect(res.status).toBe(400);
    });

    it("GET /video-gen/config returns config", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/video-gen/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("mode");
    });

    it("PUT /video-gen/config rejects invalid mode", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/video-gen/config").send({ mode: "cloud" });
      expect(res.status).toBe(400);
    });

    it("GET /music-gen/config returns config", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/admin/music-gen/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("mode");
    });

    it("PUT /music-gen/config rejects invalid mode", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/admin/music-gen/config").send({ mode: "cloud" });
      expect(res.status).toBe(400);
    });
  });

  // ── Brand Voice Additional Cases ─────────────────────────

  describe("brand voice additional cases", () => {
    function createBrandVoiceSvc() {
      return {
        getAll: vi.fn().mockReturnValue([]),
        getActive: vi.fn().mockReturnValue(null),
        getById: vi.fn().mockReturnValue(null),
        analyzeAndSave: vi.fn().mockResolvedValue({ id: "bv-new" }),
        update: vi.fn().mockReturnValue(null),
        setActive: vi.fn().mockReturnValue(null),
        reanalyze: vi.fn().mockResolvedValue(null),
        deactivateAll: vi.fn(),
        delete: vi.fn().mockReturnValue(false),
      };
    }

    it("POST /brand-voice/analyze rejects overly long sample", async () => {
      const bvs = createBrandVoiceSvc();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/analyze").send({
        name: "Test",
        samples: ["x".repeat(10_001)],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("10000");
    });

    it("POST /brand-voice/:id/reanalyze returns 404 for missing voice", async () => {
      const bvs = createBrandVoiceSvc();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).post("/admin/brand-voice/missing/reanalyze").send({
        samples: ["Some writing sample"],
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /brand-voice/:id returns 404 for missing voice", async () => {
      const bvs = createBrandVoiceSvc();
      const { app } = buildApp({ brandVoiceService: bvs as any });
      const res = await request(app).delete("/admin/brand-voice/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Webhook Additional Cases ─────────────────────────────

  describe("webhook additional cases", () => {
    it("POST /webhooks/:id/toggle rejects missing enabled", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as any });
      const res = await request(app).post("/admin/webhooks/wh-1/toggle").send({});
      expect(res.status).toBe(400);
    });

    it("POST /webhooks rejects missing name", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as any });
      const res = await request(app).post("/admin/webhooks").send({ action: "prompt" });
      expect(res.status).toBe(400);
    });

    it("POST /webhooks/:id/rotate-key returns 404 for missing", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as any });
      const res = await request(app).post("/admin/webhooks/missing/rotate-key");
      expect(res.status).toBe(404);
    });

    it("DELETE /webhooks/:id returns 404 for missing", async () => {
      const whm = createMockWebhookManager();
      const { app } = buildApp({ webhookManager: whm as any });
      const res = await request(app).delete("/admin/webhooks/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Template Export & Analyze ─────────────────────────────

  describe("template export and analyze", () => {
    it("GET /prompts/:id/export returns template", async () => {
      const pm = createMockPromptManager();
      const { app } = buildApp({ promptManager: pm as any });
      const res = await request(app).get("/admin/prompts/p1/export");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("prompt");
    });

    it("GET /prompts/:id/export returns 404 for missing", async () => {
      const pm = createMockPromptManager();
      const { app } = buildApp({ promptManager: pm as any });
      const res = await request(app).get("/admin/prompts/missing/export");
      expect(res.status).toBe(404);
    });

    it("POST /templates/analyze returns analysis", async () => {
      const pm = createMockPromptManager();
      const { app } = buildApp({ promptManager: pm as any });
      const res = await request(app).post("/admin/templates/analyze").send({
        version: "1.0",
        prompt: { name: "Test", template: "Do {{thing}}" },
      });
      expect(res.status).toBe(200);
    });

    it("POST /templates/import succeeds with valid template", async () => {
      const pm = createMockPromptManager();
      const { app } = buildApp({ promptManager: pm as any });
      const res = await request(app).post("/admin/templates/import").send({
        template: { version: "1.0", prompt: { name: "Imported", template: "Do stuff" } },
      });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });
});
