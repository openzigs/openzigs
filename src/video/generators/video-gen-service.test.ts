/**
 * Video Generation Service — Tests
 * Issue #330: Tests for the queue-integrated video gen wrapper.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MediaQueueRepository } from "../../queue/media-queue-repository.js";
import { VideoGenService } from "./video-gen-service.js";

function createTestSetup() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new MediaQueueRepository(db);
  repo.migrate();
  const service = new VideoGenService(repo);
  return { repo, service };
}

describe("VideoGenService", () => {
  let repo: MediaQueueRepository;
  let service: VideoGenService;

  beforeEach(() => {
    ({ repo, service } = createTestSetup());
  });

  it("submits a txt2video job to the queue", async () => {
    const result = await service.submitTextToVideo({
      prompt: "aerial shot of coastal city",
      width: 768,
      height: 512,
    });

    expect(result.jobId).toBeTruthy();
    expect(result.status).toBe("pending");

    const job = repo.getJob(result.jobId)!;
    expect(job.type).toBe("txt2video");
    expect(job.targetNode).toBe("m2-pro");
    expect(job.payload.prompt).toBe("aerial shot of coastal city");
    expect(job.payload.num_frames).toBe(97);
  });

  it("enforces max frame limit", async () => {
    const result = await service.submitTextToVideo({
      prompt: "test",
      numFrames: 200, // over limit
    });

    const job = repo.getJob(result.jobId)!;
    expect(job.payload.num_frames).toBe(97); // clamped to max
  });

  it("submits an img2video job", async () => {
    const result = await service.submitImageToVideo({
      prompt: "animate this landscape",
      initImage: "base64datahere",
    });

    const job = repo.getJob(result.jobId)!;
    expect(job.type).toBe("img2video");
    expect(job.payload.init_image).toBe("base64datahere");
  });

  it("rejects img2video without init image", async () => {
    await expect(
      service.submitImageToVideo({ prompt: "test" }),
    ).rejects.toThrow("initImage (base64) is required");
  });

  it("sets project ID on jobs", async () => {
    const result = await service.submitTextToVideo({
      prompt: "test",
      projectId: "proj-xyz",
    });

    const job = repo.getJob(result.jobId)!;
    expect(job.projectId).toBe("proj-xyz");
  });

  it("getJobStatus returns null for missing job", () => {
    expect(service.getJobStatus("nonexistent")).toBeNull();
  });

  it("getJobStatus reflects completion", async () => {
    const result = await service.submitTextToVideo({ prompt: "test" });
    repo.markComplete(result.jobId, "/gallery/video.mp4", {}, "asset-1");

    const status = service.getJobStatus(result.jobId)!;
    expect(status.status).toBe("complete");
    expect(status.resultUrl).toBe("/gallery/video.mp4");
    expect(status.galleryAssetId).toBe("asset-1");
  });
});
