import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { SentinelService } from "../../sentinel/sentinel-service.js";

const sentinelControlSchema = z.object({
  action: z.enum(["status", "enable", "disable", "get_digest", "list_digests"]),
  model: z.string().optional().describe("Model override for Sentinel LLM calls"),
  limit: z.number().optional().describe("Max digest entries to return (for list_digests)"),
});

export type SentinelToolsOptions = {
  sentinelService: SentinelService;
};

export const createSentinelTools = ({ sentinelService }: SentinelToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "sentinel-control",
      description:
        "Monitor and control the autonomous SRE Sentinel daemon. Get system health, review task completion rates, retrieve daily digests, and enable/disable monitoring.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "enable", "disable", "get_digest", "list_digests"] },
          model: { type: "string" },
          limit: { type: "number" },
        },
        required: ["action"],
      },
      zodSchema: sentinelControlSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = sentinelControlSchema.parse(args);

          switch (input.action) {
            case "status":
              return { text: JSON.stringify(sentinelService.getStatus(), null, 2) };
            case "enable":
              await sentinelService.toggle(true);
              return { text: "Sentinel enabled." };
            case "disable":
              await sentinelService.toggle(false);
              return { text: "Sentinel disabled." };
            case "get_digest": {
              const digests = await sentinelService.getDigestHistory(1);
              if (!digests.length) return { text: "No digests available." };
              return { text: JSON.stringify(digests[0], null, 2) };
            }
            case "list_digests": {
              const digests = await sentinelService.getDigestHistory(input.limit ?? 10);
              return { text: JSON.stringify({ count: digests.length, digests }, null, 2) };
            }
            default:
              return { text: `Unknown action: ${input.action}`, isError: true };
          }
        } catch (err) {
          return { text: `Sentinel error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
