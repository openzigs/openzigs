import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createKnowledgeRouter } from "./knowledge.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue("{}"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
  },
}));

function createMockKnowledgeService() {
  return {
    getStats: vi.fn().mockResolvedValue({ totalDocuments: 5, totalChunks: 100 }),
    listDocuments: vi.fn(() => [{ id: "d1", name: "test.pdf" }]),
    search: vi.fn().mockResolvedValue([{ chunk: "result", score: 0.9 }]),
    reindexAll: vi.fn().mockResolvedValue(undefined),
    reindexDocument: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(() => ({
      directory: "/tmp/knowledge",
      watchEnabled: true,
      mediaModel: "gpt-4o",
      minScore: 0.3,
      searchMode: "hybrid",
    })),
    updateConfig: vi.fn().mockResolvedValue({
      directory: "/tmp/knowledge",
      watchEnabled: false,
      mediaModel: "gpt-4o",
      minScore: 0.3,
      searchMode: "hybrid",
    }),
    getConverterInfo: vi.fn(() => [{ name: "pdf", extensions: [".pdf"] }]),
    getKeyframeManifest: vi.fn().mockResolvedValue(null),
    getKeyframeImagePath: vi.fn().mockResolvedValue(null),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const ks = createMockKnowledgeService();
  app.use("/knowledge", createKnowledgeRouter({ knowledgeService: ks as never }));
  return { app, ks };
}

describe("Knowledge API router", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /stats", () => {
    it("returns knowledge base stats", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/knowledge/stats");
      expect(res.status).toBe(200);
      expect(res.body.totalDocuments).toBe(5);
    });
  });

  describe("GET /documents", () => {
    it("lists documents", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/knowledge/documents");
      expect(res.status).toBe(200);
      expect(res.body.documents).toHaveLength(1);
    });
  });

  describe("POST /search", () => {
    it("returns search results", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/knowledge/search").send({ query: "test" });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
    });

    it("rejects missing query", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/knowledge/search").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /reindex", () => {
    it("triggers full reindex", async () => {
      const { app, ks } = buildApp();
      const res = await request(app).post("/knowledge/reindex");
      expect(res.status).toBe(200);
      expect(ks.reindexAll).toHaveBeenCalled();
    });
  });

  describe("POST /reindex/:documentId", () => {
    it("reindexes a single document", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/knowledge/reindex/d1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for unknown document", async () => {
      const { app, ks } = buildApp();
      ks.reindexDocument.mockRejectedValue(new Error("Document not found"));
      const res = await request(app).post("/knowledge/reindex/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /documents/:documentId", () => {
    it("deletes a document", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/knowledge/documents/d1");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /config", () => {
    it("returns config", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/knowledge/config");
      expect(res.status).toBe(200);
      expect(res.body.searchMode).toBe("hybrid");
    });
  });

  describe("PUT /config", () => {
    it("rejects empty body", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/knowledge/config").send({});
      expect(res.status).toBe(400);
    });

    it("rejects invalid searchMode", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/knowledge/config").send({ searchMode: "invalid" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid minScore", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/knowledge/config").send({ minScore: 2 });
      expect(res.status).toBe(400);
    });

    it("rejects empty directory", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/knowledge/config").send({ directory: "" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /converters", () => {
    it("lists converters", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/knowledge/converters");
      expect(res.status).toBe(200);
      expect(res.body.converters).toHaveLength(1);
    });
  });

  describe("GET /keyframes/:documentId", () => {
    it("returns 404 when no keyframes", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/knowledge/keyframes/d1");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /keyframes/:documentId/:frameIndex", () => {
    it("returns 400 for non-numeric index", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/knowledge/keyframes/d1/abc");
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing frame", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/knowledge/keyframes/d1/0");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /convert", () => {
    it("rejects missing file paths", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/knowledge/convert").send({});
      expect(res.status).toBe(400);
    });

    it("converts a single filePath", async () => {
      const { app, ks } = buildApp();
      const res = await request(app).post("/knowledge/convert").send({ filePath: "/tmp/test.pdf" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].ok).toBe(true);
      expect(ks.reindexAll).toHaveBeenCalled();
    });

    it("converts multiple filePaths", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/knowledge/convert").send({ filePaths: ["/tmp/a.pdf", "/tmp/b.pdf"] });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
    });
  });

  // ── Additional coverage ─────────────────────────────────────

  describe("PUT /config (valid updates)", () => {
    it("updates watchEnabled", async () => {
      const { app, ks } = buildApp();
      const res = await request(app).put("/knowledge/config").send({ watchEnabled: false });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ks.updateConfig).toHaveBeenCalledWith({ watchEnabled: false });
    });

    it("updates searchMode", async () => {
      const { app, ks } = buildApp();
      const res = await request(app).put("/knowledge/config").send({ searchMode: "vector" });
      expect(res.status).toBe(200);
      expect(ks.updateConfig).toHaveBeenCalledWith({ searchMode: "vector" });
    });
  });

  describe("PUT /config (invalid inputs)", () => {
    it("rejects non-boolean watchEnabled", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/knowledge/config").send({ watchEnabled: "yes" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("watchEnabled");
    });

    it("rejects empty mediaModel", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/knowledge/config").send({ mediaModel: "" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("mediaModel");
    });
  });

  describe("GET /stats (error)", () => {
    it("returns 500 when service throws", async () => {
      const { app, ks } = buildApp();
      ks.getStats.mockRejectedValue(new Error("DB error"));
      const res = await request(app).get("/knowledge/stats");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /documents (error)", () => {
    it("returns 500 when service throws", async () => {
      const { app, ks } = buildApp();
      ks.listDocuments.mockImplementation(() => { throw new Error("DB error"); });
      const res = await request(app).get("/knowledge/documents");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /search (limit)", () => {
    it("caps limit at 50", async () => {
      const { app, ks } = buildApp();
      const res = await request(app).post("/knowledge/search").send({ query: "test", limit: 200 });
      expect(res.status).toBe(200);
      expect(ks.search).toHaveBeenCalledWith("test", 50, expect.any(Object));
    });
  });

  describe("GET /keyframes/:documentId (success)", () => {
    it("returns keyframe manifest", async () => {
      const { app, ks } = buildApp();
      ks.getKeyframeManifest.mockResolvedValue({
        documentId: "d1",
        sourceFile: "video.mp4",
        extractedAt: "2026-01-01T00:00:00Z",
        frames: [
          { index: 0, timestamp: 5.0, description: "Opening shot" },
        ],
      });
      const res = await request(app).get("/knowledge/keyframes/d1");
      expect(res.status).toBe(200);
      expect(res.body.frameCount).toBe(1);
      expect(res.body.frames[0].imageUrl).toContain("/keyframes/d1/0");
    });
  });

  describe("DELETE /documents (error)", () => {
    it("returns 500 when service throws", async () => {
      const { app, ks } = buildApp();
      ks.deleteDocument.mockRejectedValue(new Error("Delete failed"));
      const res = await request(app).delete("/knowledge/documents/d1");
      expect(res.status).toBe(500);
    });
  });
});
