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

  async *chat(message: string, _tools?: unknown[], model?: string): AsyncGenerator<string> {
    this.lastPrompt = message;
    this.lastModel = model;
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
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].content.text).toBe("Hello world");
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
});
