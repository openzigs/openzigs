import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ size: 100, mtime: new Date("2025-01-01") }),
    readFile: vi.fn().mockResolvedValue("test content"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("chokidar", () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./chunker.js", () => ({
  chunkText: vi.fn((text: string, docId: string, relPath: string) => [{
    id: `${docId}-0`,
    documentId: docId,
    text,
    metadata: { source: relPath, chunkIndex: 0 },
  }]),
}));

vi.mock("./embedder.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0)),
  shutdownEmbedder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./lancedb-store.js", () => {
  const MockLanceDBStore = vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    addChunks: vi.fn().mockResolvedValue(undefined),
    deleteByDocumentId: vi.fn().mockResolvedValue(undefined),
    countChunks: vi.fn().mockResolvedValue(0),
    searchByMode: vi.fn().mockResolvedValue([]),
  }));
  (MockLanceDBStore as unknown as Record<string, unknown>).buildFilterClause = vi.fn().mockReturnValue(undefined);
  return { LanceDBStore: MockLanceDBStore };
});

vi.mock("./converters/index.js", () => ({
  createDefaultRegistry: vi.fn().mockResolvedValue({
    canConvert: vi.fn(() => false),
    convert: vi.fn().mockResolvedValue({ success: true, text: "converted", converter: "test" }),
    listConverters: vi.fn(() => []),
  }),
  shutdownConverters: vi.fn().mockResolvedValue(undefined),
  ConverterRegistry: vi.fn(),
}));

vi.mock("./multimodal-retriever.js", () => ({
  multimodalSearch: vi.fn().mockResolvedValue({
    results: [],
    classification: { isMediaQuery: false, mediaTypes: [] },
  }),
}));

import fs from "node:fs/promises";
import { KnowledgeIngestionService } from "./knowledge-service.js";
import { LanceDBStore } from "./lancedb-store.js";

// Helper to get the mocked fs functions
const mfs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("KnowledgeIngestionService", () => {
  let service: KnowledgeIngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no persisted metadata file
    mfs.readFile.mockRejectedValueOnce(new Error("ENOENT"));
    service = new KnowledgeIngestionService({
      config: { directory: "/tmp/test-knowledge", watchEnabled: false },
    });
  });

  // Helper to get the mock store instance from the constructor
  function getStore() {
    const StoreClass = LanceDBStore as unknown as ReturnType<typeof vi.fn>;
    return StoreClass.mock.results[StoreClass.mock.results.length - 1]?.value;
  }

  describe("constructor", () => {
    it("creates service with default config", () => {
      const s = new KnowledgeIngestionService();
      expect(s).toBeDefined();
    });

    it("accepts custom config", () => {
      const cfg = service.getConfig();
      expect(cfg.directory).toContain("test-knowledge");
      expect(cfg.watchEnabled).toBe(false);
    });
  });

  describe("start/stop", () => {
    it("starts and initializes the store", async () => {
      await service.start();
      const store = getStore();
      expect(store.initialize).toHaveBeenCalled();
      expect(mfs.mkdir).toHaveBeenCalled();
    });

    it("start is idempotent", async () => {
      await service.start();
      const store = getStore();
      await service.start();
      expect(store.initialize).toHaveBeenCalledTimes(1);
    });

    it("stops the service", async () => {
      await service.start();
      const store = getStore();
      await service.stop();
      expect(store.close).toHaveBeenCalled();
    });

    it("stop is idempotent", async () => {
      await service.stop();
    });
  });

  describe("getStats", () => {
    it("returns stats with zero counts initially", async () => {
      const stats = await service.getStats();
      expect(stats.totalDocuments).toBe(0);
      expect(stats.totalChunks).toBe(0);
      expect(stats.indexedDocuments).toBe(0);
    });
  });

  describe("listDocuments", () => {
    it("returns empty array initially", () => {
      expect(service.listDocuments()).toEqual([]);
    });
  });

  describe("search", () => {
    it("delegates to store.searchByMode", async () => {
      const store = getStore();
      store.searchByMode.mockResolvedValueOnce([{ text: "result", score: 0.9 }]);
      const results = await service.search("test query", 5);
      expect(store.searchByMode).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it("uses default config values", async () => {
      const store = getStore();
      await service.search("test");
      expect(store.searchByMode).toHaveBeenCalledWith(
        "test",
        expect.any(Number),
        expect.any(String),
        expect.any(Number),
        undefined,
      );
    });
  });

  describe("searchMultimodal", () => {
    it("returns classification and results", async () => {
      const { multimodalSearch } = await import("./multimodal-retriever.js");
      const result = await service.searchMultimodal("test query");
      expect(multimodalSearch).toHaveBeenCalled();
      expect(result.classification).toBeDefined();
    });
  });

  describe("ingestText", () => {
    it("ingests virtual text document", async () => {
      const store = getStore();
      await service.ingestText("doc-1", "Test Doc", "Hello world content");
      expect(store.addChunks).toHaveBeenCalled();
      const docs = service.listDocuments();
      expect(docs).toHaveLength(1);
      expect(docs[0].status).toBe("indexed");
    });

    it("skips re-indexing when content unchanged", async () => {
      const store = getStore();
      await service.ingestText("doc-1", "Test Doc", "Hello world");
      store.addChunks.mockClear();
      await service.ingestText("doc-1", "Test Doc", "Hello world");
      expect(store.addChunks).not.toHaveBeenCalled();
    });

    it("re-indexes when content changes", async () => {
      const store = getStore();
      await service.ingestText("doc-1", "Test Doc", "Version 1");
      store.addChunks.mockClear();
      await service.ingestText("doc-1", "Test Doc", "Version 2");
      expect(store.addChunks).toHaveBeenCalled();
    });

    it("handles indexing failure", async () => {
      const { generateEmbedding } = await import("./embedder.js");
      (generateEmbedding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("embed fail"));
      await expect(service.ingestText("doc-1", "Test", "content")).rejects.toThrow("embed fail");
      const docs = service.listDocuments();
      expect(docs[0].status).toBe("failed");
    });
  });

  describe("deleteDocument", () => {
    it("deletes an existing document", async () => {
      const store = getStore();
      await service.ingestText("doc-1", "Test", "content");
      await service.deleteDocument("doc-1");
      expect(store.deleteByDocumentId).toHaveBeenCalledWith("doc-1");
      expect(service.listDocuments()).toHaveLength(0);
    });

    it("handles non-existent document gracefully", async () => {
      const store = getStore();
      await service.deleteDocument("nonexistent");
      expect(store.deleteByDocumentId).not.toHaveBeenCalled();
    });
  });

  describe("reindexDocument", () => {
    it("throws for non-existent document", async () => {
      await expect(service.reindexDocument("nonexistent")).rejects.toThrow("Document not found");
    });
  });

  describe("getConfig / updateConfig", () => {
    it("returns config copy", () => {
      const cfg = service.getConfig();
      expect(cfg.directory).toBeDefined();
    });

    it("updates config at runtime (not running)", async () => {
      const updated = await service.updateConfig({ chunkSize: 2000 });
      expect(updated.chunkSize).toBe(2000);
    });

    it("handles directory change while running", async () => {
      await service.start();
      const updated = await service.updateConfig({ directory: "/tmp/new-knowledge" });
      expect(updated.directory).toContain("new-knowledge");
    });

    it("handles watch toggle", async () => {
      await service.start();
      await service.updateConfig({ watchEnabled: true });
      await service.updateConfig({ watchEnabled: false });
    });
  });

  describe("getConverterInfo", () => {
    it("returns empty array when no registry initialized", () => {
      const info = service.getConverterInfo();
      expect(info).toEqual([]);
    });
  });

  describe("getKeyframeManifest", () => {
    it("returns null when no manifest exists", async () => {
      mfs.readFile.mockRejectedValue(new Error("ENOENT"));
      const manifest = await service.getKeyframeManifest("doc-1");
      expect(manifest).toBeNull();
    });

    it("returns manifest when it exists", async () => {
      const mdata = { documentId: "doc-1", frames: [] };
      mfs.readFile.mockReset();
      mfs.readFile.mockResolvedValue(JSON.stringify(mdata));
      const manifest = await service.getKeyframeManifest("doc-1");
      expect(manifest).toMatchObject({ documentId: "doc-1" });
    });
  });

  describe("getKeyframeImagePath", () => {
    it("returns null when no manifest", async () => {
      mfs.readFile.mockRejectedValue(new Error("ENOENT"));
      const p = await service.getKeyframeImagePath("doc-1", 0);
      expect(p).toBeNull();
    });

    it("returns path when frame exists", async () => {
      const manifest = {
        documentId: "doc-1",
        frames: [{ index: 0, filename: "frame_0.jpg", timestamp: 0, description: "test" }],
      };
      mfs.readFile.mockReset();
      mfs.readFile.mockResolvedValue(JSON.stringify(manifest));
      mfs.access.mockReset();
      mfs.access.mockResolvedValue(undefined);
      const p = await service.getKeyframeImagePath("doc-1", 0);
      expect(p).toContain("frame_0.jpg");
    });

    it("returns null for missing frame index", async () => {
      const manifest = { documentId: "doc-1", frames: [] };
      mfs.readFile.mockReset();
      mfs.readFile.mockResolvedValue(JSON.stringify(manifest));
      const p = await service.getKeyframeImagePath("doc-1", 5);
      expect(p).toBeNull();
    });
  });

  describe("getDocumentIdsWithKeyframes", () => {
    it("returns empty set when no keyframes dir", async () => {
      mfs.readdir.mockReset();
      mfs.readdir.mockRejectedValue(new Error("ENOENT"));
      const ids = await service.getDocumentIdsWithKeyframes();
      expect(ids.size).toBe(0);
    });

    it("returns document IDs with manifests", async () => {
      mfs.readdir.mockReset();
      mfs.readdir.mockResolvedValueOnce([
        { name: "doc-1", isDirectory: () => true },
        { name: "doc-2", isDirectory: () => true },
      ]);
      mfs.access.mockReset();
      mfs.access
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"));

      const ids = await service.getDocumentIdsWithKeyframes();
      expect(ids.has("doc-1")).toBe(true);
      expect(ids.has("doc-2")).toBe(false);
    });
  });

  // ── Event emission ───────────────────────────────────────────

  describe("events", () => {
    it("emits document:indexed on successful ingestText", async () => {
      const handler = vi.fn();
      service.on("document:indexed", handler);
      await service.ingestText("ev-1", "Events Test", "Hello events");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].document.id).toBe("ev-1");
    });

    it("emits document:failed on ingestText failure", async () => {
      const { generateEmbedding } = await import("./embedder.js");
      (generateEmbedding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("embed error"));
      const handler = vi.fn();
      service.on("document:failed", handler);
      await expect(service.ingestText("ev-2", "Fail", "bad")).rejects.toThrow("embed error");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits document:deleted on deleteDocument", async () => {
      await service.ingestText("ev-3", "Del", "content");
      const handler = vi.fn();
      service.on("document:deleted", handler);
      await service.deleteDocument("ev-3");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].documentId).toBe("ev-3");
    });
  });

  // ── Search with overrides ───────────────────────────────────

  describe("search with overrides", () => {
    it("passes mode override to store", async () => {
      const store = getStore();
      await service.search("query", 5, { mode: "fts" });
      expect(store.searchByMode).toHaveBeenCalledWith("query", 5, "fts", expect.any(Number), undefined);
    });

    it("passes minScore override to store", async () => {
      const store = getStore();
      await service.search("query", 5, { minScore: 0.8 });
      expect(store.searchByMode).toHaveBeenCalledWith("query", 5, expect.any(String), 0.8, undefined);
    });
  });

  // ── Stats after ingestion ──────────────────────────────────

  describe("getStats after ingestion", () => {
    it("reflects ingested documents", async () => {
      await service.ingestText("s1", "Doc 1", "content 1");
      await service.ingestText("s2", "Doc 2", "content 2");
      const stats = await service.getStats();
      expect(stats.totalDocuments).toBe(2);
      expect(stats.indexedDocuments).toBe(2);
      expect(stats.failedDocuments).toBe(0);
      expect(stats.lastIndexedAt).not.toBeNull();
    });
  });

  // ── listDocuments sorting ─────────────────────────────────

  describe("listDocuments sorting", () => {
    it("returns documents sorted by relativePath", async () => {
      await service.ingestText("zz", "ZZZ", "content z");
      await service.ingestText("aa", "AAA", "content a");
      const docs = service.listDocuments();
      expect(docs).toHaveLength(2);
      expect(docs[0].relativePath).toBe("AAA");
      expect(docs[1].relativePath).toBe("ZZZ");
    });
  });

  // ── updateConfig runtime changes ───────────────────────────

  describe("updateConfig additional fields", () => {
    it("updates chunkSize at runtime", async () => {
      const updated = await service.updateConfig({ chunkSize: 500 });
      expect(updated.chunkSize).toBe(500);
    });

    it("updates searchMode at runtime", async () => {
      const updated = await service.updateConfig({ searchMode: "keyword" as import("./types.js").KnowledgeSearchMode });
      expect(updated.searchMode).toBe("keyword");
    });
  });

  // ── searchMultimodal with options ───────────────────────────

  describe("searchMultimodal with options", () => {
    it("passes limit and minScore to multimodal search", async () => {
      const { multimodalSearch } = await import("./multimodal-retriever.js");
      await service.searchMultimodal("test", { limit: 3, minScore: 0.5 });
      expect(multimodalSearch).toHaveBeenCalledWith(
        "test",
        expect.any(Function),
        expect.objectContaining({ limit: 3, minScore: 0.5 }),
      );
    });
  });

  // ── New: getConverterInfo ───────────────────────────────────

  describe("getConverterInfo", () => {
    it("returns empty array when no registry", () => {
      const info = service.getConverterInfo();
      expect(Array.isArray(info)).toBe(true);
    });

    it("returns converter list after start", async () => {
      await service.start();
      const info = service.getConverterInfo();
      expect(Array.isArray(info)).toBe(true);
    });
  });

  // ── New: reindexDocument ───────────────────────────────────

  describe("reindexDocument", () => {
    it("throws for non-existent document", async () => {
      await expect(service.reindexDocument("not-there")).rejects.toThrow("Document not found");
    });
  });

  // ── New: ingestText edge cases ─────────────────────────────

  describe("ingestText edge cases", () => {
    it("re-indexes on content hash change", async () => {
      await service.ingestText("doc1", "Doc 1", "initial content");
      const store = getStore();
      expect(store.addChunks).toHaveBeenCalledTimes(1);

      await service.ingestText("doc1", "Doc 1", "updated content");
      expect(store.addChunks).toHaveBeenCalledTimes(2);
      expect(store.deleteByDocumentId).toHaveBeenCalledWith("doc1");
    });

    it("propagates error when embedding fails", async () => {
      const { generateEmbedding } = await import("./embedder.js");
      (generateEmbedding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("embed fail"));
      await expect(service.ingestText("fail-doc", "Fail", "text")).rejects.toThrow("embed fail");
    });

    it("sets document status to failed when error occurs", async () => {
      const { generateEmbedding } = await import("./embedder.js");
      (generateEmbedding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
      try { await service.ingestText("fail2", "Fail", "text"); } catch { /* expected */ }
      const docs = service.listDocuments();
      const failed = docs.find((d) => d.id === "fail2");
      expect(failed?.status).toBe("failed");
    });

    it("emits document:failed event on ingest error", async () => {
      const handler = vi.fn();
      service.on("document:failed", handler);
      const { generateEmbedding } = await import("./embedder.js");
      (generateEmbedding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail"));
      try { await service.ingestText("fail3", "Fail", "text"); } catch { /* expected */ }
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "document:failed" }));
    });

    it("sets document sizeBytes correctly", async () => {
      await service.ingestText("sized", "Sized", "hello world");
      const doc = service.listDocuments().find((d) => d.id === "sized");
      expect(doc?.sizeBytes).toBe(Buffer.byteLength("hello world", "utf-8"));
    });
  });

  // ── New: deleteDocument edge cases ─────────────────────────

  describe("deleteDocument edge cases", () => {
    it("no-ops on already deleted document", async () => {
      await service.deleteDocument("nonexistent");
      // should not throw
    });

    it("emits document:deleted event", async () => {
      const handler = vi.fn();
      service.on("document:deleted", handler);
      await service.ingestText("del-test", "Del", "content");
      await service.deleteDocument("del-test");
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: "document:deleted", documentId: "del-test" }),
      );
    });

    it("removes document from listDocuments after deletion", async () => {
      await service.ingestText("rm-me", "RM", "content");
      expect(service.listDocuments().some((d) => d.id === "rm-me")).toBe(true);
      await service.deleteDocument("rm-me");
      expect(service.listDocuments().some((d) => d.id === "rm-me")).toBe(false);
    });
  });

  // ── New: getStats ──────────────────────────────────────────

  describe("getStats detailed", () => {
    it("counts indexed documents after ingestText", async () => {
      await service.ingestText("stat1", "S1", "abc");
      await service.ingestText("stat2", "S2", "def");
      const stats = await service.getStats();
      expect(stats.totalDocuments).toBe(2);
      expect(stats.indexedDocuments).toBe(2);
    });

    it("counts failed documents", async () => {
      const { generateEmbedding } = await import("./embedder.js");
      (generateEmbedding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("e"));
      try { await service.ingestText("f1", "F1", "x"); } catch { /* expected */ }
      const stats = await service.getStats();
      expect(stats.failedDocuments).toBeGreaterThanOrEqual(1);
    });

    it("reports totalSizeBytes", async () => {
      await service.ingestText("s1", "S1", "abcdef");
      const stats = await service.getStats();
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
    });
  });

  // ── New: updateConfig while running ────────────────────────

  describe("updateConfig while running", () => {
    it("restarts watcher on directory change while running", async () => {
      service = new KnowledgeIngestionService({
        config: { directory: "/tmp/test-knowledge", watchEnabled: true },
      });
      await service.start();
      const { watch } = await import("chokidar");
      const watchCallCount = (watch as ReturnType<typeof vi.fn>).mock.calls.length;
      await service.updateConfig({ directory: "/tmp/new-dir" });
      expect((watch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(watchCallCount);
    });

    it("stops watcher when watchEnabled set to false", async () => {
      service = new KnowledgeIngestionService({
        config: { directory: "/tmp/test-knowledge", watchEnabled: true },
      });
      await service.start();
      await service.updateConfig({ watchEnabled: false });
      // No error means success (watcher.close was called)
    });
  });

  // ── New: search with mode override ─────────────────────────

  describe("search with overrides", () => {
    it("passes keyword mode override", async () => {
      const store = getStore();
      await service.search("test query", 5, { mode: "keyword" as import("./types.js").KnowledgeSearchMode });
      expect(store.searchByMode).toHaveBeenCalledWith("test query", 5, "keyword", expect.any(Number), undefined);
    });

    it("uses default maxResults when limit not provided", async () => {
      const store = getStore();
      await service.search("query");
      expect(store.searchByMode).toHaveBeenCalledWith("query", expect.any(Number), "hybrid", expect.any(Number), undefined);
    });
  });
});
