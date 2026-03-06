import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { MediaQueueRepository } from "../../queue/media-queue-repository.js";

const queryGalleryAssetsSchema = z.object({
  type: z.enum(["image", "video", "audio"]).optional().describe("Filter by asset type"),
  source: z.enum(["generated", "uploaded", "ingested"]).optional().describe("Filter by asset source"),
  project_id: z.string().optional().describe("Filter by project ID"),
  search: z.string().optional().describe("Full-text search across prompt, filename, and tags"),
  model: z.string().optional().describe("Filter by generation model (e.g., 'flux-schnell', 'ltx-2')"),
  asset_id: z.string().optional().describe("Get a single asset by ID instead of listing"),
  limit: z.number().min(1).max(100).optional().describe("Maximum results (default: 20, max: 100)"),
  offset: z.number().min(0).optional().describe("Pagination offset"),
});

export type GalleryToolsOptions = {
  mediaQueueRepo: MediaQueueRepository;
};

export const createGalleryTools = ({ mediaQueueRepo }: GalleryToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "query-gallery-assets",
      description:
        "Search and filter media assets in the OpenZigs Gallery database. Returns matching images, videos, and audio files with metadata including prompt, model, file path, and generation parameters. Use this to find existing media before generating new content.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["image", "video", "audio"] },
          source: { type: "string", enum: ["generated", "uploaded", "ingested"] },
          project_id: { type: "string" },
          search: { type: "string", description: "Full-text search across prompt, filename, tags" },
          model: { type: "string" },
          asset_id: { type: "string", description: "Get single asset by ID" },
          limit: { type: "number", description: "Max results (default 20, max 100)" },
          offset: { type: "number" },
        },
      },
      zodSchema: queryGalleryAssetsSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = queryGalleryAssetsSchema.parse(args);

          if (input.asset_id) {
            const asset = mediaQueueRepo.getAsset(input.asset_id);
            if (!asset) return { text: `Asset '${input.asset_id}' not found.`, isError: true };
            return { text: JSON.stringify(asset, null, 2) };
          }

          let results = mediaQueueRepo.listAssets({
            type: input.type,
            source: input.source,
            projectId: input.project_id,
            limit: input.limit ?? 20,
            offset: input.offset ?? 0,
          });

          if (input.model) {
            results = results.filter(
              (a: Record<string, unknown>) =>
                typeof a.model === "string" && a.model.toLowerCase().includes(input.model!.toLowerCase()),
            );
          }

          if (input.search) {
            const q = input.search.toLowerCase();
            results = results.filter((a: Record<string, unknown>) => {
              const haystack = [a.prompt, a.filename, a.tags].filter(Boolean).join(" ").toLowerCase();
              return haystack.includes(q);
            });
          }

          return { text: JSON.stringify({ count: results.length, assets: results }, null, 2) };
        } catch (err) {
          return { text: `Error querying gallery: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
