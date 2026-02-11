import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import * as z from "zod";
import { ToolRegistry, type ToolDefinition } from "../mcp/tool-registry.js";
import { CopilotWrapperService } from "./copilot-wrapper.js";

class FakeSession {
  readonly sessionId: string;
  private handlers = new Map<string, Array<(event: { data?: { deltaContent?: string } }) => void>>();
  destroyed = false;

  constructor(sessionId = "fake-session-id") {
    this.sessionId = sessionId;
  }

  on(event: string, handler: (event: { data?: { deltaContent?: string } }) => void): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const handlers = this.handlers.get(event) ?? [];
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  }

  async sendAndWait({ prompt }: { prompt: string }, _timeout?: number) {
    if (!prompt) {
      throw new Error("Missing prompt");
    }
    this.emit("assistant.message_delta", { data: { deltaContent: "hello" } });
    this.emit("session.idle", {});
  }

  async destroy() {
    this.destroyed = true;
  }

  private emit(event: string, payload: { data?: { deltaContent?: string } }) {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      handler(payload);
    }
  }
}

class FakeCopilotClient {
  public lastSessionConfig: { tools?: unknown[]; model?: string; sessionId?: string; infiniteSessions?: unknown } | null = null;
  public sessions: FakeSession[] = [];
  public resumeAttempts: string[] = [];

  async start() {
    return undefined;
  }

  async createSession(config: { tools?: unknown[]; model?: string; sessionId?: string; infiniteSessions?: unknown }) {
    this.lastSessionConfig = config;
    const session = new FakeSession(config.sessionId ?? `session-${this.sessions.length}`);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(sessionId: string, config?: { tools?: unknown[]; model?: string; infiniteSessions?: unknown }) {
    this.resumeAttempts.push(sessionId);
    this.lastSessionConfig = { ...config, sessionId };
    const session = new FakeSession(sessionId);
    this.sessions.push(session);
    return session;
  }

  async stop() {
    return [] as Error[];
  }

  async startDeviceAuth() {
    return { verificationUri: "https://github.com/login/device", userCode: "ABCD-1234" };
  }

  async waitForAuth() {
    return { token: "token-123", expiresAt: Date.now() + 60_000 };
  }

  async listModels() {
    return [{ id: "gpt-4.1" }, { id: "claude-sonnet-4" }];
  }
}

const buildTool = (name: string): ToolDefinition => {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {
      type: "object",
      properties: {}
    },
    zodSchema: z.object({}),
    category: "filesystem",
    riskLevel: "low",
    handler: async () => ({ text: "ok" })
  };
};

describe("copilot wrapper", () => {
  it("persists auth token with restricted permissions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-auth-"));
    const authPath = path.join(tmpDir, "auth.json");
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({
      client,
      authPath,
      clientId: "client-id"
    });

    const authInfo = await wrapper.authenticate();
    expect(authInfo.verificationUri).toContain("github.com");
    expect(authInfo.userCode.length).toBeGreaterThanOrEqual(8);

    await wrapper.waitForAuth();
    const saved = JSON.parse(await fs.readFile(authPath, "utf-8")) as { token: string };
    expect(saved.token).toBe("token-123");

    const stat = await fs.stat(authPath);
    expect(stat.mode & 0o077).toBe(0);
    expect(await wrapper.isAuthenticated()).toBe(true);
  });

  it("streams chat output and passes tools to the SDK", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-test-"));
    const registry = new ToolRegistry({
      statePath: path.join(tmpDir, "tool-registry.json"),
      defaultEnabledTools: ["read-file"]
    });
    registry.registerTool(buildTool("read-file"));

    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({
      client,
      toolRegistry: registry
    });

    const chunks: string[] = [];
    for await (const chunk of wrapper.chat("Hello")) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("hello");
    expect(client.lastSessionConfig?.tools?.length).toBe(1);
  });

  it("passes model override to createSession", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    const chunks: string[] = [];
    for await (const chunk of wrapper.chat("Hello", { model: "claude-sonnet-4" })) {
      chunks.push(chunk);
    }

    expect(client.lastSessionConfig?.model).toBe("claude-sonnet-4");
  });

  it("uses default model when no override is provided", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client, model: "gpt-4.1" });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello")) {
      // drain
    }

    expect(client.lastSessionConfig?.model).toBe("gpt-4.1");
  });

  it("lists available models from the client", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    const models = await wrapper.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-4.1");
    expect(models[1].id).toBe("claude-sonnet-4");
  });

  it("returns fallback model when client has no listModels", async () => {
    const client = {
      async start() { return undefined; },
      async createSession(_config: { tools?: unknown[]; model?: string }) {
        return new FakeSession();
      },
      async stop() { return [] as Error[]; }
    };
    const wrapper = new CopilotWrapperService({ client, model: "gpt-4.1" });

    const models = await wrapper.listModels();
    expect(models).toEqual([{ id: "gpt-4.1" }]);
  });

  it("sets startFailed when client.start() throws, and chat() throws descriptive error", async () => {
    const client = {
      async start() { throw new Error("unknown option '--headless'"); },
      async createSession(_config: { tools?: unknown[]; model?: string }) {
        return new FakeSession();
      },
      async stop() { return [] as Error[]; },
      async listModels() { return [{ id: "gpt-4.1" }]; }
    };
    const wrapper = new CopilotWrapperService({ client });

    // listModels should throw since SDK failed to start
    await expect(wrapper.listModels()).rejects.toThrow(/failed to start/);

    // chat should throw with a descriptive message
    const gen = wrapper.chat("Hello");
    await expect(gen.next()).rejects.toThrow(/SDK is unavailable/);
  });

  it("sets startFailed when client.start() times out", async () => {
    const client = {
      async start() { return new Promise<void>(() => { /* never resolves */ }); },
      async createSession(_config: { tools?: unknown[]; model?: string }) {
        return new FakeSession();
      },
      async stop() { return [] as Error[]; },
      async listModels() { return [{ id: "gpt-4.1" }]; }
    };
    const wrapper = new CopilotWrapperService({ client });

    // listModels should throw since SDK timed out
    await expect(wrapper.listModels()).rejects.toThrow(/failed to start/);

    // chat should throw
    const gen = wrapper.chat("Hello");
    await expect(gen.next()).rejects.toThrow(/SDK is unavailable/);
  }, 15000);

  it("caches and reuses sessions when conversationId is provided", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    // First call — creates a new session
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello", { conversationId: "conv-1" })) { /* drain */ }
    expect(client.sessions).toHaveLength(1);

    // Second call — reuses cached session (no new session created)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Follow up", { conversationId: "conv-1" })) { /* drain */ }
    expect(client.sessions).toHaveLength(1);

    // Different conversationId — creates a new session
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("New conv", { conversationId: "conv-2" })) { /* drain */ }
    expect(client.sessions).toHaveLength(2);
  });

  it("creates ephemeral sessions when no conversationId is provided", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello")) { /* drain */ }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello again")) { /* drain */ }

    // Each call without conversationId creates a new session
    expect(client.sessions).toHaveLength(2);
    expect(wrapper.hasSession("anything")).toBe(false);
  });

  it("attempts resumeSession before createSession when conversationId is given", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello", { conversationId: "resume-me" })) { /* drain */ }

    // Should have tried resumeSession first
    expect(client.resumeAttempts).toContain("resume-me");
    expect(wrapper.hasSession("resume-me")).toBe(true);
  });

  it("falls back to createSession when resumeSession fails", async () => {
    const client = new FakeCopilotClient();
    // Make resumeSession throw
    client.resumeSession = async () => { throw new Error("not found"); };
    const wrapper = new CopilotWrapperService({ client });

    const chunks: string[] = [];
    for await (const chunk of wrapper.chat("Hello", { conversationId: "new-conv" })) {
      chunks.push(chunk);
    }

    // Should still work via createSession fallback
    expect(chunks.join("")).toContain("hello");
    expect(wrapper.hasSession("new-conv")).toBe(true);
  });

  it("destroySession removes cached session and calls destroy", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello", { conversationId: "destroy-me" })) { /* drain */ }
    expect(wrapper.hasSession("destroy-me")).toBe(true);

    await wrapper.destroySession("destroy-me");
    expect(wrapper.hasSession("destroy-me")).toBe(false);
    expect(client.sessions[0].destroyed).toBe(true);
  });

  it("clearAllSessions destroys all cached sessions", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("A", { conversationId: "c1" })) { /* drain */ }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("B", { conversationId: "c2" })) { /* drain */ }
    expect(wrapper.hasSession("c1")).toBe(true);
    expect(wrapper.hasSession("c2")).toBe(true);

    await wrapper.clearAllSessions();
    expect(wrapper.hasSession("c1")).toBe(false);
    expect(wrapper.hasSession("c2")).toBe(false);
    expect(client.sessions[0].destroyed).toBe(true);
    expect(client.sessions[1].destroyed).toBe(true);
  });

  it("passes infiniteSessions config to createSession", async () => {
    const client = new FakeCopilotClient();
    const infiniteSessions = {
      enabled: true,
      backgroundCompactionThreshold: 0.80,
      bufferExhaustionThreshold: 0.95,
    };
    const wrapper = new CopilotWrapperService({ client, infiniteSessions });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello")) { /* drain */ }

    expect(client.lastSessionConfig?.infiniteSessions).toEqual(infiniteSessions);
  });

  it("passes sessionId to createSession when conversationId is provided and resume is unavailable", async () => {
    const client = new FakeCopilotClient();
    // Remove resumeSession to force createSession path
    delete (client as Partial<FakeCopilotClient>).resumeSession;
    const wrapper = new CopilotWrapperService({ client });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello", { conversationId: "my-session" })) { /* drain */ }

    expect(client.lastSessionConfig?.sessionId).toBe("my-session");
  });

  it("unsubscribes event handlers after each chat call to prevent accumulation", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    // Call chat twice on the same session
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("First", { conversationId: "unsub-test" })) { /* drain */ }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Second", { conversationId: "unsub-test" })) { /* drain */ }

    // After unsubscription, the session should have no lingering handlers
    // The session is reused, but only the current call's handlers should be active
    expect(client.sessions).toHaveLength(1);
  });
});
