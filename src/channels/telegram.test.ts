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
});
