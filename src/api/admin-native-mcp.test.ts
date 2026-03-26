import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { createAdminRouter } from "./admin.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { CopilotModel, ReasoningEffort, ProviderConfig, CustomAgentDefinition, NativeMcpServerDefinition } from "../copilot/copilot-wrapper.js";
import type { NativeMcpTester } from "../mcp/native-mcp-test-service.js";

class FakeCopilot implements CopilotWrapper {
  private maxTools = 30;
  private nativeServers: Record<string, NativeMcpServerDefinition> = {};

  async authenticate() { return { verificationUri: "", userCode: "" }; }
  async waitForAuth(): Promise<void> {}
  async isAuthenticated(): Promise<boolean> { return true; }
  async *chat(): AsyncGenerator<string> { yield "hi"; }
  async listModels(): Promise<CopilotModel[]> { return [{ id: "gpt-4.1" }]; }
  async onToolCall(): Promise<void> {}
  setMaxToolsPerRequest(n: number): void { this.maxTools = n; }
  getMaxToolsPerRequest(): number { return this.maxTools; }
  async destroySession(): Promise<void> {}
  hasSession(): boolean { return false; }
  async clearAllSessions(): Promise<void> {}

  getReasoningEffort(): ReasoningEffort | undefined { return undefined; }
  setReasoningEffort(_effort: ReasoningEffort | undefined): void {}
  modelSupportsReasoning(): boolean { return false; }
  getProvider(): ProviderConfig | undefined { return undefined; }
  setProvider(_provider: ProviderConfig | undefined): void {}
  getWorkingDirectory(): string | undefined { return undefined; }
  setWorkingDirectory(_dir: string | undefined): void {}
  getCustomAgents(): CustomAgentDefinition[] { return []; }
  setCustomAgents(_agents: CustomAgentDefinition[]): void {}
  getNativeMcpServers(): Record<string, NativeMcpServerDefinition> { return { ...this.nativeServers }; }
  setNativeMcpServers(servers: Record<string, NativeMcpServerDefinition>): void { this.nativeServers = { ...servers }; }
  getSessionUsage() { return null; }
  clearSessionUsage() { return null; }
  async listSdkSessions() { return []; }
  async getSdkSessionMessages() { return []; }
  async deleteSdkSession() {}
  getSessionAnalytics() { return { sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [] as never[], lastUpdated: "" }; }
  resetSessionAnalytics() {}
}

class FakeTester implements NativeMcpTester {
  constructor(private mode: "ok" | "error") {}

  async testServer(serverName: string): Promise<
    | { ok: true; serverName: string; tools: Array<{ name: string; description: string }>; connectionTimeMs: number }
    | { ok: false; serverName: string; error: string }
  > {
    if (this.mode === "error") {
      return { ok: false, serverName, error: "ECONNREFUSED 127.0.0.1:5432" };
    }
    return {
      ok: true,
      serverName,
      tools: [
        { name: "db-query", description: "Execute SQL" },
        { name: "db-list-tables", description: "List tables" },
      ],
      connectionTimeMs: 120,
    };
  }
}

describe("Admin Native MCP API", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const createApp = async ({
    stats = { running: 0, queued: 0 },
    tester = new FakeTester("ok"),
  }: {
    stats?: { running: number; queued: number };
    tester?: NativeMcpTester;
  } = {}) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-admin-native-mcp-"));
    cleanupDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "config.json");
    process.env.OPENZIGS_CONFIG_PATH = configPath;

    const toolRegistry = new ToolRegistry({
      statePath: path.join(tmpDir, "tools.json"),
    });

    const copilot = new FakeCopilot();
    copilot.setNativeMcpServers({
      "my-db": {
        type: "local",
        command: "node",
        args: ["server.js"],
      },
    });

    const taskEngine = {
      getStats: () => stats,
    } as { getStats: () => { running: number; queued: number } };

    const router = createAdminRouter({
      toolRegistry,
      copilot,
      taskEngine: taskEngine as never,
      nativeMcpTester: tester,
    });

    const app = express();
    app.use(express.json());
    app.use("/api/admin", router);

    return { app };
  };

  it("PUT /api/admin/native-mcp-servers returns 409 when tasks are active", async () => {
    const { app } = await createApp({ stats: { running: 1, queued: 2 } });

    const res = await request(app)
      .put("/api/admin/native-mcp-servers")
      .send({
        servers: {
          test: { type: "local", command: "node", args: ["server.js"] },
        },
      });

    expect(res.status).toBe(409);
    expect(res.body.activeCount).toBe(3);
    expect(res.body.tasks).toEqual({ running: 1, queued: 2 });
  });

  it("POST /api/admin/native-mcp-servers/test returns discovered tools", async () => {
    const { app } = await createApp({ tester: new FakeTester("ok") });

    const res = await request(app)
      .post("/api/admin/native-mcp-servers/test")
      .send({
        serverName: "my-db",
        server: { type: "local", command: "node", args: ["server.js"] },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.serverName).toBe("my-db");
    expect(res.body.tools).toEqual([
      { name: "db-query", description: "Execute SQL" },
      { name: "db-list-tables", description: "List tables" },
    ]);
  });

  it("POST /api/admin/native-mcp-servers/test returns failure payload", async () => {
    const { app } = await createApp({ tester: new FakeTester("error") });

    const res = await request(app)
      .post("/api/admin/native-mcp-servers/test")
      .send({
        serverName: "my-db",
        server: { type: "local", command: "node", args: ["server.js"] },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("ECONNREFUSED");
  });

  it("GET /api/admin/tools includes USER MCP category after successful test", async () => {
    const { app } = await createApp({ tester: new FakeTester("ok") });

    await request(app)
      .post("/api/admin/native-mcp-servers/test")
      .send({
        serverName: "my-db",
        server: { type: "local", command: "node", args: ["server.js"] },
      });

    const toolsRes = await request(app).get("/api/admin/tools");
    expect(toolsRes.status).toBe(200);
    expect(toolsRes.body.tools["user mcp: my-db"]).toBeDefined();
    const toolNames = toolsRes.body.tools["user mcp: my-db"].map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain("mcp:my-db:db-query");
  });

  describe("prototype pollution guard", () => {
    const poisonedNames = ["__proto__", "constructor", "prototype"];

    for (const badName of poisonedNames) {
      it(`POST /native-mcp-servers/${badName} returns 400`, async () => {
        const { app } = await createApp();
        const res = await request(app)
          .post(`/api/admin/native-mcp-servers/${badName}`)
          .send({ type: "local", command: "node", args: ["server.js"] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Invalid server name");
      });

      it(`PUT /native-mcp-servers/${badName} returns 400`, async () => {
        const { app } = await createApp();
        const res = await request(app)
          .put(`/api/admin/native-mcp-servers/${badName}`)
          .send({ type: "local", command: "node", args: ["server.js"] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Invalid server name");
      });

      it(`POST /native-mcp-servers/${badName}/tools/add returns 400`, async () => {
        const { app } = await createApp();
        const res = await request(app)
          .post(`/api/admin/native-mcp-servers/${badName}/tools/add`)
          .send({ toolName: "some-tool" });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Invalid server name");
      });

      it(`POST /native-mcp-servers/${badName}/tools/foo/toggle returns 400`, async () => {
        const { app } = await createApp();
        const res = await request(app)
          .post(`/api/admin/native-mcp-servers/${badName}/tools/foo/toggle`)
          .send({ enabled: true });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Invalid server name");
      });

      it(`POST /native-mcp-servers/${badName}/tools/foo/remove returns 400`, async () => {
        const { app } = await createApp();
        const res = await request(app)
          .post(`/api/admin/native-mcp-servers/${badName}/tools/foo/remove`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Invalid server name");
      });
    }

    it("allows legitimate server names", async () => {
      const { app } = await createApp();
      const res = await request(app)
        .post("/api/admin/native-mcp-servers/my-valid-server")
        .send({ type: "local", command: "node", args: ["server.js"] });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });
  });
});
