import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { OutboxRepository } from "../../outbox/outbox-repository.js";
import type { Server as SocketIOServer } from "socket.io";

const popNextQueueItemSchema = z.object({
  item_id: z.string().optional().describe(
    "Specific outbox item ID to retrieve. If omitted, returns the oldest processing item.",
  ),
});

const updateOutboxStatusSchema = z.object({
  item_id: z.string().describe("The outbox item ID"),
  status: z.enum(["published", "failed"]).describe("New status: published or failed"),
  published_url: z.string().optional().describe("URL of the published post (required when status=published)"),
  error: z.string().optional().describe("Error reason (required when status=failed)"),
});

export type OutboxToolsOptions = {
  outboxRepo: OutboxRepository;
  io?: SocketIOServer;
};

export const createOutboxTools = ({ outboxRepo, io }: OutboxToolsOptions): ToolDefinition[] => {
  const emitUpdate = () => {
    if (io) {
      io.emit("outbox:updated");
    }
  };

  return [
    {
      name: "pop-next-queue-item",
      description:
        "Retrieve the next outbox item in 'processing' status. Returns the asset URL, platform, agent context, and metadata for the Universal Publisher to execute. If item_id is provided, retrieves that specific item.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Specific outbox item ID to retrieve (optional)",
          },
        },
      },
      zodSchema: popNextQueueItemSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = popNextQueueItemSchema.parse(args);

          if (input.item_id) {
            const item = outboxRepo.getById(input.item_id);
            if (!item) {
              return { text: `Outbox item '${input.item_id}' not found.`, isError: true };
            }
            if (item.status !== "processing") {
              return {
                text: `Outbox item '${input.item_id}' is in '${item.status}' status, not 'processing'.`,
                isError: true,
              };
            }
            return { text: JSON.stringify(item, null, 2) };
          }

          // Get oldest processing item
          const items = outboxRepo.list({ status: "processing", limit: 1 });
          if (items.length === 0) {
            return { text: "No processing items in outbox queue." };
          }
          return { text: JSON.stringify(items[0], null, 2) };
        } catch (err) {
          return {
            text: `Error retrieving outbox item: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "update-outbox-status",
      description:
        "Update the status of an outbox queue item. Call with status='published' and the post URL on success, or status='failed' with an error reason if posting failed. Always call this before finishing a publish task.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "The outbox item ID" },
          status: {
            type: "string",
            enum: ["published", "failed"],
            description: "New status",
          },
          published_url: {
            type: "string",
            description: "URL of the published post (when status=published)",
          },
          error: {
            type: "string",
            description: "Error reason (when status=failed)",
          },
        },
        required: ["item_id", "status"],
      },
      zodSchema: updateOutboxStatusSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = updateOutboxStatusSchema.parse(args);

          if (input.status === "published") {
            const result = outboxRepo.markPublished(
              input.item_id,
              input.published_url ?? "",
            );
            if (!result) {
              return {
                text: `Failed to mark item '${input.item_id}' as published. Item may not exist or is not in 'processing' status.`,
                isError: true,
              };
            }
            emitUpdate();
            return {
              text: `Outbox item '${input.item_id}' marked as published. URL: ${input.published_url ?? "N/A"}`,
            };
          }

          if (input.status === "failed") {
            const result = outboxRepo.markFailed(
              input.item_id,
              input.error ?? "Unknown error",
            );
            if (!result) {
              return {
                text: `Failed to mark item '${input.item_id}' as failed. Item may not exist or is not in 'processing' status.`,
                isError: true,
              };
            }
            emitUpdate();
            return {
              text: `Outbox item '${input.item_id}' marked as failed. Error: ${input.error ?? "Unknown error"}`,
            };
          }

          return { text: `Invalid status: ${input.status}`, isError: true };
        } catch (err) {
          return {
            text: `Error updating outbox status: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
