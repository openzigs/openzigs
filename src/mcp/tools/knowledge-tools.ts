/**
 * Knowledge Base MCP tool — `search-knowledge`.
 *
 * Provides semantic, keyword, and hybrid search over the local knowledge base.
 * Always-on tool (included regardless of tool limits).
 * Low risk — read-only operation, no approval required.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { KnowledgeIngestionService, KnowledgeCategory, KnowledgeVisibility } from "../../knowledge/index.js";

const searchKnowledgeSchema = z.object({
  query: z.string().describe("Semantic search query to find relevant knowledge"),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results (default: 10)"),
  mode: z.enum(["vector", "fts", "hybrid"]).optional().describe(
    "Search mode: 'vector' (semantic similarity), 'fts' (keyword match), 'hybrid' (combined, default)",
  ),
  category: z.enum(["document", "media", "presentation", "social", "system", "conversation"]).optional().describe(
    "Filter by content category. Use 'media' to find images, videos, audio, and music from the gallery.",
  ),
  visibility: z.enum(["public", "internal", "private"]).optional().describe(
    "Filter by visibility level. 'public' = safe for external sharing, 'internal' = user only.",
  ),
});

type SearchKnowledgeInput = z.infer<typeof searchKnowledgeSchema>;

export type KnowledgeToolsOptions = {
  knowledgeService: KnowledgeIngestionService;
};

export const createKnowledgeTools = (options: KnowledgeToolsOptions): ToolDefinition[] => {
  const { knowledgeService } = options;

  const searchKnowledgeTool: ToolDefinition = {
    name: "search-knowledge",
    description:
      "Search the local knowledge base using semantic similarity, keyword match, or hybrid (combined). " +
      "Returns relevant text chunks from indexed documents, media assets (images, videos, audio, music), " +
      "presentations, social media interactions, and system events. " +
      "Use this to find relevant context, gallery assets (songs, images, videos), documentation, " +
      "notes, or code snippets from the user's knowledge base. " +
      "When results include media assets, use the provided media URL to show/play them inline. " +
      "For audio: use [🎵 filename](url). For video: use [🎬 filename](url). For images: use ![alt](url). " +
      "Supports category filtering: 'media' for gallery assets, 'document' for files, " +
      "'presentation' for presentations, 'social' for social interactions, 'system' for scheduled jobs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Semantic search query to find relevant knowledge",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
        mode: {
          type: "string",
          enum: ["vector", "fts", "hybrid"],
          description: "Search mode: 'vector' (semantic), 'fts' (keyword), 'hybrid' (combined, default)",
        },
        category: {
          type: "string",
          enum: ["document", "media", "presentation", "social", "system", "conversation"],
          description: "Filter by content category. Use 'media' to find gallery assets.",
        },
        visibility: {
          type: "string",
          enum: ["public", "internal", "private"],
          description: "Filter by visibility level.",
        },
      },
      required: ["query"],
    },
    zodSchema: searchKnowledgeSchema,
    category: "knowledge",
    riskLevel: "low",
    handler: async (args: Record<string, unknown>) => {
      const input = args as SearchKnowledgeInput;
      const limit = input.limit ?? 10;
      const mode = input.mode as import("../../knowledge/types.js").KnowledgeSearchMode | undefined;

      const filter: import("../../knowledge/types.js").KnowledgeSearchFilter = {};
      if (input.category) filter.categories = [input.category as KnowledgeCategory];
      if (input.visibility) filter.visibility = input.visibility as KnowledgeVisibility;
      const hasFilter = Object.keys(filter).length > 0;

      try {
        const results = await knowledgeService.search(input.query, limit, {
          mode,
          filter: hasFilter ? filter : undefined,
        });

        if (results.length === 0) {
          return {
            text: `No knowledge base results found for query: "${input.query}". The knowledge base may be empty or the query did not match any indexed content.`,
          };
        }

        // Check which documents have keyframe images available
        const docIds = [...new Set(results.map((r) => r.documentId))];
        const keyframeAvailability = new Map<string, boolean>();
        if (typeof knowledgeService.getKeyframeManifest === "function") {
          for (const docId of docIds) {
            try {
              const manifest = await knowledgeService.getKeyframeManifest(docId);
              keyframeAvailability.set(docId, manifest !== null);
            } catch {
              keyframeAvailability.set(docId, false);
            }
          }
        }

        const modeLabel = mode ?? "hybrid";
        const filterLabel = input.category ? ` [category: ${input.category}]` : "";
        const formatted = results.map((result, i) => {
          const heading = result.sectionHeading ? ` (${result.sectionHeading})` : "";
          const score = Math.round(result.score * 100);
          const catLabel = result.category ? ` [${result.category}]` : "";
          const hasKeyframes = keyframeAvailability.get(result.documentId);
          const keyframeNote = hasKeyframes
            ? `\nKeyframe images available for this video. ` +
              `To show images to the user, use markdown image syntax: ` +
              `![description](/api/admin/knowledge/keyframes/${result.documentId}/{frameIndex}) ` +
              `where frameIndex is 0-based. List frames via GET /api/admin/knowledge/keyframes/${result.documentId}`
            : "";

          // Include media URL instructions for gallery assets
          const mediaNote = result.mediaUrl
            ? `\nMedia URL: ${result.mediaUrl} — Use this to show/play the asset inline.`
            : "";

          return [
            `--- Result ${i + 1} [${score}% relevance]${catLabel} ---`,
            `Source: ${result.sourcePath}${heading}`,
            ...(keyframeNote ? [keyframeNote] : []),
            ...(mediaNote ? [mediaNote] : []),
            "",
            result.text,
          ].join("\n");
        });

        const header = `Found ${results.length} result(s) for "${input.query}" (${modeLabel} search)${filterLabel}:`;
        return { text: [header, "", ...formatted].join("\n") };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          text: `Knowledge search failed: ${msg}`,
          isError: true,
        };
      }
    },
  };

  return [searchKnowledgeTool];
};
