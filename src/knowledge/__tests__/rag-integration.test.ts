/**
 * Tests for RAG integration enhancements:
 * - Visibility and category metadata on chunks
 * - Gallery asset ingestion and removal
 * - LanceDB filter clause building
 * - Knowledge search with filters
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LanceDBStore } from "../lancedb-store.js";
import type {
  KnowledgeVisibility,
  KnowledgeCategory,
  KnowledgeSearchFilter,
  IngestVirtualOptions,
} from "../types.js";

// ── LanceDBStore.buildFilterClause ──

describe("LanceDBStore.buildFilterClause", () => {
  it("returns undefined when no filter is provided", () => {
    expect(LanceDBStore.buildFilterClause(undefined)).toBeUndefined();
    expect(LanceDBStore.buildFilterClause({})).toBeUndefined();
  });

  it("builds a visibility filter clause", () => {
    const clause = LanceDBStore.buildFilterClause({ visibility: "public" });
    expect(clause).toBe("(visibility IN ('public') OR visibility IS NULL)");
  });

  it("builds a category filter clause for a single category", () => {
    const clause = LanceDBStore.buildFilterClause({ categories: ["media"] });
    expect(clause).toBe("(category IN ('media') OR category IS NULL)");
  });

  it("builds a category filter clause for multiple categories", () => {
    const clause = LanceDBStore.buildFilterClause({
      categories: ["media", "document", "presentation"],
    });
    expect(clause).toBe("(category IN ('media', 'document', 'presentation') OR category IS NULL)");
  });

  it("combines visibility and category filters with AND", () => {
    const clause = LanceDBStore.buildFilterClause({
      visibility: "public",
      categories: ["media"],
    });
    expect(clause).toBe(
      "(visibility IN ('public') OR visibility IS NULL) AND (category IN ('media') OR category IS NULL)",
    );
  });

  it("escapes single quotes in values", () => {
    const clause = LanceDBStore.buildFilterClause({
      visibility: "pub'lic" as KnowledgeVisibility,
    });
    expect(clause).toContain("pub''lic");
  });
});

// ── KnowledgeIngestionService (mocked store) ──

describe("KnowledgeIngestionService — asset ingestion", () => {
  let mockStore: {
    addChunks: ReturnType<typeof vi.fn>;
    deleteByDocumentId: ReturnType<typeof vi.fn>;
    searchByMode: ReturnType<typeof vi.fn>;
    countChunks: ReturnType<typeof vi.fn>;
    initialize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockStore = {
      addChunks: vi.fn().mockResolvedValue(undefined),
      deleteByDocumentId: vi.fn().mockResolvedValue(undefined),
      searchByMode: vi.fn().mockResolvedValue([]),
      countChunks: vi.fn().mockResolvedValue(0),
      initialize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("ingestText includes visibility and category in chunks", async () => {
    // We need to test that chunks passed to addChunks include the metadata fields.
    // This is a structural test — verifying the data shape rather than end-to-end LanceDB.
    const { KnowledgeIngestionService } = await import("../knowledge-service.js");

    const service = new KnowledgeIngestionService();
    // Access private store and replace with mock
    (service as unknown as { store: typeof mockStore }).store = mockStore;
    (service as unknown as { running: boolean }).running = true;

    // Mock embedder to avoid loading the model
    vi.mock("../embedder.js", () => ({
      generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0)),
      shutdownEmbedder: vi.fn(),
      getEmbeddingDim: vi.fn().mockReturnValue(384),
    }));

    const options: IngestVirtualOptions = {
      visibility: "public",
      category: "media",
      mediaUrl: "/api/queue/assets/test-123/file",
      assetId: "test-123",
    };

    await service.ingestText("test-doc", "Test Asset", "This is a test", options);

    expect(mockStore.addChunks).toHaveBeenCalledTimes(1);
    const chunks = mockStore.addChunks.mock.calls[0][0];
    expect(chunks.length).toBeGreaterThan(0);

    const firstChunk = chunks[0];
    expect(firstChunk.visibility).toBe("public");
    expect(firstChunk.category).toBe("media");
    expect(firstChunk.mediaUrl).toBe("/api/queue/assets/test-123/file");
  });

  it("ingestText defaults to internal/document when no options given", async () => {
    const { KnowledgeIngestionService } = await import("../knowledge-service.js");

    const service = new KnowledgeIngestionService();
    (service as unknown as { store: typeof mockStore }).store = mockStore;
    (service as unknown as { running: boolean }).running = true;

    await service.ingestText("doc-no-opts", "Plain Doc", "Some text content");

    expect(mockStore.addChunks).toHaveBeenCalledTimes(1);
    const chunks = mockStore.addChunks.mock.calls[0][0];
    expect(chunks[0].visibility).toBe("internal");
    expect(chunks[0].category).toBe("document");
  });

  it("ingestAsset creates a rich text representation", async () => {
    const { KnowledgeIngestionService } = await import("../knowledge-service.js");

    const service = new KnowledgeIngestionService();
    (service as unknown as { store: typeof mockStore }).store = mockStore;
    (service as unknown as { running: boolean }).running = true;

    await service.ingestAsset({
      id: "asset-abc",
      type: "audio",
      filename: "cool-song.mp3",
      prompt: "cinematic dark electronic music",
      model: "ace-step",
      tags: ["electronic", "cinematic"],
      source: "generated",
      durationSeconds: 120,
    });

    expect(mockStore.addChunks).toHaveBeenCalledTimes(1);
    const chunks = mockStore.addChunks.mock.calls[0][0];
    expect(chunks.length).toBeGreaterThan(0);

    const text = chunks[0].text;
    expect(text).toContain("cool-song.mp3");
    expect(text).toContain("cinematic dark electronic music");
    expect(text).toContain("ace-step");
    expect(text).toContain("electronic, cinematic");
    expect(text).toContain("🎵");

    expect(chunks[0].visibility).toBe("public");
    expect(chunks[0].category).toBe("media");
    expect(chunks[0].mediaUrl).toBe("/api/queue/assets/asset-abc/file");
  });

  it("ingestAsset creates image representation with markdown image syntax", async () => {
    const { KnowledgeIngestionService } = await import("../knowledge-service.js");

    const service = new KnowledgeIngestionService();
    (service as unknown as { store: typeof mockStore }).store = mockStore;
    (service as unknown as { running: boolean }).running = true;

    await service.ingestAsset({
      id: "img-001",
      type: "image",
      filename: "sunset.png",
      prompt: "A beautiful sunset over mountains",
      model: "flux-dev",
      source: "generated",
      width: 1024,
      height: 1024,
    });

    const chunks = mockStore.addChunks.mock.calls[0][0];
    const text = chunks[0].text;
    expect(text).toContain("![A beautiful sunset over mountains]");
    expect(text).toContain("/api/queue/assets/img-001/file");
    expect(text).toContain("1024x1024");
  });

  it("removeAsset deletes from store and documents map", async () => {
    const { KnowledgeIngestionService } = await import("../knowledge-service.js");

    const service = new KnowledgeIngestionService();
    (service as unknown as { store: typeof mockStore }).store = mockStore;
    (service as unknown as { running: boolean }).running = true;

    // First ingest an asset
    await service.ingestAsset({
      id: "to-remove",
      type: "video",
      filename: "demo.mp4",
      source: "generated",
    });

    expect(mockStore.addChunks).toHaveBeenCalledTimes(1);

    // Now remove it
    await service.removeAsset("to-remove");

    expect(mockStore.deleteByDocumentId).toHaveBeenCalledWith("asset:to-remove");

    // Verify it's gone from the documents map
    const docs = service.listDocuments();
    expect(docs.find((d) => d.id === "asset:to-remove")).toBeUndefined();
  });
});

// ── Search filter integration ──

describe("KnowledgeIngestionService — search with filters", () => {
  it("passes filter to store's searchByMode", async () => {
    const { KnowledgeIngestionService } = await import("../knowledge-service.js");

    const mockSearchByMode = vi.fn().mockResolvedValue([]);
    const service = new KnowledgeIngestionService();
    (service as unknown as { store: { searchByMode: typeof mockSearchByMode } }).store = {
      searchByMode: mockSearchByMode,
    } as unknown as { searchByMode: typeof mockSearchByMode };
    (service as unknown as { running: boolean }).running = true;

    await service.search("find songs", 10, {
      filter: { categories: ["media"], visibility: "public" },
    });

    expect(mockSearchByMode).toHaveBeenCalledTimes(1);
    const [, , , , sqlFilter] = mockSearchByMode.mock.calls[0];
    expect(sqlFilter).toContain("visibility IN ('public')");
    expect(sqlFilter).toContain("category IN ('media')");
  });

  it("passes no filter when filter is undefined", async () => {
    const { KnowledgeIngestionService } = await import("../knowledge-service.js");

    const mockSearchByMode = vi.fn().mockResolvedValue([]);
    const service = new KnowledgeIngestionService();
    (service as unknown as { store: { searchByMode: typeof mockSearchByMode } }).store = {
      searchByMode: mockSearchByMode,
    } as unknown as { searchByMode: typeof mockSearchByMode };
    (service as unknown as { running: boolean }).running = true;

    await service.search("anything");

    expect(mockSearchByMode).toHaveBeenCalledTimes(1);
    const [, , , , sqlFilter] = mockSearchByMode.mock.calls[0];
    expect(sqlFilter).toBeUndefined();
  });
});

// ── Types validation ──

describe("Knowledge types", () => {
  it("KnowledgeVisibility values are valid", () => {
    const valid: KnowledgeVisibility[] = ["public", "internal", "private"];
    expect(valid).toHaveLength(3);
  });

  it("KnowledgeCategory values are valid", () => {
    const valid: KnowledgeCategory[] = ["document", "media", "presentation", "social", "system", "conversation"];
    expect(valid).toHaveLength(6);
  });

  it("KnowledgeSearchFilter accepts valid combinations", () => {
    const filter: KnowledgeSearchFilter = {
      visibility: "public",
      categories: ["media", "document"],
    };
    expect(filter.visibility).toBe("public");
    expect(filter.categories).toHaveLength(2);
  });
});
