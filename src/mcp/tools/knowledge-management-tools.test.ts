import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKnowledgeManagementTools } from "./knowledge-management-tools.js";
import type { KnowledgeIngestionService } from "../../knowledge/knowledge-service.js";

function createMockService(overrides: Partial<KnowledgeIngestionService> = {}): KnowledgeIngestionService {
  return {
    ingestText: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    reindexDocument: vi.fn().mockResolvedValue(undefined),
    reindexAll: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ totalDocuments: 5, totalChunks: 50 }),
    listDocuments: vi.fn().mockReturnValue([{ id: "d1", title: "Test Doc" }]),
    ...overrides,
  } as unknown as KnowledgeIngestionService;
}

function getHandler(overrides: Partial<KnowledgeIngestionService> = {}) {
  const service = createMockService(overrides);
  const tools = createKnowledgeManagementTools({ knowledgeService: service });
  return { handler: tools[0].handler, service };
}

describe("knowledge-management-tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates tool with correct metadata", () => {
    const tools = createKnowledgeManagementTools({ knowledgeService: createMockService() });
    expect(tools[0].name).toBe("manage-knowledge-base");
    expect(tools[0].riskLevel).toBe("medium");
  });

  it("ingest_text ingests document", async () => {
    const { handler, service } = getHandler();
    const result = await handler({
      action: "ingest_text",
      document_id: "d1",
      title: "Test",
      text: "Content",
    });
    expect(service.ingestText).toHaveBeenCalledWith("d1", "Test", "Content");
    expect(result.text).toContain("ingested");
  });

  it("ingest_text requires all fields", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "ingest_text", document_id: "d1" });
    expect(result.isError).toBe(true);
  });

  it("delete_document deletes", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "delete_document", document_id: "d1" });
    expect(service.deleteDocument).toHaveBeenCalledWith("d1");
    expect(result.text).toContain("deleted");
  });

  it("delete_document requires id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "delete_document" });
    expect(result.isError).toBe(true);
  });

  it("reindex reindexes single doc", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "reindex", document_id: "d1" });
    expect(service.reindexDocument).toHaveBeenCalledWith("d1");
    expect(result.text).toContain("reindexed");
  });

  it("reindex requires id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "reindex" });
    expect(result.isError).toBe(true);
  });

  it("reindex_all triggers full reindex", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "reindex_all" });
    expect(service.reindexAll).toHaveBeenCalled();
    expect(result.text).toContain("Full reindex");
  });

  it("stats returns knowledge base stats", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "stats" });
    const parsed = JSON.parse(result.text);
    expect(parsed.totalDocuments).toBe(5);
  });

  it("list_documents returns docs", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "list_documents" });
    const parsed = JSON.parse(result.text);
    expect(parsed[0].id).toBe("d1");
  });

  it("handles errors gracefully", async () => {
    const { handler } = getHandler({
      ingestText: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const result = await handler({
      action: "ingest_text",
      document_id: "d1",
      title: "T",
      text: "C",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("DB error");
  });
});
