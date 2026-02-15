import { describe, expect, it, vi, beforeEach } from "vitest";
import { createKnowledgeTools } from "./knowledge-tools.js";
import type { KnowledgeIngestionService } from "../../knowledge/index.js";
import type { KnowledgeSearchResult } from "../../knowledge/types.js";

const createMockService = () => ({
  search: vi.fn<(query: string, limit: number) => Promise<KnowledgeSearchResult[]>>(),
  start: vi.fn(),
  stop: vi.fn(),
  getStats: vi.fn(),
  listDocuments: vi.fn(),
  reindexDocument: vi.fn(),
  reindexAll: vi.fn(),
  deleteDocument: vi.fn(),
  getConfig: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
}) as unknown as KnowledgeIngestionService;

describe("search-knowledge tool", () => {
  let mockService: KnowledgeIngestionService;

  beforeEach(() => {
    mockService = createMockService();
  });

  it("creates a tool named search-knowledge", () => {
    const tools = createKnowledgeTools({ knowledgeService: mockService });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search-knowledge");
    expect(tools[0].category).toBe("knowledge");
    expect(tools[0].riskLevel).toBe("low");
  });

  it("returns formatted results on successful search", async () => {
    const results: KnowledgeSearchResult[] = [
      {
        text: "TypeScript is a typed superset of JavaScript.",
        sourcePath: "docs/typescript.md",
        score: 0.85,
        sectionHeading: "Introduction",
        documentId: "abc123",
        chunkIndex: 0,
      },
    ];
    (mockService.search as ReturnType<typeof vi.fn>).mockResolvedValue(results);

    const tools = createKnowledgeTools({ knowledgeService: mockService });
    const handler = tools[0].handler;
    const result = await handler({ query: "typescript", limit: 5 });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("typescript.md");
    expect(result.text).toContain("85% relevance");
    expect(result.text).toContain("TypeScript is a typed superset");
  });

  it("returns message when no results found", async () => {
    (mockService.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const tools = createKnowledgeTools({ knowledgeService: mockService });
    const result = await tools[0].handler({ query: "nonexistent topic" });

    expect(result.text).toContain("No knowledge base results found");
  });

  it("returns error on search failure", async () => {
    (mockService.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB connection failed"));

    const tools = createKnowledgeTools({ knowledgeService: mockService });
    const result = await tools[0].handler({ query: "test" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("DB connection failed");
  });

  it("uses default limit of 10", async () => {
    (mockService.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const tools = createKnowledgeTools({ knowledgeService: mockService });
    await tools[0].handler({ query: "test" });

    expect(mockService.search).toHaveBeenCalledWith("test", 10, { mode: undefined });
  });

  it("passes mode to search when specified", async () => {
    (mockService.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const tools = createKnowledgeTools({ knowledgeService: mockService });
    await tools[0].handler({ query: "test", mode: "fts" });

    expect(mockService.search).toHaveBeenCalledWith("test", 10, { mode: "fts" });
  });
});
