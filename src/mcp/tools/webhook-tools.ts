import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { WebhookManager } from "../../webhooks/webhook-manager.js";

const manageWebhooksSchema = z.object({
  action: z.enum(["create", "list", "get", "delete", "toggle"]),
  id: z.string().optional().describe("Webhook ID"),
  name: z.string().optional().describe("Webhook name (for create)"),
  action_type: z.enum(["prompt", "goal"]).optional().describe("What to execute on trigger"),
  action_payload: z.record(z.unknown()).optional().describe("Payload for the triggered action"),
  allowed_ips: z.array(z.string()).optional().describe("IP allowlist (CIDR)"),
  rate_limit: z.number().optional().describe("Max requests/minute (0 = unlimited)"),
  enabled: z.boolean().optional().describe("Enable/disable (for toggle)"),
});

export type WebhookToolsOptions = {
  webhookManager: WebhookManager;
};

export const createWebhookTools = ({ webhookManager }: WebhookToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "manage-webhooks",
      description:
        "Create, list, enable/disable, and delete inbound webhooks. Webhooks trigger prompt execution or goal-based agent tasks when called from external systems.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "list", "get", "delete", "toggle"] },
          id: { type: "string" },
          name: { type: "string" },
          action_type: { type: "string", enum: ["prompt", "goal"] },
          action_payload: { type: "object" },
          allowed_ips: { type: "array", items: { type: "string" } },
          rate_limit: { type: "number" },
          enabled: { type: "boolean" },
        },
        required: ["action"],
      },
      zodSchema: manageWebhooksSchema,
      category: "productivity",
      riskLevel: "high",
      handler: async (args) => {
        try {
          const input = manageWebhooksSchema.parse(args);

          switch (input.action) {
            case "create": {
              if (!input.name || !input.action_type || !input.action_payload) {
                return { text: "'name', 'action_type', and 'action_payload' are required.", isError: true };
              }
              const result = webhookManager.create({
                name: input.name,
                action: input.action_type,
                actionPayload: input.action_payload,
                allowedIps: input.allowed_ips,
                rateLimit: input.rate_limit ?? 10,
              });
              return {
                text: JSON.stringify({
                  webhook: result.webhook,
                  api_key: result.apiKey,
                  note: "Save this API key — it is shown only once.",
                }, null, 2),
              };
            }
            case "list":
              return { text: JSON.stringify(webhookManager.list(), null, 2) };
            case "get": {
              if (!input.id) return { text: "'id' is required.", isError: true };
              const wh = webhookManager.get(input.id);
              if (!wh) return { text: `Webhook '${input.id}' not found.`, isError: true };
              return { text: JSON.stringify(wh, null, 2) };
            }
            case "delete": {
              if (!input.id) return { text: "'id' is required.", isError: true };
              const deleted = webhookManager.delete(input.id);
              if (!deleted) return { text: `Webhook '${input.id}' not found.`, isError: true };
              return { text: `Webhook '${input.id}' deleted.` };
            }
            case "toggle": {
              if (!input.id || input.enabled === undefined) {
                return { text: "'id' and 'enabled' are required.", isError: true };
              }
              const toggled = webhookManager.toggle(input.id, input.enabled);
              if (!toggled) return { text: `Webhook '${input.id}' not found.`, isError: true };
              return { text: JSON.stringify(toggled, null, 2) };
            }
            default:
              return { text: `Unknown action: ${input.action}`, isError: true };
          }
        } catch (err) {
          return { text: `Webhook error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
