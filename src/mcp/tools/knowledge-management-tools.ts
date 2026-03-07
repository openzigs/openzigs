import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { KnowledgeIngestionService } from "../../knowledge/knowledge-service.js";

const manageKnowledgeSchema = z.object({
  action: z.enum(["ingest_text", "delete_document", "reindex", "reindex_all", "stats", "list_documents"]),
  document_id: z.string().optional().describe("Document ID (for delete/reindex)"),
  title: z.string().optional().describe("Document title (for ingest_text)"),
  text: z.string().optional().describe("Text content to ingest"),
});

export type KnowledgeManagementToolsOptions = {
  knowledgeService: KnowledgeIngestionService;
};

export const createKnowledgeManagementTools = ({
  knowledgeService,
}: KnowledgeManagementToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "manage-knowledge-base",
      description:
        "Write-side knowledge base management. Ingest text, delete documents, reindex, and get stats. Pairs with 'search-knowledge' for full read/write coverage.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["ingest_text", "delete_document", "reindex", "reindex_all", "stats", "list_documents"] },
          document_id: { type: "string" },
          title: { type: "string" },
          text: { type: "string" },
        },
        required: ["action"],
      },
      zodSchema: manageKnowledgeSchema,
      category: "knowledge",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = manageKnowledgeSchema.parse(args);

          switch (input.action) {
            case "ingest_text": {
              if (!input.document_id || !input.title || !input.text) {
                return { text: "'document_id', 'title', and 'text' are required.", isError: true };
              }
              await knowledgeService.ingestText(input.document_id, input.title, input.text);
              return { text: `Document '${input.document_id}' ingested successfully.` };
            }
            case "delete_document": {
              if (!input.document_id) return { text: "'document_id' is required.", isError: true };
              await knowledgeService.deleteDocument(input.document_id);
              return { text: `Document '${input.document_id}' deleted.` };
            }
            case "reindex": {
              if (!input.document_id) return { text: "'document_id' is required.", isError: true };
              await knowledgeService.reindexDocument(input.document_id);
              return { text: `Document '${input.document_id}' reindexed.` };
            }
            case "reindex_all": {
              await knowledgeService.reindexAll();
              return { text: "Full reindex started. This may take time for large knowledge bases." };
            }
            case "stats": {
              const stats = await knowledgeService.getStats();
              return { text: JSON.stringify(stats, null, 2) };
            }
            case "list_documents": {
              const docs = knowledgeService.listDocuments();
              return { text: JSON.stringify(docs, null, 2) };
            }
            default:
              return { text: `Unknown action: ${input.action}`, isError: true };
          }
        } catch (err) {
          return { text: `Knowledge error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
