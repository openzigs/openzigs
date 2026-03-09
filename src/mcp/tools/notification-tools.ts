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
};

export const createNotificationTools = ({ channelManager, fallbackChatId }: NotificationToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "send-notification",
      description:
        "Send a notification message to the configured admin Telegram chat. Use this as the final step when completing a long-running task to inform the user of completion.",
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

        const telegram = channelManager.getChannel("telegram");
        if (!telegram) {
          logger.warn("send-notification: Telegram channel not registered, skipping notification");
          return { text: "Telegram channel not connected — notification skipped." };
        }

        const chatId = fallbackChatId;
        if (!chatId) {
          logger.warn("send-notification: No admin chat ID configured, skipping notification");
          return { text: "No admin chat ID configured — notification skipped." };
        }

        try {
          await telegram.sendMessage(chatId, { text: input.message });
          logger.info(`send-notification: sent to Telegram chat ${chatId}`);
          return { text: `Notification sent: ${input.message}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`send-notification: failed to send — ${msg}`);
          return { text: `Failed to send notification: ${msg}`, isError: true };
        }
      },
    },
  ];
};
