import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createQueueRouter, createQueueCallbackRouter } from "./queue.js";
import type { QueueRouterOptions } from "./queue.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../queue/types.js", () => ({
  MAX_VIDEO_FRAMES: 257,
  MAX_VIDEO_DURATION_SEC: 10,
  DEFAULT_VIDEO_FPS: 25,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
  },
}));

function createMockRepo() {
  const jobs = new Map<string, Record<string, unknown>>();
  const assets = new Map<string, Record<string, unknown>>();

  return {
    createJob: vi.fn((input: Record<string, unknown>) => {
      const id = `job-${jobs.size + 1}`;
      const job = { id, ...input, status: "pending", targetNode: "m2-pro" };
      jobs.set(id, job);
      return job;
    }),
    listJobs: vi.fn(() => Array.from(jobs.values())),
    countJobs: vi.fn(() => jobs.size),
    getJob: vi.fn((id: string) => jobs.get(id) ?? null),
    cancelJob: vi.fn((id: string) => jobs.has(id)),
    killJob: vi.fn((id: string) => jobs.has(id)),
    markComplete: vi.fn(),
    countByStatus: vi.fn(() => ({ pending: 1, dispatched: 0, completed: 2, failed: 0 })),
    listAssets: vi.fn(() => Array.from(assets.values())),
    countAssets: vi.fn(() => assets.size),
    getAsset: vi.fn((id: string) => assets.get(id) ?? null),
    deleteAsset: vi.fn(),
    updateAssetTags: vi.fn(),
    createAsset: vi.fn((data: Record<string, unknown>) => {
      const id = `asset-${assets.size + 1}`;
      assets.set(id, { id, ...data });
      return id;
    }),
    isProjectComplete: vi.fn(() => ({ complete: false, total: 3, completed: 1 })),
    listFolders: vi.fn(() => [{ folder: "renders", count: 2 }, { folder: "exports", count: 1 }]),
    updateAssetKnowledgeMeta: vi.fn(),
    updateAssetFolder: vi.fn(),
    renameAsset: vi.fn(),
    updateAssetDescription: vi.fn(),
    _jobs: jobs,
    _assets: assets,
  };
}

function createMockQueueMaster() {
  return {
    handleJobCompletion: vi.fn().mockResolvedValue(undefined),
    getNodeStatuses: vi.fn().mockResolvedValue([
      { node: "m2-pro", online: true, model: null },
    ]),
    unloadNode: vi.fn().mockResolvedValue({ ok: true }),
    switchActiveNode: vi.fn().mockResolvedValue({ ok: true }),
    reportProgress: vi.fn(),
    emit: vi.fn(),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const repo = createMockRepo();
  const queueMaster = createMockQueueMaster();
  const opts = { queueMaster, repo } as unknown as QueueRouterOptions;
  app.use("/q", createQueueRouter(opts));
  app.use("/q/callback", createQueueCallbackRouter(opts));
  return { app, repo, queueMaster };
}

describe("Queue API router", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── POST /jobs ─────────────────────────────────────────────

  describe("POST /jobs", () => {
    it("creates a job", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({
        type: "txt2img",
        payload: { prompt: "a cat" },
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe("job-1");
    });

    it("rejects invalid type", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({
        type: "invalid",
        payload: { prompt: "x" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({
        type: "txt2img",
        payload: {},
      });
      expect(res.status).toBe(400);
    });

    it("rejects oversized prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({
        type: "txt2img",
        payload: { prompt: "x".repeat(50_001) },
      });
      expect(res.status).toBe(400);
    });

    it("rejects video with too many frames", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({
        type: "txt2video",
        payload: { prompt: "a cat", num_frames: 999 },
      });
      expect(res.status).toBe(400);
    });
  });

  // ── GET /jobs ──────────────────────────────────────────────

  describe("GET /jobs", () => {
    it("lists jobs", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/jobs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("jobs");
      expect(res.body).toHaveProperty("total");
    });
  });

  // ── GET /jobs/stats ────────────────────────────────────────

  describe("GET /jobs/stats", () => {
    it("returns status counts", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/jobs/stats");
      expect(res.status).toBe(200);
      expect(res.body.pending).toBe(1);
    });
  });

  // ── GET /jobs/:id ──────────────────────────────────────────

  describe("GET /jobs/:id", () => {
    it("returns 404 for missing job", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/jobs/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /jobs/:id ───────────────────────────────────────

  describe("DELETE /jobs/:id", () => {
    it("returns 404 for missing job", async () => {
      const { app, repo } = buildApp();
      repo.cancelJob.mockReturnValue(false);
      const res = await request(app).delete("/q/jobs/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Assets ─────────────────────────────────────────────────

  describe("GET /assets", () => {
    it("lists assets", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/assets");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("assets");
    });
  });

  describe("GET /assets/:id", () => {
    it("returns 404 for missing asset", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/assets/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /assets/:id/tags", () => {
    it("rejects non-array tags", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/a1/tags").send({ tags: "bad" });
      expect(res.status).toBe(400);
    });

    it("updates tags", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/a1/tags").send({ tags: ["nature", "cat"] });
      expect(res.status).toBe(200);
    });
  });

  // ── Nodes ──────────────────────────────────────────────────

  describe("GET /nodes", () => {
    it("returns node statuses", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/nodes");
      expect(res.status).toBe(200);
      expect(res.body.nodes).toHaveLength(1);
    });
  });

  describe("POST /nodes/:node/unload", () => {
    it("rejects invalid node", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/nodes/bad-node/unload");
      expect(res.status).toBe(400);
    });

    it("unloads valid node", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/nodes/mac-mini/unload");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /nodes/switch", () => {
    it("rejects invalid target", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/nodes/switch").send({ targetNode: "bad" });
      expect(res.status).toBe(400);
    });

    it("switches active node", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/nodes/switch").send({ targetNode: "mac-mini" });
      expect(res.status).toBe(200);
    });
  });

  // ── GET /project/:projectId/status ─────────────────────────

  describe("GET /project/:id/status", () => {
    it("returns project completion status", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/project/proj-1/status");
      expect(res.status).toBe(200);
      expect(res.body.complete).toBe(false);
    });
  });

  // ── Callback router ───────────────────────────────────────

  describe("POST /callback/complete", () => {
    it("rejects missing job_id", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/callback/complete").send({ status: "completed" });
      expect(res.status).toBe(400);
    });

    it("handles failed job", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/callback/complete").send({
        job_id: "j1",
        status: "failed",
        error: "GPU OOM",
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Additional coverage ─────────────────────────────────────

  describe("GET /jobs/:id (found)", () => {
    it("returns an existing job", async () => {
      const { app, repo } = buildApp();
      repo._jobs.set("j1", { id: "j1", type: "txt2img", status: "pending" });
      const res = await request(app).get("/q/jobs/j1");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("j1");
    });
  });

  describe("DELETE /jobs/:id (success)", () => {
    it("cancels a pending job", async () => {
      const { app, repo } = buildApp();
      repo.cancelJob.mockReturnValue(true);
      const res = await request(app).delete("/q/jobs/j1");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("POST /jobs/:id/kill", () => {
    it("kills a dispatched job", async () => {
      const { app, repo, queueMaster } = buildApp();
      repo._jobs.set("j1", { id: "j1", status: "dispatched", targetNode: "m2-pro" });
      repo.killJob.mockReturnValue(true);
      const res = await request(app).post("/q/jobs/j1/kill");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(queueMaster.unloadNode).toHaveBeenCalledWith("m2-pro");
    });

    it("returns 404 for non-killable job status", async () => {
      const { app, repo } = buildApp();
      repo._jobs.set("j1", { id: "j1", status: "completed", targetNode: "m2-pro" });
      const res = await request(app).post("/q/jobs/j1/kill");
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing job", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs/missing/kill");
      expect(res.status).toBe(404);
    });

    it("returns 409 when killJob returns false", async () => {
      const { app, repo } = buildApp();
      repo._jobs.set("j1", { id: "j1", status: "dispatched", targetNode: "m2-pro" });
      repo.killJob.mockReturnValue(false);
      const res = await request(app).post("/q/jobs/j1/kill");
      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /assets/:id", () => {
    it("deletes an existing asset", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", file_path: "/tmp/test.png" });
      const res = await request(app).delete("/q/assets/a1");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("returns 404 for missing asset", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/q/assets/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /assets/upload", () => {
    it("uploads a file to gallery", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/assets/upload").send({
        filename: "test.png",
        data_base64: Buffer.from("fake-png").toString("base64"),
        mime_type: "image/png",
      });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
    });

    it("rejects missing required fields", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/assets/upload").send({ filename: "test.png" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /callback/complete (media)", () => {
    it("saves media and completes the job", async () => {
      const { app, repo, queueMaster } = buildApp();
      repo._jobs.set("j1", { id: "j1", type: "txt2img", status: "dispatched", payload: { prompt: "cat" }, requiredModel: "flux" });
      const res = await request(app).post("/q/callback/complete").send({
        job_id: "j1",
        status: "completed",
        media_base64: Buffer.from("fake-image").toString("base64"),
        media_type: "image/png",
        metadata: { width: 512, height: 512 },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.asset_id).toBeDefined();
      expect(res.body.result_url).toContain("/api/queue/assets/file/");
      expect(queueMaster.handleJobCompletion).toHaveBeenCalled();
      expect(repo.markComplete).toHaveBeenCalled();
    });
  });

  // ── NEW: Additional coverage ────────────────────────────────────

  describe("POST /callback/complete — edge cases", () => {
    it("rejects missing status", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/callback/complete").send({ job_id: "j1" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("required");
    });

    it("handles failed status with default error message", async () => {
      const { app, queueMaster } = buildApp();
      const res = await request(app).post("/q/callback/complete").send({
        job_id: "j1",
        status: "failed",
      });
      expect(res.status).toBe(200);
      expect(queueMaster.handleJobCompletion).toHaveBeenCalledWith("j1", { error: "Unknown worker error" });
    });

    it("handles completion without media_base64", async () => {
      const { app, queueMaster } = buildApp();
      const res = await request(app).post("/q/callback/complete").send({
        job_id: "j1",
        status: "completed",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.result_url).toBeFalsy();
      expect(queueMaster.handleJobCompletion).toHaveBeenCalled();
    });

    it("returns 500 when handleJobCompletion throws", async () => {
      const { app, queueMaster } = buildApp();
      queueMaster.handleJobCompletion.mockRejectedValueOnce(new Error("DB error"));
      const res = await request(app).post("/q/callback/complete").send({
        job_id: "j1",
        status: "failed",
        error: "boom",
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("DB error");
    });

    it("saves video media type correctly", async () => {
      const { app, repo } = buildApp();
      repo._jobs.set("j1", { id: "j1", type: "txt2video", status: "dispatched", payload: { prompt: "cat" } });
      const res = await request(app).post("/q/callback/complete").send({
        job_id: "j1",
        status: "completed",
        media_base64: Buffer.from("fake-video").toString("base64"),
        media_type: "video/mp4",
        metadata: { duration: 5 },
      });
      expect(res.status).toBe(200);
      expect(res.body.result_url).toContain(".mp4");
    });

    it("saves audio media type correctly", async () => {
      const { app, repo } = buildApp();
      repo._jobs.set("j1", { id: "j1", type: "tts", status: "dispatched", payload: { prompt: "hello" } });
      const res = await request(app).post("/q/callback/complete").send({
        job_id: "j1",
        status: "completed",
        media_base64: Buffer.from("fake-audio").toString("base64"),
        media_type: "audio/wav",
      });
      expect(res.status).toBe(200);
      expect(res.body.result_url).toContain(".wav");
    });
  });

  describe("POST /jobs — additional validation", () => {
    it("handles missing payload entirely", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({ type: "txt2img" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("payload");
    });

    it("accepts img2video with valid frame count", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({
        type: "img2video",
        payload: { prompt: "a dog", num_frames: 100 },
      });
      expect(res.status).toBe(201);
    });

    it("rejects img2video with too many frames", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/jobs").send({
        type: "img2video",
        payload: { prompt: "a dog", num_frames: 999 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("exceeds maximum");
    });

    it("returns 500 when repo.createJob throws", async () => {
      const { app, repo } = buildApp();
      repo.createJob.mockImplementation(() => { throw new Error("DB insert error"); });
      const res = await request(app).post("/q/jobs").send({
        type: "txt2img",
        payload: { prompt: "a cat" },
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("DB insert error");
    });

    it("passes priority and projectId to repo", async () => {
      const { app, repo } = buildApp();
      await request(app).post("/q/jobs").send({
        type: "txt2img",
        payload: { prompt: "a cat" },
        priority: 5,
        projectId: "proj-99",
      });
      expect(repo.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 5, projectId: "proj-99" }),
      );
    });
  });

  describe("GET /jobs — with filters", () => {
    it("passes query filters to repo", async () => {
      const { app, repo } = buildApp();
      await request(app).get("/q/jobs?status=pending&type=txt2img&projectId=proj-1&limit=10&offset=5");
      expect(repo.listJobs).toHaveBeenCalledWith(
        expect.objectContaining({ status: "pending", type: "txt2img", projectId: "proj-1", limit: 10, offset: 5 }),
      );
    });

    it("returns 500 when repo.listJobs throws", async () => {
      const { app, repo } = buildApp();
      repo.listJobs.mockImplementation(() => { throw new Error("SQL error"); });
      const res = await request(app).get("/q/jobs");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /jobs/stats — error path", () => {
    it("returns 500 when countByStatus throws", async () => {
      const { app, repo } = buildApp();
      repo.countByStatus.mockImplementation(() => { throw new Error("DB error"); });
      const res = await request(app).get("/q/jobs/stats");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /jobs/:id/kill — unloadNode failure tolerated", () => {
    it("succeeds even when unloadNode throws", async () => {
      const { app, repo, queueMaster } = buildApp();
      repo._jobs.set("j1", { id: "j1", status: "processing", targetNode: "m2-pro" });
      repo.killJob.mockReturnValue(true);
      queueMaster.unloadNode.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const res = await request(app).post("/q/jobs/j1/kill");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /assets — error path", () => {
    it("returns 500 when listAssets throws", async () => {
      const { app, repo } = buildApp();
      repo.listAssets.mockImplementation(() => { throw new Error("DB error"); });
      const res = await request(app).get("/q/assets");
      expect(res.status).toBe(500);
    });
  });

  describe("PATCH /assets/:id/tags — error path", () => {
    it("returns 500 when updateAssetTags throws", async () => {
      const { app, repo } = buildApp();
      repo.updateAssetTags.mockImplementation(() => { throw new Error("DB error"); });
      const res = await request(app).patch("/q/assets/a1/tags").send({ tags: ["t1"] });
      expect(res.status).toBe(500);
    });
  });

  describe("POST /nodes/:node/unload — error path", () => {
    it("returns 500 when unloadNode throws", async () => {
      const { app, queueMaster } = buildApp();
      queueMaster.unloadNode.mockRejectedValueOnce(new Error("timeout"));
      const res = await request(app).post("/q/nodes/mac-mini/unload");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /nodes — error path", () => {
    it("returns 500 when getNodeStatuses throws", async () => {
      const { app, queueMaster } = buildApp();
      queueMaster.getNodeStatuses.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const res = await request(app).get("/q/nodes");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /nodes/switch — error path", () => {
    it("returns 500 when switchActiveNode throws", async () => {
      const { app, queueMaster } = buildApp();
      queueMaster.switchActiveNode.mockRejectedValueOnce(new Error("fail"));
      const res = await request(app).post("/q/nodes/switch").send({ targetNode: "mac-mini" });
      expect(res.status).toBe(500);
    });

    it("rejects missing targetNode", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/nodes/switch").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /assets/upload — error path", () => {
    it("returns 500 when write fails", async () => {
      const { app, repo } = buildApp();
      repo.createAsset.mockImplementation(() => { throw new Error("disk full"); });
      const res = await request(app).post("/q/assets/upload").send({
        filename: "test.png",
        data_base64: Buffer.from("data").toString("base64"),
        mime_type: "image/png",
      });
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /assets/:id — error path", () => {
    it("returns 500 when deleteAsset throws", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", file_path: "/tmp/test.png" });
      repo.deleteAsset.mockImplementation(() => { throw new Error("DB error"); });
      const res = await request(app).delete("/q/assets/a1");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /assets/file/:filename", () => {
    it("returns 404 for missing file", async () => {
      const fsModule = await import("node:fs/promises");
      (fsModule.default.access as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ENOENT"));
      const { app } = buildApp();
      const res = await request(app).get("/q/assets/file/missing.png");
      expect(res.status).toBe(404);
    });
  });

  // ── GET /assets/folders ────────────────────────────────────

  describe("GET /assets/folders", () => {
    it("returns folder list", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/assets/folders");
      expect(res.status).toBe(200);
      expect(res.body.folders).toHaveLength(2);
      expect(res.body.folders[0].folder).toBe("renders");
    });
  });

  // ── PATCH /assets/:id/knowledge ────────────────────────────

  describe("PATCH /assets/:id/knowledge", () => {
    it("returns 404 for unknown asset", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/missing/knowledge").send({ visibility: "public" });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid visibility", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "test.png" });
      const res = await request(app).patch("/q/assets/a1/knowledge").send({ visibility: "bogus" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("visibility");
    });

    it("returns 400 for invalid category", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "test.png" });
      const res = await request(app).patch("/q/assets/a1/knowledge").send({ category: "bogus" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("category");
    });

    it("updates knowledge metadata", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "test.png" });
      const res = await request(app).patch("/q/assets/a1/knowledge").send({ visibility: "internal", category: "document" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.visibility).toBe("internal");
      expect(res.body.category).toBe("document");
      expect(repo.updateAssetKnowledgeMeta).toHaveBeenCalledWith("a1", "internal", "document");
    });
  });

  // ── PATCH /assets/:id/folder ───────────────────────────────

  describe("PATCH /assets/:id/folder", () => {
    it("returns 404 for unknown asset", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/missing/folder").send({ folder: "test" });
      expect(res.status).toBe(404);
    });

    it("moves asset to folder", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "test.png" });
      const res = await request(app).patch("/q/assets/a1/folder").send({ folder: "renders" });
      expect(res.status).toBe(200);
      expect(res.body.folder).toBe("renders");
      expect(repo.updateAssetFolder).toHaveBeenCalledWith("a1", "renders");
    });

    it("clears folder with null", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "test.png" });
      const res = await request(app).patch("/q/assets/a1/folder").send({ folder: null });
      expect(res.status).toBe(200);
      expect(res.body.folder).toBeNull();
    });
  });

  // ── PATCH /assets/:id/rename ───────────────────────────────

  describe("PATCH /assets/:id/rename", () => {
    it("returns 400 for missing filename", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/a1/rename").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("filename");
    });

    it("returns 404 for unknown asset", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/missing/rename").send({ filename: "new.png" });
      expect(res.status).toBe(404);
    });

    it("renames asset with sanitized basename", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "old.png" });
      const res = await request(app).patch("/q/assets/a1/rename").send({ filename: "/dodgy/path/new.png" });
      expect(res.status).toBe(200);
      expect(res.body.filename).toBe("new.png");
      expect(repo.renameAsset).toHaveBeenCalledWith("a1", "new.png");
    });
  });

  // ── PATCH /assets/:id/description ──────────────────────────

  describe("PATCH /assets/:id/description", () => {
    it("returns 400 for missing prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/a1/description").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("prompt");
    });

    it("returns 404 for unknown asset", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/q/assets/missing/description").send({ prompt: "A cat" });
      expect(res.status).toBe(404);
    });

    it("updates description", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "test.png" });
      const res = await request(app).patch("/q/assets/a1/description").send({ prompt: "Updated description" });
      expect(res.status).toBe(200);
      expect(res.body.prompt).toBe("Updated description");
      expect(repo.updateAssetDescription).toHaveBeenCalledWith("a1", "Updated description");
    });
  });

  // ── POST /assets/scenes ────────────────────────────────────

  describe("POST /assets/scenes", () => {
    it("returns 400 for missing scene", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/assets/scenes").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("scene");
    });

    it("saves scene asset", async () => {
      const { app, repo } = buildApp();
      const res = await request(app).post("/q/assets/scenes").send({
        scene: { title: "Test Scene", scriptText: "Hello world" },
        title: "My Scene",
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(repo.createAsset).toHaveBeenCalled();
    });
  });

  // ── GET /assets/scenes/:id/data ────────────────────────────

  describe("GET /assets/scenes/:id/data", () => {
    it("returns 404 for non-scene asset", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "test.png" });
      const res = await request(app).get("/q/assets/scenes/a1/data");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown asset", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/assets/scenes/missing/data");
      expect(res.status).toBe(404);
    });
  });

  // ── GET /assets/:id/file ───────────────────────────────────

  describe("GET /assets/:id/file", () => {
    it("returns 404 for unknown asset", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/q/assets/missing/file");
      expect(res.status).toBe(404);
    });

    it("returns 403 for file outside home dir", async () => {
      const { app, repo } = buildApp();
      repo._assets.set("a1", { id: "a1", type: "image", filename: "evil.png", file_path: "/etc/passwd" });
      const res = await request(app).get("/q/assets/a1/file");
      expect(res.status).toBe(403);
    });
  });

  // ── POST /callback/progress ────────────────────────────────

  describe("POST /callback/progress", () => {
    it("returns 400 for missing job_id", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/callback/progress").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("job_id");
    });

    it("reports progress", async () => {
      const { app, queueMaster } = buildApp();
      const res = await request(app).post("/q/callback/progress").send({
        job_id: "j1",
        stage: "rendering",
        progress: 50,
        message: "Halfway there",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(queueMaster.reportProgress).toHaveBeenCalledWith("j1", {
        stage: "rendering",
        progress: 50,
        message: "Halfway there",
      });
    });
  });

  // ── POST /image/generate ───────────────────────────────────

  describe("POST /image/generate", () => {
    it("returns 400 for missing prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/image/generate").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("prompt");
    });

    it("returns 400 for empty prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/q/image/generate").send({ prompt: "   " });
      expect(res.status).toBe(400);
    });
  });
});
