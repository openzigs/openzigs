import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { ChannelManager } from "../../channels/channel-manager.js";
import { logger } from "../../logging/logger.js";

const sendNotificationSchema = z.object({
  message: z.string().min(1).max(4096).describe("The notification message to send"),
});

type SendNotificationInput = z.infer<typeof sendNotificationSchema>;

export type NotificationToolsOptions = {
  channelManager: ChannelManager;
  /** Telegram chat ID to send to. Uses config adminUserId if omitted. */
  fallbackChatId?: string;
  /** Discord channel ID for notifications. */
  discordNotificationChannelId?: string;
};

export const createNotificationTools = ({ channelManager, fallbackChatId, discordNotificationChannelId }: NotificationToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "send-notification",
      description:
        "Send a notification message to configured channels (Telegram and/or Discord). Use this as the final step when completing a long-running task to inform the user of completion.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The notification message to send (e.g. 'Research document saved: files/research/topic.md')",
          },
        },
        required: ["message"],
      },
      zodSchema: sendNotificationSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = sendNotificationSchema.parse(args) as SendNotificationInput;
        const results: string[] = [];

        // Try Telegram
        const telegram = channelManager.getChannel("telegram");
        if (telegram && fallbackChatId) {
          try {
            await telegram.sendMessage(fallbackChatId, { text: input.message });
            logger.info(`send-notification: sent to Telegram chat ${fallbackChatId}`);
            results.push("Telegram: sent");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`send-notification: Telegram failed — ${msg}`);
            results.push(`Telegram: failed (${msg})`);
          }
        }

        // Try Discord
        const discord = channelManager.getChannel("discord");
        if (discord && discordNotificationChannelId) {
          try {
            await discord.sendMessage(discordNotificationChannelId, { text: input.message });
            logger.info(`send-notification: sent to Discord channel ${discordNotificationChannelId}`);
            results.push("Discord: sent");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`send-notification: Discord failed — ${msg}`);
            results.push(`Discord: failed (${msg})`);
          }
        }

        if (results.length === 0) {
          logger.warn("send-notification: No notification channels configured, skipping");
          return { text: "No notification channels configured — notification skipped." };
        }

        return { text: `Notification: ${results.join("; ")}` };
      },
    },
  ];
};
