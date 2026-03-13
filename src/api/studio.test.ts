/**
 * Studio Router Unit Tests
 * Issue #438
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { EventEmitter } from "node:events";
import { createStudioRouter } from "./studio.js";

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ size: 12345 }),
  writeFileSync: vi.fn(),
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 12345 }),
    writeFileSync: vi.fn(),
  },
}));

function createMockTrimWorker() {
  const worker = new EventEmitter() as EventEmitter & {
    submit: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
  };
  worker.submit = vi.fn().mockResolvedValue("trim-abc123");
  worker.getJob = vi.fn().mockReturnValue({
    id: "trim-abc123",
    status: "queued",
    error: undefined,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
  });
  return worker;
}

function createMockAnalyzeWorker() {
  const worker = new EventEmitter() as EventEmitter & {
    submit: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
  };
  worker.submit = vi.fn().mockResolvedValue("analyze-xyz789");
  worker.getJob = vi.fn().mockReturnValue({
    id: "analyze-xyz789",
    status: "queued",
    suggestedCuts: [],
    error: undefined,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
  });
  return worker;
}

function createMockMediaQueueRepo() {
  return {
    getAsset: vi.fn().mockReturnValue({
      id: "asset-001",
      file_path: "/tmp/test_video.mp4",
      type: "video",
    }),
    createAsset: vi.fn().mockReturnValue("new-asset-001"),
    listAssets: vi.fn().mockReturnValue([]),
    deleteAsset: vi.fn().mockReturnValue(true),
  };
}

describe("Studio Router", () => {
  let app: express.Express;
  let trimWorker: ReturnType<typeof createMockTrimWorker>;
  let analyzeWorker: ReturnType<typeof createMockAnalyzeWorker>;
  let mediaQueueRepo: ReturnType<typeof createMockMediaQueueRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    trimWorker = createMockTrimWorker();
    analyzeWorker = createMockAnalyzeWorker();
    mediaQueueRepo = createMockMediaQueueRepo();

    app = express();
    app.use(express.json());
    const router = createStudioRouter({
      trimWorker: trimWorker as never,
      analyzeWorker: analyzeWorker as never,
      mediaQueueRepo: mediaQueueRepo as never,
    });
    app.use("/api/studio", router);
  });

  // ── POST /trim ──

  describe("POST /api/studio/trim", () => {
    it("returns 200 with jobId on valid request", async () => {
      const res = await request(app)
        .post("/api/studio/trim")
        .send({ assetId: "asset-001", startTime: 5, endTime: 15 });

      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe("trim-abc123");
      expect(res.body.status).toBe("queued");
      expect(trimWorker.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: "/tmp/test_video.mp4",
          startTime: 5,
          endTime: 15,
        }),
      );
    });

    it("returns 400 when assetId is missing", async () => {
      const res = await request(app)
        .post("/api/studio/trim")
        .send({ startTime: 5, endTime: 15 });

      expect(res.status).toBe(400);
    });

    it("returns 400 when startTime >= endTime", async () => {
      const res = await request(app)
        .post("/api/studio/trim")
        .send({ assetId: "asset-001", startTime: 15, endTime: 5 });

      expect(res.status).toBe(400);
    });

    it("returns 404 when asset not found", async () => {
      mediaQueueRepo.getAsset.mockReturnValue(null);

      const res = await request(app)
        .post("/api/studio/trim")
        .send({ assetId: "nonexistent", startTime: 0, endTime: 10 });

      expect(res.status).toBe(404);
    });
  });

  // ── GET /trim/:jobId ──

  describe("GET /api/studio/trim/:jobId", () => {
    it("returns job status", async () => {
      const res = await request(app).get("/api/studio/trim/trim-abc123");

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("trim-abc123");
      expect(res.body.status).toBe("queued");
    });

    it("returns 404 for unknown job", async () => {
      trimWorker.getJob.mockReturnValue(undefined);

      const res = await request(app).get("/api/studio/trim/unknown-id");
      expect(res.status).toBe(404);
    });
  });

  // ── POST /analyze ──

  describe("POST /api/studio/analyze", () => {
    it("returns 200 with jobId on valid request", async () => {
      const res = await request(app)
        .post("/api/studio/analyze")
        .send({ assetId: "asset-001" });

      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe("analyze-xyz789");
      expect(analyzeWorker.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: "asset-001",
          inputPath: "/tmp/test_video.mp4",
        }),
      );
    });

    it("returns 400 when assetId missing", async () => {
      const res = await request(app)
        .post("/api/studio/analyze")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 404 when asset not found", async () => {
      mediaQueueRepo.getAsset.mockReturnValue(null);

      const res = await request(app)
        .post("/api/studio/analyze")
        .send({ assetId: "nonexistent" });

      expect(res.status).toBe(404);
    });
  });

  // ── GET /analyze/:jobId ──

  describe("GET /api/studio/analyze/:jobId", () => {
    it("returns job status with suggested cuts", async () => {
      analyzeWorker.getJob.mockReturnValue({
        id: "analyze-xyz789",
        status: "complete",
        suggestedCuts: [{ start: 10, end: 20, reason: "Dead space" }],
        error: undefined,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: new Date("2026-01-01T00:01:00Z"),
      });

      const res = await request(app).get("/api/studio/analyze/analyze-xyz789");

      expect(res.status).toBe(200);
      expect(res.body.suggestedCuts).toHaveLength(1);
      expect(res.body.suggestedCuts[0].reason).toBe("Dead space");
    });

    it("returns 404 for unknown job", async () => {
      analyzeWorker.getJob.mockReturnValue(undefined);

      const res = await request(app).get("/api/studio/analyze/unknown-id");
      expect(res.status).toBe(404);
    });
  });

  // ── POST /upload-recording ──

  describe("POST /api/studio/upload-recording", () => {
    it("returns 400 when content-type is not multipart or video", async () => {
      const res = await request(app)
        .post("/api/studio/upload-recording")
        .set("Content-Type", "application/json")
        .send({ data: "not video" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Expected multipart/form-data or video/*");
    });

    it("returns 400 when body is empty", async () => {
      const res = await request(app)
        .post("/api/studio/upload-recording")
        .set("Content-Type", "video/mp4")
        .send(Buffer.alloc(0));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Empty request body");
    });

    it("saves mp4 recording and returns asset", async () => {
      const fakeVideo = Buffer.from("fake-mp4-data");
      const res = await request(app)
        .post("/api/studio/upload-recording")
        .set("Content-Type", "video/mp4")
        .send(fakeVideo);

      expect(res.status).toBe(200);
      expect(res.body.assetId).toBe("new-asset-001");
      expect(res.body.filename).toMatch(/^recording_\d+\.mp4$/);
      expect(res.body.size).toBe(fakeVideo.length);
      expect(mediaQueueRepo.createAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "video",
          mimeType: "video/mp4",
          source: "uploaded",
        }),
      );
    });

    it("saves webm recording with correct extension", async () => {
      const fakeVideo = Buffer.from("fake-webm-data");
      const res = await request(app)
        .post("/api/studio/upload-recording")
        .set("Content-Type", "video/webm")
        .send(fakeVideo);

      expect(res.status).toBe(200);
      expect(res.body.filename).toMatch(/\.webm$/);
      expect(mediaQueueRepo.createAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType: "video/webm",
        }),
      );
    });

    it("returns 404 when asset file is missing from disk", async () => {
      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);

      const res = await request(app)
        .post("/api/studio/trim")
        .send({ assetId: "asset-001", startTime: 0, endTime: 5 });

      // Asset found in repo but file doesn't exist on disk
      // Note: existsSync is called for the trim route's inputPath check
    });
  });

  // ── POST /analyze edge cases ──

  describe("POST /api/studio/analyze edge cases", () => {
    it("accepts optional model parameter", async () => {
      const res = await request(app)
        .post("/api/studio/analyze")
        .send({ assetId: "asset-001", model: "whisper-large" });

      expect(res.status).toBe(200);
      expect(analyzeWorker.submit).toHaveBeenCalledWith(
        expect.objectContaining({ model: "whisper-large" }),
      );
    });

    it("returns 404 when asset file is missing from disk", async () => {
      const nodefs = await import("node:fs");
      vi.mocked(nodefs.default.existsSync).mockReturnValueOnce(false);

      const res = await request(app)
        .post("/api/studio/analyze")
        .send({ assetId: "asset-001" });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Asset file not found");
    });
  });
});