import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import type { ButtonInteraction, Message } from "discord.js";
import { convertMarkdown } from "./markdown.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  IncomingMessage,
  MessageChannel,
  MessageContent
} from "./types.js";
import type { Logger } from "winston";

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export type DiscordConfig = {
  botToken: string;
  allowedGuilds: string[];
};

type DiscordTextChannelLike = {
  isTextBased: () => boolean;
  send: (options: { content: string; components?: Array<ActionRowBuilder<ButtonBuilder>> }) => Promise<unknown>;
};

type DiscordClientLike = {
  on: (event: "messageCreate" | "interactionCreate", handler: (payload: unknown) => void) => void;
  login: (token: string) => Promise<unknown>;
  destroy: () => void;
  channels: {
    fetch: (id: string) => Promise<DiscordTextChannelLike | null>;
  };
};

export type DiscordChannelOptions = {
  config: DiscordConfig;
  logger?: Logger;
  client?: DiscordClientLike;
};

const splitDiscordMessage = (text: string) => {
  if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + DISCORD_MAX_MESSAGE_LENGTH));
    offset += DISCORD_MAX_MESSAGE_LENGTH;
  }
  return chunks;
};

export class DiscordChannel implements MessageChannel {
  readonly id: string;
  readonly type = "discord";
  private connected = false;
  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private approvalHandlers: Array<(response: ApprovalResponse) => void> = [];
  private client: DiscordClientLike;
  private logger?: Logger;
  private allowedGuilds: string[];
  private botToken: string;

  constructor({ config, logger, client }: DiscordChannelOptions) {
    this.id = "discord";
    const clientInstance = client ?? new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.Guilds
      ],
      partials: [Partials.Channel]
    });

    this.client = clientInstance as DiscordClientLike;
    this.logger = logger;
    this.allowedGuilds = config.allowedGuilds;
    this.botToken = config.botToken;

    this.client.on("messageCreate", (payload) => {
      const message = payload as Message;
      if (message.author?.bot) {
        return;
      }
      const text = message.content?.trim();
      if (!text || text.startsWith("/")) {
        return;
      }
      if (message.channel?.isDMBased()) {
        this.emitMessage(this.toIncomingMessage(message));
        return;
      }
      if (message.guildId && this.allowedGuilds.includes(message.guildId)) {
        this.emitMessage(this.toIncomingMessage(message));
      }
    });

    this.client.on("interactionCreate", async (payload) => {
      const interaction = payload as ButtonInteraction;
      if (!interaction.isButton()) {
        return;
      }

      const [action, approvalId] = interaction.customId.split(":");
      if (!approvalId || (action !== "approve" && action !== "reject")) {
        return;
      }

      const approved = action === "approve";
      const response: ApprovalResponse = {
        approvalId,
        approved,
        decidedBy: interaction.user?.id,
        decidedVia: "discord",
        decidedAt: new Date()
      };
      this.emitApprovalResponse(response);
      const originalText = interaction.message?.content ?? "";
      await interaction.update({
        content: `${originalText}\n\nStatus: ${approved ? "APPROVED" : "REJECTED"}`,
        components: []
      });
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    try {
      await this.client.login(this.getToken());
      this.connected = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Failed to connect Discord client: ${message}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    this.client.destroy();
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
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const rawText = content.markdown ? convertMarkdown(content.text, "discord") : content.text;
    const chunks = splitDiscordMessage(rawText);
    for (const chunk of chunks) {
      await channel.send({ content: chunk });
    }
  }

  async sendApprovalRequest(chatId: string, request: ApprovalRequest): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve:${request.id}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject:${request.id}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger)
    );

    const message = convertMarkdown(
      [
        "Permission Required",
        `Tool: ${request.tool}`,
        `Risk: ${request.riskLevel === "high" ? "HIGH" : "MEDIUM"}`,
        `Reason: ${request.explanation}`
      ].join("\n"),
      "discord"
    );

    await channel.send({
      content: message,
      components: [row]
    });
  }

  private getToken() {
    return this.botToken;
  }

  private toIncomingMessage(message: Message): IncomingMessage {
    return {
      channelType: "discord",
      channelId: message.channelId,
      chatId: message.channelId,
      userId: message.author.id,
      username: message.author.username,
      content: message.content,
      attachments: [],
      timestamp: message.createdAt
    };
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

export { splitDiscordMessage };
