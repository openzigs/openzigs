import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { Context } from "grammy";
import { convertMarkdown } from "./markdown.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  IncomingMessage,
  MessageChannel,
  MessageContent
} from "./types.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import type { Logger } from "winston";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

export type TelegramConfig = {
  botToken: string;
  webhookUrl?: string;
  adminUserId?: string;
};

type TelegramApiLike = {
  sendMessage: (chatId: string, text: string, options?: Record<string, unknown>) => Promise<unknown>;
  setWebhook?: (url: string) => Promise<unknown>;
  answerCallbackQuery?: (id: string, options?: Record<string, unknown>) => Promise<unknown>;
  editMessageText?: (chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => Promise<unknown>;
};

type TelegramBotLike = {
  token: string;
  api: TelegramApiLike;
  on: (event: string, handler: (ctx: Context) => Promise<void> | void) => void;
  command: (command: string, handler: (ctx: Context) => Promise<void> | void) => void;
  callbackQuery: (query: string | RegExp, handler: (ctx: Context) => Promise<void> | void) => void;
};

export type TelegramChannelOptions = {
  config: TelegramConfig;
  toolRegistry?: ToolRegistry;
  logger?: Logger;
  bot?: TelegramBotLike;
};

const splitTelegramMessage = (text: string) => {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + TELEGRAM_MAX_MESSAGE_LENGTH));
    offset += TELEGRAM_MAX_MESSAGE_LENGTH;
  }
  return chunks;
};

export class TelegramChannel implements MessageChannel {
  readonly id: string;
  readonly type = "telegram";
  private connected = false;
  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private approvalHandlers: Array<(response: ApprovalResponse) => void> = [];
  private bot: TelegramBotLike;
  private approvals = new Map<string, ApprovalRequest>();
  private toolRegistry?: ToolRegistry;
  private logger?: Logger;
  private webhookUrl?: string;
  private adminUserId?: string;

  constructor({ config, toolRegistry, logger, bot }: TelegramChannelOptions) {
    this.id = "telegram";
    const botInstance = bot ?? new Bot(config.botToken);
    this.bot = botInstance as TelegramBotLike;
    this.toolRegistry = toolRegistry;
    this.logger = logger;
    this.webhookUrl = config.webhookUrl;
    this.adminUserId = config.adminUserId;

    this.bot.command("start", async (ctx) => {
      await ctx.reply("Welcome to OpenZigs. Send a message to start chatting with the agent.");
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        [
          "Available commands:",
          "/start - Welcome message",
          "/help - Show this help",
          "/status - Show tool status",
          "/toggle <tool> <on|off> - Enable or disable a tool",
          "/cancel - Cancel the current operation"
        ].join("\n")
      );
    });

    this.bot.command("status", async (ctx) => {
      if (!this.toolRegistry) {
        await ctx.reply("Tool registry is not available.");
        return;
      }
      const groups = this.toolRegistry.getAllTools();
      const lines = Object.entries(groups).flatMap(([category, tools]) => {
        if (tools.length === 0) {
          return [];
        }
        return [
          `\n${category.toUpperCase()}`,
          ...tools.map((tool) => `- ${tool.name} (${tool.riskLevel}) ${tool.enabled ? "on" : "off"}`)
        ];
      });
      await ctx.reply(lines.join("\n").trim());
    });

    this.bot.command("toggle", async (ctx) => {
      if (!this.toolRegistry) {
        await ctx.reply("Tool registry is not available.");
        return;
      }
      const fromId = ctx.from?.id?.toString();
      if (this.adminUserId && fromId !== this.adminUserId) {
        await ctx.reply("Unauthorized");
        return;
      }
      const text = ctx.message?.text ?? "";
      const parts = text.trim().split(/\s+/);
      const toolName = parts[1];
      const state = parts[2];
      if (!toolName || !state) {
        await ctx.reply("Usage: /toggle <tool> <on|off>");
        return;
      }
      const enabled = state === "on";
      try {
        await this.toolRegistry.setEnabled(toolName, enabled);
        await ctx.reply(`${toolName} is now ${enabled ? "enabled" : "disabled"}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`Failed to update ${toolName}: ${message}`);
      }
    });

    this.bot.command("cancel", async (ctx) => {
      await ctx.reply("Nothing to cancel right now.");
    });

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message?.text;
      if (!text || text.startsWith("/")) {
        return;
      }
      const chatId = ctx.chat?.id?.toString();
      const userId = ctx.from?.id?.toString();
      if (!chatId || !userId) {
        return;
      }
      const incoming: IncomingMessage = {
        channelType: "telegram",
        channelId: this.id,
        chatId,
        userId,
        username: ctx.from?.username,
        content: text,
        attachments: [],
        timestamp: new Date((ctx.message?.date ?? Math.floor(Date.now() / 1000)) * 1000)
      };
      this.emitMessage(incoming);
    });

    this.bot.callbackQuery(/^(approve|reject|details):(.+)$/, async (ctx) => {
      const action = ctx.match?.[1];
      const approvalId = ctx.match?.[2];
      if (!approvalId || !action) {
        return;
      }

      if (action === "details") {
        const request = this.approvals.get(approvalId);
        const detailText = request?.preview
          ? `${request.preview}\n\n${request.explanation}`
          : request?.explanation ?? "No details available.";
        await ctx.answerCallbackQuery({ text: detailText, show_alert: true });
        return;
      }

      const approved = action === "approve";
      await ctx.answerCallbackQuery({
        text: approved ? "Approved" : "Rejected"
      });

      const response: ApprovalResponse = {
        approvalId,
        approved,
        decidedBy: ctx.from?.id?.toString(),
        decidedVia: "telegram",
        decidedAt: new Date()
      };
      this.emitApprovalResponse(response);
      this.approvals.delete(approvalId);

      const callbackMessage = ctx.callbackQuery?.message;
      const originalText = callbackMessage?.text ?? "";
      if (callbackMessage?.message_id && callbackMessage.chat?.id && this.bot.api.editMessageText) {
        await this.bot.api.editMessageText(
          callbackMessage.chat.id.toString(),
          callbackMessage.message_id,
          `${originalText}\n\nStatus: ${approved ? "APPROVED" : "REJECTED"}`,
          { parse_mode: "Markdown" }
        );
      }
    });
  }

  async connect(): Promise<void> {
    this.connected = true;
    if (this.webhookUrl && this.bot.api.setWebhook) {
      try {
        await this.bot.api.setWebhook(this.webhookUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn(`Failed to set Telegram webhook: ${message}`);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onApprovalResponse(handler: (response: ApprovalResponse) => void): void {
    this.approvalHandlers.push(handler);
  }

  async sendMessage(chatId: string, content: MessageContent): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
    const rawText = content.markdown ? convertMarkdown(content.text, "telegram") : content.text;
    const chunks = splitTelegramMessage(rawText);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk, content.markdown ? { parse_mode: "Markdown" } : undefined);
    }
  }

  async sendApprovalRequest(chatId: string, request: ApprovalRequest): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
    this.approvals.set(request.id, request);

    const keyboard = new InlineKeyboard()
      .text("Approve", `approve:${request.id}`)
      .text("Reject", `reject:${request.id}`)
      .row()
      .text("Details", `details:${request.id}`);

    const message = convertMarkdown(
      [
        "Permission Required",
        `Tool: ${request.tool}`,
        `Risk: ${request.riskLevel === "high" ? "HIGH" : "MEDIUM"}`,
        `Reason: ${request.explanation}`
      ].join("\n"),
      "telegram"
    );

    await this.bot.api.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: keyboard
    });
  }

  getWebhookCallback() {
    return webhookCallback(this.bot as Bot, "express");
  }

  private emitMessage(message: IncomingMessage) {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  private emitApprovalResponse(response: ApprovalResponse) {
    for (const handler of this.approvalHandlers) {
      handler(response);
    }
  }
}

export { splitTelegramMessage };
