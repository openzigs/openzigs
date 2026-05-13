import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";

vi.mock("../config/platform.js", () => ({
  getPlatformCapabilities: vi.fn(),
}));

import { createAdminRouter } from "./admin.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import { getPlatformCapabilities } from "../config/platform.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type {
  CopilotModel,
  ReasoningEffort,
  ProviderConfig,
  CustomAgentDefinition,
  NativeMcpServerDefinition,
} from "../copilot/copilot-wrapper.js";

const mockedGetPlatformCapabilities =
  getPlatformCapabilities as unknown as ReturnType<typeof vi.fn>;

class FakeCopilot implements CopilotWrapper {
  private maxTools = 30;
  async authenticate() {
    return { verificationUri: "", userCode: "" };
  }
  async waitForAuth(): Promise<void> {}
  async isAuthenticated(): Promise<boolean> {
    return true;
  }
  async *chat(): AsyncGenerator<string> {
    yield "hi";
  }
  async listModels(): Promise<CopilotModel[]> {
    return [{ id: "gpt-4.1" }];
  }
  async onToolCall(): Promise<void> {}
  setMaxToolsPerRequest(n: number): void {
    this.maxTools = n;
  }
  getMaxToolsPerRequest(): number {
    return this.maxTools;
  }
  async destroySession(): Promise<void> {}
  hasSession(): boolean {
    return false;
  }
  async clearAllSessions(): Promise<void> {}
  getReasoningEffort(): ReasoningEffort | undefined {
    return undefined;
  }
  setReasoningEffort(_effort: ReasoningEffort | undefined): void {}
  modelSupportsReasoning(): boolean {
    return false;
  }
  getProvider(): ProviderConfig | undefined {
    return undefined;
  }
  setProvider(_provider: ProviderConfig | undefined): void {}
  getWorkingDirectory(): string | undefined {
    return undefined;
  }
  setWorkingDirectory(_dir: string | undefined): void {}
  getCustomAgents(): CustomAgentDefinition[] {
    return [];
  }
  setCustomAgents(_agents: CustomAgentDefinition[]): void {}
  getNativeMcpServers(): Record<string, NativeMcpServerDefinition> {
    return {};
  }
  setNativeMcpServers(
    _servers: Record<string, NativeMcpServerDefinition>,
  ): void {}
  getSessionUsage() {
    return null;
  }
  clearSessionUsage() {
    return null;
  }
  async listSdkSessions() {
    return [];
  }
  async getSdkSessionMessages() {
    return [];
  }
  async deleteSdkSession() {}
  getSessionAnalytics() {
    return {
      sessionsCreated: 0,
      sessionsResumed: 0,
      sessionsDestroyed: 0,
      compactionCount: 0,
      lifecycleEvents: [] as never[],
      lastUpdated: "",
    };
  }
  resetSessionAnalytics() {}
}

describe("GET /api/admin/capabilities — error response shape", () => {
  const cleanupDirs: string[] = [];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
    delete process.env.M2_PRO_WORKER_URL;
    delete process.env.M2_PRO_WORKER_TOKEN;
    await Promise.all(
      cleanupDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  const createApp = async (videoGen?: Record<string, unknown>) => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openzigs-admin-caps-"),
    );
    cleanupDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "config.json");
    if (videoGen) {
      await fs.writeFile(configPath, JSON.stringify({ videoGen }, null, 2));
    }
    process.env.OPENZIGS_CONFIG_PATH = configPath;

    const toolRegistry = new ToolRegistry({
      statePath: path.join(tmpDir, "tools.json"),
    });
    const router = createAdminRouter({
      toolRegistry,
      copilot: new FakeCopilot(),
    });
    const app = express();
    app.use(express.json());
    app.use("/api/admin", router);
    return app;
  };

  const platform = (overrides: { isMacOS: boolean }) => {
    mockedGetPlatformCapabilities.mockReturnValue({
      os: overrides.isMacOS ? "darwin" : "linux",
      arch: overrides.isMacOS ? "arm64" : "x64",
      dockerAvailable: false,
      sidecarsSupported: overrides.isMacOS,
      chromePath: undefined,
      isWindows: false,
      isMacOS: overrides.isMacOS,
      isLinux: !overrides.isMacOS,
    });
  };

  it("returns isMacLocal=true with hint and url when on macOS in local mode and upstream fails", async () => {
    platform({ isMacOS: true });
    const app = await createApp();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));

    const res = await request(app).get("/api/admin/capabilities");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      mode: "local",
      isMacLocal: true,
      url: expect.stringContaining("localhost:5007"),
    });
    expect(typeof res.body.hint).toBe("string");
    expect(res.body.hint.length).toBeGreaterThan(0);
    expect(res.body.error).toContain("404");
  });

  it("returns isMacLocal=false on macOS when in network mode (user already configured remote node)", async () => {
    platform({ isMacOS: true });
    const app = await createApp({
      mode: "network",
      networkNodeUrl: "http://10.0.0.42:5007",
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 502 }));

    const res = await request(app).get("/api/admin/capabilities");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      mode: "network",
      isMacLocal: false,
      url: "http://10.0.0.42:5007",
    });
    expect(res.body.hint).toBeUndefined();
  });

  it("returns isMacLocal=false on Linux/Windows in local mode", async () => {
    platform({ isMacOS: false });
    const app = await createApp();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5007"));

    const res = await request(app).get("/api/admin/capabilities");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      mode: "local",
      isMacLocal: false,
    });
    expect(res.body.hint).toBeUndefined();
  });

  it("200 success path forwards worker payload unchanged", async () => {
    platform({ isMacOS: true });
    const app = await createApp();
    const payload = {
      cuda_available: false,
      device_count: 0,
      pooled_vram_gb: 0,
      max_frames: { "ltxv-2-22b-distilled": 257 },
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );

    const res = await request(app).get("/api/admin/capabilities");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });
});
