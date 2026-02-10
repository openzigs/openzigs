import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelManager } from "../channels/channel-manager.js";
import type {
  IncomingMessage,
  MessageChannel,
  MessageContent,
  ChannelType,
  ApprovalRequest,
  ApprovalResponse
} from "../channels/types.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { CopilotModel } from "../copilot/copilot-wrapper.js";
import { SessionManager } from "../sessions/session-manager.js";
import { MessageRouter } from "./message-router.js";
import Database from "better-sqlite3";
import { PersonalityManager } from "../personality/personality-manager.js";

const createTempDir = async () => {
  return fs.mkdtemp(path.join(os.tmpdir(), "openzigs-router-"));
};

class RecordingChannel implements MessageChannel {
  readonly id: string;
  readonly type: ChannelType;
  private connected = false;
  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private approvalHandlers: Array<(response: ApprovalResponse) => void> = [];
  messages: Array<{ chatId: string; content: MessageContent }> = [];

  constructor(type: ChannelType, id?: string) {
    this.type = type;
    this.id = id ?? type;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(chatId: string, content: MessageContent): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
    this.messages.push({ chatId, content });
  }

  async sendApprovalRequest(_chatId: string, _request: ApprovalRequest): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onApprovalResponse(handler: (response: ApprovalResponse) => void): void {
    this.approvalHandlers.push(handler);
  }

  emitMessage(message: IncomingMessage) {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

class FakeCopilot implements CopilotWrapper {
  lastPrompt = "";
  lastModel?: string;
  response: string;
  chunks: string[];

  constructor(response = "pong", chunks?: string[]) {
    this.response = response;
    this.chunks = chunks ?? [response];
  }

  async authenticate() {
    return { verificationUri: "", userCode: "" };
  }

  async waitForAuth(): Promise<void> {
    return undefined;
  }

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  async *chat(message: string, options?: { tools?: unknown[]; model?: string; onToolCall?: (tool: string, args: unknown) => void }): AsyncGenerator<string> {
    this.lastPrompt = message;
    this.lastModel = options?.model;
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  async listModels(): Promise<CopilotModel[]> {
    return [{ id: "gpt-4.1" }];
  }

  async onToolCall(): Promise<void> {
    return undefined;
  }

  setMaxToolsPerRequest(_n: number): void {}

  getMaxToolsPerRequest(): number {
    return 30;
  }
}

const baseMessage = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => {
  return {
    channelType: "telegram",
    channelId: "telegram",
    chatId: "chat-1",
    userId: "user-1",
    username: "ada",
    content: "Hello",
    attachments: [],
    timestamp: new Date("2026-02-03T00:00:00Z"),
    ...overrides
  };
};

describe("MessageRouter", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("creates a session and sends a reply", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("Hi there");
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    await router.route(baseMessage({ content: "Hello" }));

    const sessions = await sessionManager.listSessions();
    expect(sessions).toHaveLength(1);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].content.text).toBe("Hi there");

    const history = await sessionManager.getHistory(sessions[0].id);
    expect(history).toHaveLength(2);
  });

  it("reuses the same session for the same user", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("pong");
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    await router.route(baseMessage({ content: "First question" }));
    const firstSession = (await sessionManager.listSessions())[0];

    await router.route(baseMessage({ content: "What did I just ask?" }));
    const secondSession = (await sessionManager.listSessions())[0];

    expect(secondSession.id).toBe(firstSession.id);
    expect(copilot.lastPrompt).toContain("First question");
  });

  it("rejects users outside the allowlist", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("pong");
    const router = new MessageRouter({
      channelManager,
      sessionManager,
      copilot,
      accessControl: {
        mode: "allowlist",
        allowedUsers: ["telegram:user-1"],
        blockedUsers: []
      }
    });

    await router.route(baseMessage({ userId: "user-2" }));

    const sessions = await sessionManager.listSessions();
    expect(sessions).toHaveLength(0);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].content.text).toBe("Unauthorized");
  });

  it("rejects users inside the blocklist", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("pong");
    const router = new MessageRouter({
      channelManager,
      sessionManager,
      copilot,
      accessControl: {
        mode: "blocklist",
        allowedUsers: [],
        blockedUsers: ["telegram:user-blocked"]
      }
    });

    await router.route(baseMessage({ userId: "user-blocked" }));

    const sessions = await sessionManager.listSessions();
    expect(sessions).toHaveLength(0);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].content.text).toBe("Unauthorized");

    await router.route(baseMessage({ userId: "user-ok" }));
    const sessionsOk = await sessionManager.listSessions();
    expect(sessionsOk).toHaveLength(1);
  });

  it("routes responses back to the origin channel", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    const discord = new RecordingChannel("discord");
    await telegram.connect();
    await discord.connect();
    channelManager.register(telegram);
    channelManager.register(discord);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("pong");
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    await router.route(baseMessage({ content: "Hello" }));

    expect(telegram.messages).toHaveLength(1);
    expect(discord.messages).toHaveLength(0);
  });

  it("invokes onChunk callback for each streaming chunk", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("", ["Hello", " ", "world"]);
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    const received: string[] = [];
    await router.route(baseMessage({ content: "stream test" }), {
      onChunk: (chunk) => received.push(chunk)
    });

    expect(received).toEqual(["Hello", " ", "world"]);
    // When streaming (onChunk provided), the router does NOT call sendMessage;
    // the channel handler is responsible for delivery via chunks.
    expect(telegram.messages).toHaveLength(0);
  });

  it("passes model override to copilot.chat", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("ok");
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    await router.route(baseMessage({ content: "model test" }), { model: "claude-sonnet-4" });

    expect(copilot.lastModel).toBe("claude-sonnet-4");
  });

  it("injects personality system instruction and pre-prompt into the prompt", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    const personalityManager = new PersonalityManager({ db });
    personalityManager.update({
      systemInstruction: "You are a pirate.",
      prePrompt: "Respond in rhyme.",
      postPrompt: "Always sign off with 'Arrr'.",
      enabled: true,
    });

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("Ahoy");
    const router = new MessageRouter({ channelManager, sessionManager, copilot, personalityManager });

    await router.route(baseMessage({ content: "Tell me a joke" }));

    expect(copilot.lastPrompt).toContain("System: You are a pirate.");
    expect(copilot.lastPrompt).toContain("Respond in rhyme.");
    expect(copilot.lastPrompt).toContain("User: Tell me a joke");
    expect(copilot.lastPrompt).toContain("Always sign off with 'Arrr'.");
  });

  it("skips personality injection when disabled", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    const personalityManager = new PersonalityManager({ db });
    personalityManager.update({ enabled: false });

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("ok");
    const router = new MessageRouter({ channelManager, sessionManager, copilot, personalityManager });

    await router.route(baseMessage({ content: "Hello" }));

    expect(copilot.lastPrompt).not.toContain("System:");
    expect(copilot.lastPrompt).toBe("User: Hello");
  });

  it("passes scoped tools to copilot.chat when allowedTools provided", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });

    // Track what tools were passed to chat
    let capturedTools: unknown[] | undefined;
    const copilot = {
      ...new FakeCopilot("ok"),
      chat: async function* (_message: string, options?: { tools?: unknown[]; model?: string; onToolCall?: (tool: string, args: unknown) => void }) {
        capturedTools = options?.tools;
        yield "scoped response";
      },
    } as unknown as CopilotWrapper;

    // Create a minimal mock ToolRegistry
    const mockToolDefs = [
      { name: "read-file", description: "Read file", category: "filesystem", riskLevel: "low" },
      { name: "web-search", description: "Search", category: "search", riskLevel: "low" },
      { name: "shell-execute", description: "Execute shell", category: "shell", riskLevel: "high" },
      { name: "spawn-agent", description: "Spawn agent", category: "developer", riskLevel: "medium" },
      { name: "list-directory", description: "List dir", category: "filesystem", riskLevel: "low" },
      { name: "browser-navigate", description: "Navigate", category: "browser", riskLevel: "high" },
      { name: "orchestrate-agents", description: "Orchestrate", category: "developer", riskLevel: "medium" },
      { name: "linkedin-post", description: "Post to LinkedIn", category: "social", riskLevel: "medium" },
    ];

    const mockToolRegistry = {
      listEnabledTools: () => mockToolDefs,
    };

    const router = new MessageRouter({
      channelManager,
      sessionManager,
      copilot,
      toolRegistry: mockToolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
    });

    await router.route(baseMessage({ content: "Search LinkedIn" }), {
      allowedTools: ["web-search", "linkedin-post"],
    });

    expect(capturedTools).toBeDefined();
    const toolNames = (capturedTools as Array<{ name: string }>).map((t) => t.name);
    // Should include explicitly allowed tools
    expect(toolNames).toContain("web-search");
    expect(toolNames).toContain("linkedin-post");
    // Should include always-on tools
    expect(toolNames).toContain("read-file");
    expect(toolNames).toContain("spawn-agent");
    // Should NOT include tools not in the allowlist (unless they're always-on)
    // shell-execute IS always-on, so it should still be there
    expect(toolNames).toContain("shell-execute");
  });

  it("does not scope tools when allowedTools not provided", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });

    let capturedTools: unknown[] | undefined;
    const copilot = {
      ...new FakeCopilot("ok"),
      chat: async function* (_message: string, options?: { tools?: unknown[]; model?: string }) {
        capturedTools = options?.tools;
        yield "unscoped response";
      },
    } as unknown as CopilotWrapper;

    const mockToolRegistry = {
      listEnabledTools: () => [],
    };

    const router = new MessageRouter({
      channelManager,
      sessionManager,
      copilot,
      toolRegistry: mockToolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
    });

    await router.route(baseMessage({ content: "Hello" }));

    // tools should be undefined (no scoping)
    expect(capturedTools).toBeUndefined();
  });
});
