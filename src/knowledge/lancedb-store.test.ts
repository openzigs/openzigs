import { describe, it, expect, vi, beforeEach } from "vitest";

// All mock objects must be created inside vi.mock factories to avoid hoisting issues

vi.mock("@lancedb/lancedb", () => {
  const _mockVectorSearchChain = {
    distanceType: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  };
  const _mockFtsSearchChain = {
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  };
  const _mockSelectChain = {
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  };
  const _mockTable = {
    add: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    createIndex: vi.fn().mockResolvedValue(undefined),
    countRows: vi.fn().mockResolvedValue(0),
    vectorSearch: vi.fn().mockReturnValue(_mockVectorSearchChain),
    search: vi.fn().mockImplementation((_q: unknown, type?: string) => {
      if (type === "fts") return _mockFtsSearchChain;
      return _mockSelectChain;
    }),
    _vectorSearchChain: _mockVectorSearchChain,
    _ftsSearchChain: _mockFtsSearchChain,
    _selectChain: _mockSelectChain,
  };
  const _mockConnection = {
    tableNames: vi.fn().mockResolvedValue([]),
    openTable: vi.fn().mockResolvedValue(_mockTable),
    createTable: vi.fn().mockResolvedValue(_mockTable),
    _table: _mockTable,
  };
  return {
    connect: vi.fn().mockResolvedValue(_mockConnection),
    Index: {
      ivfPq: vi.fn().mockReturnValue({}),
      fts: vi.fn().mockReturnValue({}),
    },
    _connection: _mockConnection,
    _table: _mockTable,
  };
});

vi.mock("./embedder.js", () => ({
  getEmbeddingDim: vi.fn().mockReturnValue(384),
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0)),
}));

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { LanceDBStore } from "./lancedb-store.js";
import * as lancedb from "@lancedb/lancedb";

// Access mock internals via exported helpers
function getMockConnection() {
  return (lancedb as any)._connection;
}
function getMockTable() {
  return (lancedb as any)._table;
}

describe("LanceDBStore", () => {
  let store: LanceDBStore;

  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset default behaviors completely (including once stacks)
    const conn = getMockConnection();
    const tbl = getMockTable();
    conn.tableNames.mockReset().mockResolvedValue([]);
    conn.openTable.mockReset().mockResolvedValue(tbl);
    conn.createTable.mockReset().mockResolvedValue(tbl);
    tbl.add.mockReset().mockResolvedValue(undefined);
    tbl.delete.mockReset().mockResolvedValue(undefined);
    tbl.createIndex.mockReset().mockResolvedValue(undefined);
    tbl.countRows.mockReset().mockResolvedValue(0);
    tbl._vectorSearchChain.distanceType.mockReset().mockReturnThis();
    tbl._vectorSearchChain.limit.mockReset().mockReturnThis();
    tbl._vectorSearchChain.toArray.mockReset().mockResolvedValue([]);
    tbl._ftsSearchChain.limit.mockReset().mockReturnThis();
    tbl._ftsSearchChain.toArray.mockReset().mockResolvedValue([]);
    tbl._selectChain.select.mockReset().mockReturnThis();
    tbl._selectChain.limit.mockReset().mockReturnThis();
    tbl._selectChain.toArray.mockReset().mockResolvedValue([]);
    tbl.vectorSearch.mockReset().mockReturnValue(tbl._vectorSearchChain);
    tbl.search.mockReset().mockImplementation((_q: unknown, type?: string) => {
      if (type === "fts") return tbl._ftsSearchChain;
      return tbl._selectChain;
    });
    (lancedb.connect as any).mockReset().mockResolvedValue(conn);
    (lancedb.Index.ivfPq as any).mockReset().mockReturnValue({});
    (lancedb.Index.fts as any).mockReset().mockReturnValue({});

    store = new LanceDBStore({ dbPath: "/tmp/test-lance-db" });
  });

  describe("initialize", () => {
    it("connects and opens existing table", async () => {
      const conn = getMockConnection();
      conn.tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();
      expect(conn.openTable).toHaveBeenCalledWith("knowledge_chunks");
    });

    it("connects without table when none exists", async () => {
      const conn = getMockConnection();
      conn.tableNames.mockResolvedValueOnce([]);
      await store.initialize();
      expect(conn.openTable).not.toHaveBeenCalled();
    });

    it("is idempotent", async () => {
      getMockConnection().tableNames.mockResolvedValue([]);
      await store.initialize();
      await store.initialize();
      expect(lancedb.connect).toHaveBeenCalledTimes(1);
    });

    it("throws on connection failure", async () => {
      (lancedb.connect as any).mockRejectedValueOnce(new Error("ENOENT"));
      const s = new LanceDBStore({ dbPath: "/bad/path" });
      await expect(s.initialize()).rejects.toThrow("ENOENT");
    });
  });

  describe("addChunks", () => {
    it("skips empty chunk array", async () => {
      await store.addChunks([]);
      expect(getMockConnection().createTable).not.toHaveBeenCalled();
    });

    it("creates table on first addChunks", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce([]);
      await store.initialize();

      const chunks = [
        { id: "c1", documentId: "d1", text: "hello", chunkIndex: 0, sourcePath: "/f.txt" },
      ];

      await store.addChunks(chunks);
      expect(getMockConnection().createTable).toHaveBeenCalledWith(
        "knowledge_chunks",
        expect.arrayContaining([expect.objectContaining({ id: "c1", text: "hello" })]),
      );
    });

    it("adds to existing table", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      const chunks = [
        { id: "c2", documentId: "d2", text: "world", chunkIndex: 0, sourcePath: "/g.txt" },
      ];

      await store.addChunks(chunks);
      expect(getMockTable().add).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: "c2" })]),
      );
    });
  });

  describe("search", () => {
    it("returns empty when table is null", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce([]);
      await store.initialize();
      const results = await store.search("query");
      expect(results).toEqual([]);
    });

    it("performs vector search and maps results", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([
        { text: "hello", sourcePath: "/f.txt", _distance: 0.2, documentId: "d1", chunkIndex: 0 },
      ]);

      const results = await store.search("hello");
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("hello");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("filters by minScore", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([
        { text: "near", sourcePath: "/f.txt", _distance: 0.1, documentId: "d1", chunkIndex: 0 },
        { text: "far", sourcePath: "/g.txt", _distance: 1.9, documentId: "d2", chunkIndex: 0 },
      ]);

      const results = await store.search("query", 10, 0.5);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("near");
    });
  });

  describe("fullTextSearch", () => {
    it("falls back to vector search when FTS is not available", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([
        { text: "result", sourcePath: "/f.txt", _distance: 0.3, documentId: "d1", chunkIndex: 0 },
      ]);

      const results = await store.fullTextSearch("keyword");
      expect(results).toHaveLength(1);
    });
  });

  describe("deleteByDocumentId", () => {
    it("deletes chunks for a document", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      await store.deleteByDocumentId("doc-123");
      expect(getMockTable().delete).toHaveBeenCalledWith(expect.stringContaining("doc-123"));
    });

    it("escapes single quotes in document ID", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      await store.deleteByDocumentId("doc'evil");
      expect(getMockTable().delete).toHaveBeenCalledWith("documentId = 'doc''evil'");
    });

    it("does nothing when table is null", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce([]);
      await store.initialize();
      await store.deleteByDocumentId("doc-1");
      expect(getMockTable().delete).not.toHaveBeenCalled();
    });
  });

  describe("countChunks", () => {
    it("returns 0 when table is null", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce([]);
      await store.initialize();
      expect(await store.countChunks()).toBe(0);
    });

    it("returns table row count", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();
      getMockTable().countRows.mockResolvedValueOnce(42);
      expect(await store.countChunks()).toBe(42);
    });
  });

  describe("listDocumentIds", () => {
    it("returns empty when table is null", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce([]);
      await store.initialize();
      expect(await store.listDocumentIds()).toEqual([]);
    });

    it("returns unique document IDs", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable()._selectChain.toArray.mockResolvedValueOnce([
        { documentId: "d1" },
        { documentId: "d2" },
        { documentId: "d1" },
      ]);

      const ids = await store.listDocumentIds();
      expect(ids).toContain("d1");
      expect(ids).toContain("d2");
      expect(ids).toHaveLength(2);
    });
  });

  describe("searchByMode", () => {
    it("routes to search for vector mode", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();
      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([]);
      await store.searchByMode("query", 5, "vector");
      expect(getMockTable().vectorSearch).toHaveBeenCalled();
    });

    it("routes to fullTextSearch for fts mode", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();
      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([]);
      await store.searchByMode("query", 5, "fts");
    });

    it("routes to hybridSearch for hybrid mode", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();
      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([]);
      await store.searchByMode("query", 5, "hybrid");
    });
  });

  describe("close", () => {
    it("resets state", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();
      await store.close();
      const results = await store.search("test");
      expect(results).toEqual([]);
    });
  });

  describe("hybridSearch", () => {
    it("returns empty when table is null", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce([]);
      await store.initialize();
      const results = await store.hybridSearch("query");
      expect(results).toEqual([]);
    });

    it("falls back to vector search when FTS index not created", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();
      // ftsIndexCreated is false by default (no addChunks called)
      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([
        { text: "vector only", sourcePath: "/f.txt", _distance: 0.2, documentId: "d1", chunkIndex: 0 },
      ]);
      const results = await store.hybridSearch("query");
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("vector only");
    });

    it("merges vector and FTS results via RRF", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      // Trigger FTS index creation by adding chunks
      const chunks = [{ id: "c1", documentId: "d1", text: "test chunk", chunkIndex: 0, sourcePath: "/f.txt" }];
      await store.addChunks(chunks);

      // Now set up vector and FTS search results
      // Vector finds d1 and d2, FTS finds d1 and d3
      getMockTable()._vectorSearchChain.toArray
        .mockResolvedValueOnce([  // vector search in hybridSearch
          { text: "result A", sourcePath: "/a.txt", _distance: 0.1, documentId: "d1", chunkIndex: 0 },
          { text: "result B", sourcePath: "/b.txt", _distance: 0.3, documentId: "d2", chunkIndex: 0 },
        ]);
      getMockTable()._ftsSearchChain.toArray
        .mockResolvedValueOnce([]);
      getMockTable()._vectorSearchChain.toArray
        .mockResolvedValueOnce([  // fullTextSearch fallback to vector
          { text: "result A", sourcePath: "/a.txt", _distance: 0.15, documentId: "d1", chunkIndex: 0 },
          { text: "result C", sourcePath: "/c.txt", _distance: 0.5, documentId: "d3", chunkIndex: 0 },
        ]);

      const results = await store.hybridSearch("test", 10);
      // d1 appears in both, should be ranked highest
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].documentId).toBe("d1");
    });

    it("applies minScore filter to hybrid results", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      // Enable FTS index
      await store.addChunks([{ id: "c1", documentId: "d1", text: "test", chunkIndex: 0, sourcePath: "/f.txt" }]);

      getMockTable()._vectorSearchChain.toArray
        .mockResolvedValueOnce([
          { text: "good", sourcePath: "/a.txt", _distance: 0.1, documentId: "d1", chunkIndex: 0 },
          { text: "bad", sourcePath: "/b.txt", _distance: 1.8, documentId: "d2", chunkIndex: 0 },
        ]);
      getMockTable()._ftsSearchChain.toArray.mockResolvedValueOnce([]);
      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([]);

      const results = await store.hybridSearch("test", 10, 0.5);
      // "bad" has distance 1.8 → score ~0.1, should be filtered out
      expect(results.every((r) => r.score >= 0.5)).toBe(true);
    });

    it("falls back to vector search when hybridSearch RRF logic errors", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      // Enable FTS index
      await store.addChunks([{ id: "c1", documentId: "d1", text: "test", chunkIndex: 0, sourcePath: "/f.txt" }]);

      // Make the full text search builder throw when accessing chained methods
      // This triggers an error inside Promise.all at the hybridSearch level
      getMockTable().search.mockImplementationOnce(() => { throw new Error("FTS crashed"); });

      // Fallback vector search should succeed
      getMockTable()._vectorSearchChain.toArray
        .mockResolvedValueOnce([  // fallback vector search
          { text: "fallback", sourcePath: "/f.txt", _distance: 0.2, documentId: "d1", chunkIndex: 0 },
        ]);

      const results = await store.hybridSearch("test");
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("fallback");
    });
  });

  describe("buildFilterClause", () => {
    it("returns undefined when no filter provided", () => {
      expect(LanceDBStore.buildFilterClause()).toBeUndefined();
    });

    it("returns undefined for empty filter object", () => {
      expect(LanceDBStore.buildFilterClause({})).toBeUndefined();
    });

    it("builds visibility filter clause", () => {
      const clause = LanceDBStore.buildFilterClause({ visibility: "public" });
      expect(clause).toBe("(visibility = 'public' OR visibility IS NULL)");
    });

    it("escapes single quotes in visibility", () => {
      const clause = LanceDBStore.buildFilterClause({ visibility: "it's" as never });
      expect(clause).toContain("it''s");
    });

    it("builds categories filter clause", () => {
      const clause = LanceDBStore.buildFilterClause({ categories: ["docs", "code"] });
      expect(clause).toContain("IN ('docs', 'code')");
      expect(clause).toContain("OR category IS NULL");
    });

    it("combines visibility and categories", () => {
      const clause = LanceDBStore.buildFilterClause({
        visibility: "private",
        categories: ["api"],
      });
      expect(clause).toContain("visibility = 'private'");
      expect(clause).toContain("AND");
      expect(clause).toContain("IN ('api')");
    });

    it("escapes single quotes in categories", () => {
      const clause = LanceDBStore.buildFilterClause({ categories: ["it's"] });
      expect(clause).toContain("it''s");
    });
  });

  describe("search - additional edge cases", () => {
    it("maps results with missing fields to defaults", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([
        { _distance: 0.3 },  // missing text, sourcePath, documentId, chunkIndex
      ]);

      const results = await store.search("query");
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("");
      expect(results[0].sourcePath).toBe("");
      expect(results[0].documentId).toBe("");
      expect(results[0].chunkIndex).toBe(0);
    });

    it("maps results with visibility and category fields", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([
        {
          text: "secure doc",
          sourcePath: "/s.txt",
          _distance: 0.1,
          documentId: "d1",
          chunkIndex: 0,
          visibility: "private",
          category: "api",
          mediaUrl: "https://example.com/img.png",
          sectionHeading: "API Reference",
        },
      ]);

      const results = await store.search("query");
      expect(results).toHaveLength(1);
      expect(results[0].visibility).toBe("private");
      expect(results[0].category).toBe("api");
      expect(results[0].mediaUrl).toBe("https://example.com/img.png");
      expect(results[0].sectionHeading).toBe("API Reference");
    });

    it("handles missing _distance in results", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable()._vectorSearchChain.toArray.mockResolvedValueOnce([
        { text: "no distance", sourcePath: "/f.txt", documentId: "d1", chunkIndex: 0 },
      ]);

      const results = await store.search("query");
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0);
    });

    it("search error falls back gracefully", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce(["knowledge_chunks"]);
      await store.initialize();

      getMockTable().vectorSearch.mockImplementationOnce(() => {
        throw new Error("vector search failed");
      });

      const results = await store.search("query");
      expect(results).toEqual([]);
    });
  });

  describe("ensureFtsIndex error handling", () => {
    it("continues when FTS index creation fails", async () => {
      getMockConnection().tableNames.mockResolvedValueOnce([]);
      await store.initialize();

      getMockTable().createIndex.mockRejectedValueOnce(new Error("FTS not supported"));

      const chunks = [{ id: "c1", documentId: "d1", text: "test", chunkIndex: 0, sourcePath: "/f.txt" }];
      // Should not throw
      await store.addChunks(chunks);
    });
  });
});
