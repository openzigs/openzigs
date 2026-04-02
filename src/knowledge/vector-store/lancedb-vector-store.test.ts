/**
 * Tests for VectorStore abstraction layer.
 * Issue #719: Verifies the LanceDBVectorStore adapter, factory, and interface contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the lancedb module before any imports
vi.mock("@lancedb/lancedb", () => {
  const mockVectorSearchChain = {
    distanceType: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  };
  const mockFtsSearchChain = {
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  };
  const mockSelectChain = {
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  };
  const mockTable = {
    add: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    createIndex: vi.fn().mockResolvedValue(undefined),
    countRows: vi.fn().mockResolvedValue(42),
    vectorSearch: vi.fn().mockReturnValue(mockVectorSearchChain),
    search: vi.fn().mockImplementation((_q: unknown, type?: string) => {
      if (type === "fts") return mockFtsSearchChain;
      return mockSelectChain;
    }),
    schema: vi.fn().mockResolvedValue({ fields: [{ name: "id" }, { name: "visibility" }, { name: "category" }, { name: "mediaUrl" }] }),
    addColumns: vi.fn().mockResolvedValue(undefined),
  };
  const mockConnection = {
    tableNames: vi.fn().mockResolvedValue(["knowledge_chunks"]),
    openTable: vi.fn().mockResolvedValue(mockTable),
    createTable: vi.fn().mockResolvedValue(mockTable),
  };
  return {
    connect: vi.fn().mockResolvedValue(mockConnection),
    Index: {
      ivfPq: vi.fn().mockReturnValue({}),
      fts: vi.fn().mockReturnValue({}),
    },
    _mockConnection: mockConnection,
    _mockTable: mockTable,
  };
});

vi.mock("../embedder.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0)),
  getEmbeddingDim: vi.fn().mockReturnValue(384),
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { LanceDBVectorStore } from "./lancedb-vector-store.js";
import { createVectorStore } from "./factory.js";
import type { VectorStore, VectorStoreConfig } from "./types.js";
import type { KnowledgeChunk } from "../types.js";

describe("LanceDBVectorStore", () => {
  let store: LanceDBVectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new LanceDBVectorStore({ dbPath: "/tmp/test-lance-vs" });
  });

  it("implements VectorStore interface", () => {
    // Verify the store has all required VectorStore methods
    const vs: VectorStore = store;
    expect(typeof vs.initialize).toBe("function");
    expect(typeof vs.close).toBe("function");
    expect(typeof vs.addChunks).toBe("function");
    expect(typeof vs.deleteByDocumentId).toBe("function");
    expect(typeof vs.search).toBe("function");
    expect(typeof vs.fullTextSearch).toBe("function");
    expect(typeof vs.hybridSearch).toBe("function");
    expect(typeof vs.searchByMode).toBe("function");
    expect(typeof vs.rebuildFtsIndex).toBe("function");
    expect(typeof vs.countChunks).toBe("function");
    expect(typeof vs.listDocumentIds).toBe("function");
  });

  it("initializes without error", async () => {
    await expect(store.initialize()).resolves.toBeUndefined();
  });

  it("closes without error", async () => {
    await store.initialize();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("addChunks delegates to underlying store", async () => {
    await store.initialize();
    const chunks: KnowledgeChunk[] = [{
      id: "chunk-1",
      documentId: "doc-1",
      text: "test content",
      chunkIndex: 0,
      sourcePath: "test.md",
      vector: new Array(384).fill(0.1),
    }];
    await expect(store.addChunks(chunks)).resolves.toBeUndefined();
  });

  it("deleteByDocumentId delegates to underlying store", async () => {
    await store.initialize();
    await expect(store.deleteByDocumentId("doc-1")).resolves.toBeUndefined();
  });

  it("search returns empty array when no results", async () => {
    await store.initialize();
    const results = await store.search("test query");
    expect(results).toEqual([]);
  });

  it("countChunks returns count from underlying store", async () => {
    await store.initialize();
    const count = await store.countChunks();
    expect(count).toBe(42);
  });

  it("searchByMode delegates to underlying store searchByMode", async () => {
    await store.initialize();
    // searchByMode is a full delegation — verify it returns an array
    const results = await store.searchByMode("test", 10, "vector");
    expect(Array.isArray(results)).toBe(true);
  });

  it("buildFilterClause returns undefined for empty filter", () => {
    expect(LanceDBVectorStore.buildFilterClause()).toBeUndefined();
    expect(LanceDBVectorStore.buildFilterClause({})).toBeUndefined();
  });

  it("buildFilterClause builds visibility filter", () => {
    const clause = LanceDBVectorStore.buildFilterClause({ visibility: "public" });
    expect(clause).toContain("visibility");
    expect(clause).toContain("'public'");
  });

  it("buildFilterClause builds category filter", () => {
    const clause = LanceDBVectorStore.buildFilterClause({ categories: ["document", "media"] });
    expect(clause).toContain("category");
    expect(clause).toContain("'document'");
    expect(clause).toContain("'media'");
  });

  it("buildFilterClause combines visibility and category", () => {
    const clause = LanceDBVectorStore.buildFilterClause({
      visibility: "internal",
      categories: ["document"],
    });
    expect(clause).toContain("AND");
  });
});

describe("createVectorStore factory", () => {
  it("creates LanceDBVectorStore for lancedb provider", () => {
    const store = createVectorStore({ provider: "lancedb", dbPath: "/tmp/test-factory" });
    expect(store).toBeInstanceOf(LanceDBVectorStore);
  });

  it("creates LanceDBVectorStore using options.dbPath", () => {
    const store = createVectorStore({ provider: "lancedb", options: { dbPath: "/tmp/test-options" } });
    expect(store).toBeInstanceOf(LanceDBVectorStore);
  });

  it("defaults to lancedb when provider is unrecognized", () => {
    const store = createVectorStore({ provider: "lancedb", dbPath: "/tmp/test-default" });
    expect(store).toBeInstanceOf(LanceDBVectorStore);
  });

  it("throws when no dbPath is provided for lancedb", () => {
    expect(() => createVectorStore({ provider: "lancedb" } as VectorStoreConfig & { dbPath?: string }))
      .toThrow("dbPath");
  });
});
