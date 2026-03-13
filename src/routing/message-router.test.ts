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
  lastConversationId?: string;
  response: string;
  chunks: string[];
  destroyedSessions: string[] = [];

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

  lastSystemMessage?: import("../copilot/copilot-wrapper.js").SystemMessageConfig;

  async *chat(message: string, options?: { tools?: unknown[]; model?: string; onToolCall?: (tool: string, args: unknown) => void; conversationId?: string; systemMessage?: import("../copilot/copilot-wrapper.js").SystemMessageConfig }): AsyncGenerator<string> {
    this.lastPrompt = message;
    this.lastModel = options?.model;
    this.lastConversationId = options?.conversationId;
    this.lastSystemMessage = options?.systemMessage;
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

  async destroySession(conversationId: string): Promise<void> {
    this.destroyedSessions.push(conversationId);
  }

  hasSession(_conversationId: string): boolean {
    return false;
  }

  async clearAllSessions(): Promise<void> {
    return undefined;
  }

  getReasoningEffort() { return undefined; }
  setReasoningEffort() {}
  modelSupportsReasoning() { return false; }
  getProvider() { return undefined; }
  setProvider() {}
  getWorkingDirectory() { return undefined; }
  setWorkingDirectory() {}
  getCustomAgents() { return []; }
  setCustomAgents() {}
  getNativeMcpServers() { return {}; }
  setNativeMcpServers() {}
  getSessionUsage() { return null; }
  clearSessionUsage() { return null; }
  async listSdkSessions() { return []; }
  async getSdkSessionMessages() { return []; }
  async deleteSdkSession() {}
  getSessionAnalytics() { return { sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [] as never[], lastUpdated: "" }; }
  resetSessionAnalytics() {}
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

  it("reuses the same session for the same user and passes conversationId", async () => {
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
    // SDK handles multi-turn context natively; prompt should only contain the latest message
    expect(copilot.lastPrompt).not.toContain("First question");
    expect(copilot.lastPrompt).toContain("What did I just ask?");
    // conversationId must be passed for session reuse
    expect(copilot.lastConversationId).toBe(firstSession.id);
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

  it("injects personality via SDK systemMessage instead of in the prompt", async () => {
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

    // Personality should be injected via systemMessage, NOT in the prompt text
    expect(copilot.lastPrompt).not.toContain("System:");
    expect(copilot.lastPrompt).toBe("User: Tell me a joke");

    // systemMessage should contain personality content with append mode
    expect(copilot.lastSystemMessage).toBeDefined();
    expect(copilot.lastSystemMessage!.mode).toBe("append");
    expect(copilot.lastSystemMessage!.content).toContain("You are a pirate.");
    expect(copilot.lastSystemMessage!.content).toContain("Respond in rhyme.");
    expect(copilot.lastSystemMessage!.content).toContain("Always sign off with 'Arrr'.");
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
    // systemMessage should be undefined when personality is disabled
    expect(copilot.lastSystemMessage).toBeUndefined();
  });

  it("injects vault context into system message when vault is unlocked", async () => {
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

    // Create a mock vault service
    const vaultService = {
      isUnlocked: () => true,
      listSecrets: () => [
        { id: "abc-123", label: "Facebook", service: "facebook.com", username: "user@test.com" },
      ],
    } as unknown as import("../vault/index.js").SecretVaultService;

    const router = new MessageRouter({
      channelManager, sessionManager, copilot, personalityManager, vaultService,
    });

    await router.route(baseMessage({ content: "Log into Facebook" }));

    expect(copilot.lastSystemMessage).toBeDefined();
    expect(copilot.lastSystemMessage!.content).toContain("[Secret Vault]");
    expect(copilot.lastSystemMessage!.content).toContain("get-secret");
    expect(copilot.lastSystemMessage!.content).toContain("Facebook");
    expect(copilot.lastSystemMessage!.content).toContain("facebook.com");
  });

  it("omits vault context when vault is locked", async () => {
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

    const vaultService = {
      isUnlocked: () => false,
      listSecrets: () => [],
    } as unknown as import("../vault/index.js").SecretVaultService;

    const router = new MessageRouter({
      channelManager, sessionManager, copilot, personalityManager, vaultService,
    });

    await router.route(baseMessage({ content: "Hello" }));

    // Vault locked → injects locked-state notice (not the full credential instructions)
    expect(copilot.lastSystemMessage).toBeDefined();
    expect(copilot.lastSystemMessage!.content).toContain("currently LOCKED");
    expect(copilot.lastSystemMessage!.content).not.toContain("Available secrets:");
  });

  it("passes SDK-native availableTools when allowedTools provided", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });

    // Track what availableTools were passed to chat
    let capturedAvailableTools: string[] | undefined;
    const copilot = {
      ...new FakeCopilot("ok"),
      chat: async function* (_message: string, options?: { availableTools?: string[]; model?: string; onToolCall?: (tool: string, args: unknown) => void }) {
        capturedAvailableTools = options?.availableTools;
        yield "scoped response";
      },
    } as unknown as CopilotWrapper;

    const router = new MessageRouter({
      channelManager,
      sessionManager,
      copilot,
    });

    await router.route(baseMessage({ content: "Search LinkedIn" }), {
      allowedTools: ["web-search", "linkedin-post"],
    });

    expect(capturedAvailableTools).toBeDefined();
    // Should include explicitly allowed tools
    expect(capturedAvailableTools).toContain("web-search");
    expect(capturedAvailableTools).toContain("linkedin-post");
    // Should NOT merge ALWAYS_ON_TOOLS — client-specified tools are trusted as-is
    expect(capturedAvailableTools).toHaveLength(2);
  });

  it("does not scope tools when allowedTools not provided", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });

    let capturedAvailableTools: string[] | undefined;
    const copilot = {
      ...new FakeCopilot("ok"),
      chat: async function* (_message: string, options?: { availableTools?: string[]; model?: string }) {
        capturedAvailableTools = options?.availableTools;
        yield "unscoped response";
      },
    } as unknown as CopilotWrapper;

    const router = new MessageRouter({
      channelManager,
      sessionManager,
      copilot,
    });

    await router.route(baseMessage({ content: "Hello" }));

    // availableTools should be undefined (no scoping)
    expect(capturedAvailableTools).toBeUndefined();
  });

  it("passes conversationId to copilot.chat on first message", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("Hi");
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    await router.route(baseMessage({ content: "Hello" }));

    const sessions = await sessionManager.listSessions();
    expect(sessions).toHaveLength(1);
    // conversationId should match the session ID
    expect(copilot.lastConversationId).toBe(sessions[0].id);
  });

  it("destroys SDK session when clearing user session", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("ok");
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    await router.route(baseMessage({ content: "Hello" }));
    const sessions = await sessionManager.listSessions();
    const sessionId = sessions[0].id;

    router.clearUserSession("telegram", "user-1");

    // Should have called destroySession with the session ID
    expect(copilot.destroyedSessions).toContain(sessionId);
  });

  it("injects brand voice into system message", async () => {
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
    const copilot = new FakeCopilot("branded reply");

    const brandVoiceService = {
      getActiveVoicePromptBlock: () => "[Brand Voice]\nAlways use casual, friendly tone. Avoid jargon.",
    } as unknown as import("../personality/brand-voice-service.js").BrandVoiceService;

    const router = new MessageRouter({
      channelManager, sessionManager, copilot, personalityManager, brandVoiceService,
    });

    await router.route(baseMessage({ content: "Write a tweet" }));

    expect(copilot.lastSystemMessage).toBeDefined();
    expect(copilot.lastSystemMessage!.content).toContain("[Brand Voice]");
    expect(copilot.lastSystemMessage!.content).toContain("casual, friendly tone");
  });

  it("tracks chat messages as tasks when taskEngine is provided", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("task-tracked reply");

    const submittedTasks: Array<{ goal: string; trigger: string }> = [];
    const completedTasks: Array<{ id: string; result: string }> = [];
    const taskEngine = {
      submit: (params: { trigger: string; goal: string }) => {
        const task = { id: `task-${submittedTasks.length + 1}`, ...params };
        submittedTasks.push(params);
        return task;
      },
      complete: (id: string, result: string) => {
        completedTasks.push({ id, result });
      },
      fail: () => {},
    } as unknown as import("../tasks/task-engine.js").TaskEngine;

    const router = new MessageRouter({
      channelManager, sessionManager, copilot, taskEngine,
    });

    await router.route(baseMessage({ content: "Summarize this document" }));

    expect(submittedTasks).toHaveLength(1);
    expect(submittedTasks[0].trigger).toBe("chat");
    expect(submittedTasks[0].goal).toContain("Summarize this document");
    expect(completedTasks).toHaveLength(1);
    expect(completedTasks[0].result).toContain("task-tracked reply");
  });

  it("marks task as failed when copilot.chat throws", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });

    const failingCopilot = {
      ...new FakeCopilot("ok"),
      chat: async function* () { // eslint-disable-line require-yield
        throw new Error("Model unavailable");
      },
    } as unknown as CopilotWrapper;

    const failedTasks: Array<{ id: string; error: string }> = [];
    const taskEngine = {
      submit: () => ({ id: "task-err" }),
      complete: () => {},
      fail: (id: string, error: string) => {
        failedTasks.push({ id, error });
      },
    } as unknown as import("../tasks/task-engine.js").TaskEngine;

    const router = new MessageRouter({
      channelManager, sessionManager, copilot: failingCopilot, taskEngine,
    });

    await expect(router.route(baseMessage({ content: "Hello" }))).rejects.toThrow("Model unavailable");
    expect(failedTasks).toHaveLength(1);
    expect(failedTasks[0].error).toContain("Model unavailable");
  });

  it("throws when channel is not registered", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("ok");
    const router = new MessageRouter({ channelManager, sessionManager, copilot });

    await expect(
      router.route(baseMessage({ channelType: "unknown" as never }))
    ).rejects.toThrow("Channel not registered");
  });

  it("open access mode allows all users", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const channelManager = new ChannelManager();
    const telegram = new RecordingChannel("telegram");
    await telegram.connect();
    channelManager.register(telegram);

    const sessionManager = new SessionManager({ baseDir });
    const copilot = new FakeCopilot("open reply");
    const router = new MessageRouter({
      channelManager, sessionManager, copilot,
      accessControl: { mode: "open", allowedUsers: [], blockedUsers: [] },
    });

    await router.route(baseMessage({ userId: "random-user" }));
    expect(telegram.messages).toHaveLength(1);
  });
});
