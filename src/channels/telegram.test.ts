import { describe, expect, it } from "vitest";
import type { Context } from "grammy";
import type { ApprovalResponse, MessageContent } from "./types.js";
import { TelegramChannel } from "./telegram.js";

class MockBot {
  token = "token";
  api = {
    sendMessageCalls: [] as Array<{ chatId: string; text: string; options?: Record<string, unknown> }>,
    editMessageTextCalls: [] as Array<{ chatId: string; messageId: number; text: string }>,
    answerCallbackQueryCalls: [] as Array<{ id: string; options?: Record<string, unknown> }>,
    async sendMessage(chatId: string, text: string, options?: Record<string, unknown>) {
      this.sendMessageCalls.push({ chatId, text, options });
    },
    async setWebhook() {
      return undefined;
    },
    async answerCallbackQuery(id: string, options?: Record<string, unknown>) {
      this.answerCallbackQueryCalls.push({ id, options });
    },
    async editMessageText(chatId: string, messageId: number, text: string) {
      this.editMessageTextCalls.push({ chatId, messageId, text });
    }
  };
  messageHandler?: (ctx: Context) => Promise<void> | void;
  commandHandlers = new Map<string, (ctx: Context) => Promise<void> | void>();
  callbackHandlers: Array<{ pattern: RegExp | string; handler: (ctx: Context) => Promise<void> | void }> = [];

  on(event: string, handler: (ctx: Context) => Promise<void> | void) {
    if (event === "message:text") {
      this.messageHandler = handler;
    }
  }

  command(command: string, handler: (ctx: Context) => Promise<void> | void) {
    this.commandHandlers.set(command, handler);
  }

  callbackQuery(pattern: RegExp | string, handler: (ctx: Context) => Promise<void> | void) {
    this.callbackHandlers.push({ pattern, handler });
  }
}

describe("TelegramChannel", () => {
  it("splits long messages into multiple sends", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({
      config: { botToken: "token" },
      bot
    });
    await channel.connect();

    const content: MessageContent = {
      text: "a".repeat(9000),
      markdown: false
    };

    await channel.sendMessage("chat-1", content);

    expect(bot.api.sendMessageCalls.length).toBeGreaterThan(1);
    for (const call of bot.api.sendMessageCalls) {
      expect(call.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("emits approval response for callback queries", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({
      config: { botToken: "token" },
      bot
    });
    await channel.connect();

    const responses: ApprovalResponse[] = [];
    channel.onApprovalResponse((response) => responses.push(response));

    await channel.sendApprovalRequest("chat-1", {
      id: "approval-1",
      tool: "shell",
      args: {},
      riskLevel: "high",
      explanation: "Test approval"
    });

    const callback = bot.callbackHandlers[0];
    const match = "approve:approval-1".match(callback.pattern as RegExp) ?? [];
    const ctx = {
      match,
      from: { id: 99 },
      callbackQuery: {
        id: "cb-1",
        message: {
          text: "Permission Required",
          message_id: 123,
          chat: { id: "chat-1" }
        }
      },
      answerCallbackQuery: async () => undefined
    } as unknown as Context;

    await callback.handler(ctx);

    expect(responses).toHaveLength(1);
    expect(responses[0].approvalId).toBe("approval-1");
    expect(responses[0].approved).toBe(true);
  });

  // ── New tests ──

  it("connect sets connected state", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    expect(channel.isConnected()).toBe(false);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
  });

  it("disconnect sets connected to false", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it("throws when sending on disconnected channel", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await expect(channel.sendMessage("chat-1", { text: "hi" }))
      .rejects.toThrow("Channel is not connected");
  });

  it("throws when sending approval request on disconnected channel", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await expect(channel.sendApprovalRequest("chat-1", {
      id: "a1", tool: "test", args: {}, riskLevel: "medium", explanation: "test",
    })).rejects.toThrow("Channel is not connected");
  });

  it("onMessage handler receives messages", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const received: Array<{ content: string }> = [];
    channel.onMessage((msg) => received.push(msg));

    const ctx = {
      message: { text: "hello", date: Math.floor(Date.now() / 1000) },
      chat: { id: 42 },
      from: { id: 99, username: "testuser" },
    } as unknown as Context;

    await bot.messageHandler!(ctx);
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("hello");
  });

  it("ignores messages starting with /", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const received: Array<{ content: string }> = [];
    channel.onMessage((msg) => received.push(msg));

    const ctx = {
      message: { text: "/status", date: Math.floor(Date.now() / 1000) },
      chat: { id: 42 },
      from: { id: 99 },
    } as unknown as Context;

    await bot.messageHandler!(ctx);
    expect(received).toHaveLength(0);
  });

  it("ignores messages with empty text", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const received: Array<{ content: string }> = [];
    channel.onMessage((msg) => received.push(msg));

    const ctx = {
      message: {},
      chat: { id: 42 },
      from: { id: 99 },
    } as unknown as Context;

    await bot.messageHandler!(ctx);
    expect(received).toHaveLength(0);
  });

  it("ignores messages without chatId or userId", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const received: Array<{ content: string }> = [];
    channel.onMessage((msg) => received.push(msg));

    const ctx = {
      message: { text: "hello" },
      chat: undefined,
      from: { id: 99 },
    } as unknown as Context;

    await bot.messageHandler!(ctx);
    expect(received).toHaveLength(0);
  });

  it("/start command sends welcome message", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const replies: string[] = [];
    const ctx = { reply: async (text: string) => { replies.push(text); } } as unknown as Context;
    await bot.commandHandlers.get("start")!(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Welcome");
  });

  it("/help command sends help message", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const replies: string[] = [];
    const ctx = { reply: async (text: string) => { replies.push(text); } } as unknown as Context;
    await bot.commandHandlers.get("help")!(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Available commands");
  });

  it("/cancel replies with nothing to cancel", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const replies: string[] = [];
    const ctx = { reply: async (text: string) => { replies.push(text); } } as unknown as Context;
    await bot.commandHandlers.get("cancel")!(ctx);
    expect(replies[0]).toContain("Nothing to cancel");
  });

  it("/status without tool registry replies not available", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const replies: string[] = [];
    const ctx = { reply: async (text: string) => { replies.push(text); } } as unknown as Context;
    await bot.commandHandlers.get("status")!(ctx);
    expect(replies[0]).toContain("not available");
  });

  it("/toggle without tool registry replies not available", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const replies: string[] = [];
    const ctx = {
      message: { text: "/toggle read-file on" },
      from: { id: 99 },
      reply: async (text: string) => { replies.push(text); },
    } as unknown as Context;
    await bot.commandHandlers.get("toggle")!(ctx);
    expect(replies[0]).toContain("not available");
  });

  it("/toggle with missing args replies usage", async () => {
    const bot = new MockBot();
    const mockToolRegistry = { setEnabled: async () => {}, getAllTools: () => ({}) };
    const channel = new TelegramChannel({
      config: { botToken: "token" },
      bot,
      toolRegistry: mockToolRegistry as any,
    });
    await channel.connect();

    const replies: string[] = [];
    const ctx = {
      message: { text: "/toggle" },
      from: { id: 99 },
      reply: async (text: string) => { replies.push(text); },
    } as unknown as Context;
    await bot.commandHandlers.get("toggle")!(ctx);
    expect(replies[0]).toContain("Usage");
  });

  it("/toggle enforces admin userId", async () => {
    const bot = new MockBot();
    const mockToolRegistry = { setEnabled: async () => {}, getAllTools: () => ({}) };
    const channel = new TelegramChannel({
      config: { botToken: "token", adminUserId: "42" },
      bot,
      toolRegistry: mockToolRegistry as any,
    });
    await channel.connect();

    const replies: string[] = [];
    const ctx = {
      message: { text: "/toggle read-file on" },
      from: { id: 99 }, // not admin (42)
      reply: async (text: string) => { replies.push(text); },
    } as unknown as Context;
    await bot.commandHandlers.get("toggle")!(ctx);
    expect(replies[0]).toContain("Unauthorized");
  });

  it("sends markdown-formatted messages", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    await channel.sendMessage("chat-1", { text: "**bold text**", markdown: true });
    expect(bot.api.sendMessageCalls.length).toBeGreaterThan(0);
    expect(bot.api.sendMessageCalls[0].options).toEqual(expect.objectContaining({ parse_mode: "MarkdownV2" }));
  });

  it("callback query reject sends REJECTED status", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    const responses: ApprovalResponse[] = [];
    channel.onApprovalResponse((r) => responses.push(r));

    await channel.sendApprovalRequest("chat-1", {
      id: "approval-rej",
      tool: "shell",
      args: {},
      riskLevel: "high",
      explanation: "Test"
    });

    const callback = bot.callbackHandlers[0];
    const match = "reject:approval-rej".match(callback.pattern as RegExp) ?? [];
    const ctx = {
      match,
      from: { id: 99 },
      callbackQuery: { id: "cb-2", message: { text: "Permission Required", message_id: 100, chat: { id: "chat-1" } } },
      answerCallbackQuery: async () => undefined,
    } as unknown as Context;

    await callback.handler(ctx);
    expect(responses).toHaveLength(1);
    expect(responses[0].approved).toBe(false);
  });

  it("details callback shows extended info", async () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    await channel.connect();

    await channel.sendApprovalRequest("chat-1", {
      id: "approval-det",
      tool: "shell",
      args: {},
      riskLevel: "medium",
      explanation: "Detail test"
    });

    const callback = bot.callbackHandlers[0];
    const match = "details:approval-det".match(callback.pattern as RegExp) ?? [];
    const answered: Array<{ text: string }> = [];
    const ctx = {
      match,
      from: { id: 99 },
      callbackQuery: { id: "cb-3" },
      answerCallbackQuery: async (opts: Record<string, unknown>) => { answered.push(opts as any); },
    } as unknown as Context;

    await callback.handler(ctx);
    expect(answered).toHaveLength(1);
    expect(answered[0].text).toContain("Detail test");
  });

  it("has correct channel id and type", () => {
    const bot = new MockBot();
    const channel = new TelegramChannel({ config: { botToken: "token" }, bot });
    expect(channel.id).toBe("telegram");
    expect(channel.type).toBe("telegram");
  });
});
