/**
 * Media Queue Repository — Tests
 * Issue #326: Tests for SQLite-backed media job and asset persistence.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MediaQueueRepository } from "./media-queue-repository.js";

function createTestRepo(clock?: () => Date): MediaQueueRepository {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new MediaQueueRepository(db, clock);
  repo.migrate();
  return repo;
}

describe("MediaQueueRepository", () => {
  let repo: MediaQueueRepository;
  const now = new Date("2026-02-09T12:00:00Z");

  beforeEach(() => {
    repo = createTestRepo(() => now);
  });

  // ── Job CRUD ──────────────────────────────────────────────

  describe("jobs", () => {
    it("creates a job with correct defaults", () => {
      const job = repo.createJob({
        type: "txt2img",
        payload: { prompt: "a red fox" },
      });

      expect(job.id).toBeTruthy();
      expect(job.type).toBe("txt2img");
      expect(job.requiredModel).toBe("flux-schnell");
      expect(job.targetNode).toBe("image-gen");
      expect(job.status).toBe("pending");
      expect(job.payload.prompt).toBe("a red fox");
      expect(job.priority).toBe(0);
      expect(job.retries).toBe(0);
    });

    it("creates video jobs targeting m2-pro", () => {
      const job = repo.createJob({
        type: "txt2video",
        payload: { prompt: "aerial coastline" },
      });

      expect(job.targetNode).toBe("m2-pro");
      expect(job.requiredModel).toBe("ltx-2");
    });

    it("creates tts jobs targeting m2-pro", () => {
      const job = repo.createJob({
        type: "tts",
        payload: { prompt: "Hello world" },
      });

      expect(job.targetNode).toBe("m2-pro");
      expect(job.requiredModel).toBe("f5-tts");
    });

    it("gets a job by id", () => {
      const created = repo.createJob({
        type: "txt2img",
        payload: { prompt: "test" },
      });

      const fetched = repo.getJob(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("returns null for nonexistent job", () => {
      expect(repo.getJob("nonexistent")).toBeNull();
    });

    it("lists pending jobs by target node", () => {
      repo.createJob({ type: "txt2img", payload: { prompt: "img1" } });
      repo.createJob({ type: "txt2video", payload: { prompt: "vid1" } });
      repo.createJob({ type: "txt2img", payload: { prompt: "img2" } });

      const macMiniPending = repo.getPendingJobs("image-gen");
      expect(macMiniPending).toHaveLength(2);

      const m2ProPending = repo.getPendingJobs("m2-pro");
      expect(m2ProPending).toHaveLength(1);
    });

    it("marks dispatched", () => {
      const job = repo.createJob({ type: "txt2img", payload: { prompt: "t" } });
      repo.markDispatched(job.id);
      const updated = repo.getJob(job.id)!;
      expect(updated.status).toBe("dispatched");
      expect(updated.dispatchedAt).toBeTruthy();
    });

    it("marks processing", () => {
      const job = repo.createJob({ type: "txt2img", payload: { prompt: "t" } });
      repo.markProcessing(job.id);
      expect(repo.getJob(job.id)!.status).toBe("processing");
    });

    it("marks complete with URL and metadata", () => {
      const job = repo.createJob({ type: "txt2img", payload: { prompt: "t" } });
      repo.markComplete(job.id, "/gallery/test.png", { width: 1024 }, "asset-1");

      const updated = repo.getJob(job.id)!;
      expect(updated.status).toBe("complete");
      expect(updated.resultUrl).toBe("/gallery/test.png");
      expect(updated.resultMetadata).toEqual({ width: 1024 });
      expect(updated.galleryAssetId).toBe("asset-1");
    });

    it("retries on failure if under max retries", () => {
      const job = repo.createJob({ type: "txt2img", payload: { prompt: "t" } });
      repo.markFailed(job.id, "timeout");

      const updated = repo.getJob(job.id)!;
      expect(updated.status).toBe("pending");
      expect(updated.retries).toBe(1);
    });

    it("fails permanently at max retries", () => {
      const job = repo.createJob({ type: "txt2img", payload: { prompt: "t" } });
      // Mark failed 4 times (max_retries defaults to 3)
      for (let i = 0; i < 4; i++) {
        repo.markFailed(job.id, `error ${i}`);
      }

      const updated = repo.getJob(job.id)!;
      expect(updated.status).toBe("failed");
    });

    it("cancels a pending job", () => {
      const job = repo.createJob({ type: "txt2img", payload: { prompt: "t" } });
      const cancelled = repo.cancelJob(job.id);
      expect(cancelled).toBe(true);
      expect(repo.getJob(job.id)!.status).toBe("failed");
    });

    it("cannot cancel a non-pending job", () => {
      const job = repo.createJob({ type: "txt2img", payload: { prompt: "t" } });
      repo.markDispatched(job.id);
      expect(repo.cancelJob(job.id)).toBe(false);
    });

    it("lists with filters", () => {
      repo.createJob({ type: "txt2img", payload: { prompt: "a" }, projectId: "p1" });
      repo.createJob({ type: "txt2video", payload: { prompt: "b" }, projectId: "p1" });
      repo.createJob({ type: "txt2img", payload: { prompt: "c" }, projectId: "p2" });

      expect(repo.listJobs({ type: "txt2img" })).toHaveLength(2);
      expect(repo.listJobs({ projectId: "p1" })).toHaveLength(2);
      expect(repo.listJobs({ projectId: "p2" })).toHaveLength(1);
    });

    it("counts by status", () => {
      repo.createJob({ type: "txt2img", payload: { prompt: "a" } });
      repo.createJob({ type: "txt2img", payload: { prompt: "b" } });
      const j3 = repo.createJob({ type: "txt2img", payload: { prompt: "c" } });
      repo.markComplete(j3.id, "/done.png");

      const counts = repo.countByStatus();
      expect(counts.pending).toBe(2);
      expect(counts.complete).toBe(1);
    });

    it("getPendingJobsForModel filters by model", () => {
      repo.createJob({ type: "txt2video", payload: { prompt: "a" } }); // ltx-2
      repo.createJob({ type: "tts", payload: { prompt: "b" } }); // f5-tts

      const ltxJobs = repo.getPendingJobsForModel("m2-pro", "ltx-2");
      expect(ltxJobs).toHaveLength(1);
      expect(ltxJobs[0].requiredModel).toBe("ltx-2");

      const ttsJobs = repo.getPendingJobsForModel("m2-pro", "f5-tts");
      expect(ttsJobs).toHaveLength(1);
    });
  });

  // ── Project Completion ────────────────────────────────────

  describe("projects", () => {
    it("reports project as incomplete when jobs remain", () => {
      repo.createJob({ type: "txt2img", payload: { prompt: "a" }, projectId: "proj-1" });
      repo.createJob({ type: "txt2img", payload: { prompt: "b" }, projectId: "proj-1" });

      const status = repo.isProjectComplete("proj-1");
      expect(status.complete).toBe(false);
      expect(status.total).toBe(2);
      expect(status.done).toBe(0);
    });

    it("reports project as complete when all jobs are done", () => {
      const j1 = repo.createJob({ type: "txt2img", payload: { prompt: "a" }, projectId: "proj-1" });
      const j2 = repo.createJob({ type: "txt2img", payload: { prompt: "b" }, projectId: "proj-1" });

      repo.markComplete(j1.id, "/a.png");
      repo.markComplete(j2.id, "/b.png");

      const status = repo.isProjectComplete("proj-1");
      expect(status.complete).toBe(true);
      expect(status.done).toBe(2);
    });
  });

  // ── Assets CRUD ───────────────────────────────────────────

  describe("assets", () => {
    it("creates and gets an asset", () => {
      const id = repo.createAsset({
        type: "image",
        filename: "test.png",
        filePath: "/gallery/test.png",
        mimeType: "image/png",
        fileSizeBytes: 1024,
        width: 512,
        height: 512,
        prompt: "a fox",
        model: "flux-schnell",
        source: "generated",
      });

      const asset = repo.getAsset(id);
      expect(asset).not.toBeNull();
      expect(asset!.type).toBe("image");
      expect(asset!.filename).toBe("test.png");
      expect(asset!.prompt).toBe("a fox");
    });

    it("lists assets with type filter", () => {
      repo.createAsset({
        type: "image",
        filename: "img.png",
        filePath: "/gallery/img.png",
        mimeType: "image/png",
        source: "generated",
      });
      repo.createAsset({
        type: "video",
        filename: "vid.mp4",
        filePath: "/gallery/vid.mp4",
        mimeType: "video/mp4",
        source: "generated",
      });

      const images = repo.listAssets({ type: "image" });
      expect(images).toHaveLength(1);

      const all = repo.listAssets();
      expect(all).toHaveLength(2);
    });

    it("deletes an asset", () => {
      const id = repo.createAsset({
        type: "image",
        filename: "x.png",
        filePath: "/gallery/x.png",
        mimeType: "image/png",
        source: "uploaded",
      });

      expect(repo.deleteAsset(id)).toBe(true);
      expect(repo.getAsset(id)).toBeNull();
    });

    it("updates asset tags", () => {
      const id = repo.createAsset({
        type: "image",
        filename: "tagged.png",
        filePath: "/gallery/tagged.png",
        mimeType: "image/png",
        source: "generated",
      });

      repo.updateAssetTags(id, ["hero", "landscape"]);
      const asset = repo.getAsset(id);
      expect(asset!.tags).toEqual(["hero", "landscape"]);
    });

    it("handles generation params JSON round-trip", () => {
      const id = repo.createAsset({
        type: "video",
        filename: "v.mp4",
        filePath: "/gallery/v.mp4",
        mimeType: "video/mp4",
        source: "generated",
        generationParams: { width: 768, height: 512, fps: 24 },
      });

      const asset = repo.getAsset(id);
      expect(asset!.generation_params).toEqual({ width: 768, height: 512, fps: 24 });
    });
  });

  // ── Remix Lab Jobs ────────────────────────────────────────

  describe("remix jobs", () => {
    it("creates remix_analyze jobs targeting local", () => {
      const job = repo.createJob({
        type: "remix_analyze",
        payload: { prompt: "", source_asset_id: "asset-123", device: "cpu" },
      });

      expect(job.targetNode).toBe("local");
      expect(job.requiredModel).toBe("htdemucs_6s");
      expect(job.status).toBe("pending");
    });

    it("creates remix_replace jobs targeting local", () => {
      const job = repo.createJob({
        type: "remix_replace",
        payload: {
          prompt: "",
          source_stem_url: "/path/to/stem.wav",
          target_instrument_id: "grand_piano",
        },
      });

      expect(job.targetNode).toBe("local");
      expect(job.requiredModel).toBe("basic-pitch");
    });

    it("creates remix_master jobs targeting local", () => {
      const job = repo.createJob({
        type: "remix_master",
        payload: {
          prompt: "",
          stem_paths: { vocals: "/v.wav", drums: "/d.wav" },
          volumes: { vocals: 1.0, drums: 0.8 },
          muted: { vocals: false, drums: false },
          vibe: "warm_lofi",
        },
      });

      expect(job.targetNode).toBe("local");
      expect(job.requiredModel).toBe("matchering");
    });

    it("getPendingJobsForModel finds remix_analyze jobs", () => {
      repo.createJob({
        type: "remix_analyze",
        payload: { prompt: "", source_asset_id: "a1" },
      });
      repo.createJob({
        type: "voice2voice",
        payload: { prompt: "v2v", source_asset_id: "a2" },
      });

      const analyzeJobs = repo.getPendingJobsForModel("local", "htdemucs_6s");
      expect(analyzeJobs).toHaveLength(1);
      expect(analyzeJobs[0].type).toBe("remix_analyze");

      const v2vJobs = repo.getPendingJobsForModel("local", "seed-vc");
      expect(v2vJobs).toHaveLength(1);
      expect(v2vJobs[0].type).toBe("voice2voice");
    });

    it("stores remix payload fields through JSON round-trip", () => {
      const job = repo.createJob({
        type: "remix_master",
        payload: {
          prompt: "",
          stem_paths: { vocals: "/v.wav", bass: "/b.wav" },
          volumes: { vocals: 1.2, bass: 0.9 },
          muted: { vocals: false, bass: true },
          vibe: "cinematic_wide",
        },
      });

      const fetched = repo.getJob(job.id)!;
      expect(fetched.payload.stem_paths).toEqual({ vocals: "/v.wav", bass: "/b.wav" });
      expect(fetched.payload.volumes).toEqual({ vocals: 1.2, bass: 0.9 });
      expect(fetched.payload.muted).toEqual({ vocals: false, bass: true });
      expect(fetched.payload.vibe).toBe("cinematic_wide");
    });
  });
});
