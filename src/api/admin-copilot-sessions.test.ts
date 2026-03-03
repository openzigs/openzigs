import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { createAdminRouter } from "./admin.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { CopilotWrapper, SdkSessionMetadata, SdkSessionEvent, SessionAnalytics } from "../copilot/copilot-wrapper.js";
import type { CopilotModel, ReasoningEffort, ProviderConfig, CustomAgentDefinition, NativeMcpServerDefinition } from "../copilot/copilot-wrapper.js";

const FAKE_SESSIONS: SdkSessionMetadata[] = [
  {
    sessionId: "sdk-session-1",
    startTime: "2026-01-15T10:00:00.000Z",
    modifiedTime: "2026-01-15T11:30:00.000Z",
    summary: "Refactoring the auth module",
    isRemote: false,
    context: { cwd: "/home/dev/project", repository: "mgcronin/openzigs", branch: "main" },
  },
  {
    sessionId: "sdk-session-2",
    startTime: "2026-01-16T14:00:00.000Z",
    modifiedTime: "2026-01-16T15:00:00.000Z",
    isRemote: true,
  },
];

const FAKE_EVENTS: SdkSessionEvent[] = [
  { id: "e1", type: "session.start", timestamp: "2026-01-15T10:00:00.000Z", parentId: null, data: {} },
  { id: "e2", type: "user.message", timestamp: "2026-01-15T10:00:05.000Z", parentId: "e1", data: { content: "Refactor the auth module" } },
  { id: "e3", type: "assistant.message", timestamp: "2026-01-15T10:00:10.000Z", parentId: "e2", data: { content: "I'll start by analyzing the current auth module." } },
];

class FakeCopilot implements CopilotWrapper {
  private maxTools = 30;
  deletedSessionIds: string[] = [];
  private analytics: SessionAnalytics = {
    sessionsCreated: 5,
    sessionsResumed: 3,
    sessionsDestroyed: 1,
    compactionCount: 2,
    lifecycleEvents: [
      { type: "session.created", sessionId: "sdk-session-1" },
    ],
    lastUpdated: "2026-01-16T15:00:00.000Z",
  };

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
  getNativeMcpServers(): Record<string, NativeMcpServerDefinition> { return {}; }
  setNativeMcpServers(_servers: Record<string, NativeMcpServerDefinition>): void {}
  getSessionUsage() { return null; }
  clearSessionUsage() { return null; }

  async listSdkSessions() { return FAKE_SESSIONS; }
  async getSdkSessionMessages(sessionId: string) {
    if (sessionId === "sdk-session-1") return FAKE_EVENTS;
    return [];
  }
  async deleteSdkSession(sessionId: string) { this.deletedSessionIds.push(sessionId); }
  getSessionAnalytics() { return this.analytics; }
  resetSessionAnalytics() {
    this.analytics = {
      sessionsCreated: 0,
      sessionsResumed: 0,
      sessionsDestroyed: 0,
      compactionCount: 0,
      lifecycleEvents: [],
      lastUpdated: new Date().toISOString(),
    };
  }
}

describe("Admin Copilot Sessions API", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const createApp = async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-copilot-sessions-"));
    cleanupDirs.push(tmpDir);
    process.env.OPENZIGS_CONFIG_PATH = path.join(tmpDir, "config.json");

    const toolRegistry = new ToolRegistry({ statePath: path.join(tmpDir, "tools.json") });
    const copilot = new FakeCopilot();
    const router = createAdminRouter({ toolRegistry, copilot });

    const app = express();
    app.use(express.json());
    app.use("/api/admin", router);

    return { app, copilot };
  };

  it("GET /copilot-sessions returns all SDK sessions", async () => {
    const { app } = await createApp();
    const res = await request(app).get("/api/admin/copilot-sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].sessionId).toBe("sdk-session-1");
    expect(res.body.sessions[0].context.repository).toBe("mgcronin/openzigs");
    expect(res.body.sessions[1].isRemote).toBe(true);
  });

  it("GET /copilot-sessions/:sessionId/messages returns events", async () => {
    const { app } = await createApp();
    const res = await request(app).get("/api/admin/copilot-sessions/sdk-session-1/messages");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events[0].type).toBe("session.start");
    expect(res.body.events[1].content).toBe("Refactor the auth module");
  });

  it("GET /copilot-sessions/:sessionId/messages returns empty for unknown session", async () => {
    const { app } = await createApp();
    const res = await request(app).get("/api/admin/copilot-sessions/nonexistent/messages");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
  });

  it("DELETE /copilot-sessions/:sessionId deletes the session", async () => {
    const { app } = await createApp();
    const res = await request(app).delete("/api/admin/copilot-sessions/sdk-session-1");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("GET /copilot-sessions/analytics returns counters", async () => {
    const { app } = await createApp();
    const res = await request(app).get("/api/admin/copilot-sessions/analytics");
    expect(res.status).toBe(200);
    expect(res.body.sessionsCreated).toBe(5);
    expect(res.body.sessionsResumed).toBe(3);
    expect(res.body.sessionsDestroyed).toBe(1);
    expect(res.body.compactionCount).toBe(2);
    expect(res.body.lifecycleEvents).toHaveLength(1);
  });

  it("POST /copilot-sessions/analytics/reset resets counters", async () => {
    const { app } = await createApp();

    // Verify counters are non-zero before reset
    const before = await request(app).get("/api/admin/copilot-sessions/analytics");
    expect(before.body.sessionsCreated).toBe(5);

    // Reset
    const resetRes = await request(app).post("/api/admin/copilot-sessions/analytics/reset");
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.reset).toBe(true);

    // Verify counters are zero after
    const after = await request(app).get("/api/admin/copilot-sessions/analytics");
    expect(after.body.sessionsCreated).toBe(0);
    expect(after.body.sessionsResumed).toBe(0);
    expect(after.body.compactionCount).toBe(0);
  });
});
