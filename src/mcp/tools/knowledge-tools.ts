/**
 * Knowledge Base MCP tool — `search-knowledge`.
 *
 * Provides semantic search over the local knowledge base.
 * Always-on tool (included regardless of tool limits).
 * Low risk — read-only operation, no approval required.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { KnowledgeIngestionService } from "../../knowledge/index.js";

const searchKnowledgeSchema = z.object({
  query: z.string().describe("Semantic search query to find relevant knowledge"),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results (default: 10)"),
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
      "Search the local knowledge base using semantic similarity. " +
      "Returns relevant text chunks from indexed documents (markdown, code, text files, etc.) " +
      "stored in the knowledge directory. Use this to find relevant context, documentation, " +
      "notes, or code snippets from the user's personal knowledge base.",
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
      },
      required: ["query"],
    },
    zodSchema: searchKnowledgeSchema,
    category: "knowledge",
    riskLevel: "low",
    handler: async (args: Record<string, unknown>) => {
      const input = args as SearchKnowledgeInput;
      const limit = input.limit ?? 10;

      try {
        const results = await knowledgeService.search(input.query, limit);

        if (results.length === 0) {
          return {
            text: `No knowledge base results found for query: "${input.query}". The knowledge base may be empty or the query did not match any indexed content.`,
          };
        }

        const formatted = results.map((result, i) => {
          const heading = result.sectionHeading ? ` (${result.sectionHeading})` : "";
          const score = (result.score * 100).toFixed(1);
          return [
            `--- Result ${i + 1} [${score}% match] ---`,
            `Source: ${result.sourcePath}${heading}`,
            "",
            result.text,
          ].join("\n");
        });

        const header = `Found ${results.length} result(s) for "${input.query}":`;
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
