/**
 * Knowledge Base MCP tool — `search-knowledge`.
 *
 * Provides semantic, keyword, and hybrid search over the local knowledge base.
 * Always-on tool (included regardless of tool limits).
 * Low risk — read-only operation, no approval required.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { KnowledgeIngestionService } from "../../knowledge/index.js";

const searchKnowledgeSchema = z.object({
  query: z.string().describe("Semantic search query to find relevant knowledge"),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results (default: 10)"),
  mode: z.enum(["vector", "fts", "hybrid"]).optional().describe(
    "Search mode: 'vector' (semantic similarity), 'fts' (keyword match), 'hybrid' (combined, default)",
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
      "Returns relevant text chunks from indexed documents (markdown, code, text files, etc.) " +
      "stored in the knowledge directory. Use this to find relevant context, documentation, " +
      "notes, or code snippets from the user's personal knowledge base. " +
      "Supports three modes: 'hybrid' (default — combines semantic + keyword for best results), " +
      "'vector' (pure semantic similarity), and 'fts' (keyword/full-text search).",
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

      try {
        const results = await knowledgeService.search(input.query, limit, { mode });

        if (results.length === 0) {
          return {
            text: `No knowledge base results found for query: "${input.query}". The knowledge base may be empty or the query did not match any indexed content.`,
          };
        }

        const modeLabel = mode ?? "hybrid";
        const formatted = results.map((result, i) => {
          const heading = result.sectionHeading ? ` (${result.sectionHeading})` : "";
          const score = Math.round(result.score * 100);
          return [
            `--- Result ${i + 1} [${score}% relevance] ---`,
            `Source: ${result.sourcePath}${heading}`,
            "",
            result.text,
          ].join("\n");
        });

        const header = `Found ${results.length} result(s) for "${input.query}" (${modeLabel} search):`;
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
