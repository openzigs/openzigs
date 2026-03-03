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
    vi.clearAllMocks();
    // Reset default behaviors after clearAllMocks
    const conn = getMockConnection();
    const tbl = getMockTable();
    conn.tableNames.mockResolvedValue([]);
    conn.openTable.mockResolvedValue(tbl);
    conn.createTable.mockResolvedValue(tbl);
    tbl.add.mockResolvedValue(undefined);
    tbl.delete.mockResolvedValue(undefined);
    tbl.createIndex.mockResolvedValue(undefined);
    tbl.countRows.mockResolvedValue(0);
    tbl._vectorSearchChain.distanceType.mockReturnThis();
    tbl._vectorSearchChain.limit.mockReturnThis();
    tbl._vectorSearchChain.toArray.mockResolvedValue([]);
    tbl._ftsSearchChain.limit.mockReturnThis();
    tbl._ftsSearchChain.toArray.mockResolvedValue([]);
    tbl._selectChain.select.mockReturnThis();
    tbl._selectChain.limit.mockReturnThis();
    tbl._selectChain.toArray.mockResolvedValue([]);
    tbl.vectorSearch.mockReturnValue(tbl._vectorSearchChain);
    tbl.search.mockImplementation((_q: unknown, type?: string) => {
      if (type === "fts") return tbl._ftsSearchChain;
      return tbl._selectChain;
    });
    (lancedb.connect as any).mockResolvedValue(conn);

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
});
