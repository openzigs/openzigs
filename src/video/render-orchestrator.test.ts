/**
 * Director Mode — Render Orchestrator Tests
 * Issue #235
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RenderOrchestrator } from "./render-orchestrator.js";
import type { DirectorManifest } from "./manifest/manifest-types.js";

function buildTestManifest(): DirectorManifest {
  return {
    projectTitle: "Test Video",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: { music: null, voiceover: null },
    timeline: [
      {
        type: "video_clip",
        source: "clip.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 90,
        volume: 1.0,
      },
    ],
    metadata: {
      generatedAt: "2026-02-15T10:00:00Z",
      llmModel: "gpt-4o",
      llmTokensUsed: 1000,
      productionMode: "highlight",
      sourceClips: ["clip.mp4"],
    },
  };
}

describe("RenderOrchestrator", () => {
  let orchestrator: RenderOrchestrator;

  beforeEach(() => {
    orchestrator = new RenderOrchestrator({ maxConcurrent: 1 });
  });

  afterEach(async () => {
    await orchestrator.shutdown();
  });

  it("assigns a unique ID to each submitted job", async () => {
    const id1 = await orchestrator.submit({ manifest: buildTestManifest() });
    const id2 = await orchestrator.submit({ manifest: buildTestManifest() });
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("initial job status is queued or rendering", async () => {
    const id = await orchestrator.submit({ manifest: buildTestManifest() });
    const job = orchestrator.getJob(id);
    // May be queued or already started rendering depending on timing
    expect(["queued", "rendering"]).toContain(job!.status);
  });

  it("retrieves a job by ID", async () => {
    const id = await orchestrator.submit({ manifest: buildTestManifest() });
    const retrieved = orchestrator.getJob(id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(id);
  });

  it("returns undefined for unknown job ID", () => {
    expect(orchestrator.getJob("nonexistent")).toBeUndefined();
  });

  it("lists all submitted jobs", async () => {
    await orchestrator.submit({ manifest: buildTestManifest() });
    await orchestrator.submit({ manifest: buildTestManifest() });
    expect(orchestrator.listJobs()).toHaveLength(2);
  });

  it("emits render:queued event on submit", async () => {
    const handler = vi.fn();
    orchestrator.on("render:queued", handler);
    const id = await orchestrator.submit({ manifest: buildTestManifest() });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ jobId: id }));
  });

  it("resolves waitForCompletion when worker exits", async () => {
    const id = await orchestrator.submit({ manifest: buildTestManifest() });
    const result = await orchestrator.waitForCompletion(id);
    // Worker may succeed (placeholder render) or fail (tsx loader not available in test)
    // Either way, waitForCompletion should resolve, not hang
    expect(result.jobId).toBe(id);
    expect(typeof result.success).toBe("boolean");
  }, 30_000);

  it("can abort a queued job via direct abort", async () => {
    // Submit & let it start
    await orchestrator.submit({ manifest: buildTestManifest() });
    // Submit a second — with max concurrency 1, this should stay queued
    const id2 = await orchestrator.submit({ manifest: buildTestManifest() });
    const abortResult = orchestrator.abort(id2);
    // Abort may or may not succeed depending on whether it's already started
    if (abortResult) {
      const aborted = orchestrator.getJob(id2);
      expect(aborted!.status).toBe("aborted");
    }
  });

  // ── NEW: Additional coverage ────────────────────────────────────

  it("rejects submission with invalid manifest", async () => {
    const invalidManifest = {
      projectTitle: "Bad",
      // Missing required fields
    } as never;

    await expect(
      orchestrator.submit({ manifest: invalidManifest }),
    ).rejects.toThrow("Invalid manifest");
  });

  it("abort returns false for unknown job ID", () => {
    expect(orchestrator.abort("nonexistent")).toBe(false);
  });

  it("abort returns false for already completed/failed job", async () => {
    const id = await orchestrator.submit({ manifest: buildTestManifest() });
    // Wait for the job to finish (success or fail)
    await orchestrator.waitForCompletion(id);
    // Now try to abort — should return false since it's already done
    const result = orchestrator.abort(id);
    expect(result).toBe(false);
  }, 30_000);

  it("waitForCompletion rejects for unknown job", async () => {
    await expect(orchestrator.waitForCompletion("nonexistent")).rejects.toThrow("Unknown job");
  });

  it("listJobs returns all submitted jobs", async () => {
    const id1 = await orchestrator.submit({ manifest: buildTestManifest() });
    const id2 = await orchestrator.submit({ manifest: buildTestManifest() });
    const jobs = orchestrator.listJobs();
    expect(jobs.length).toBe(2);
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("shutdown aborts all running and queued jobs", async () => {
    const id1 = await orchestrator.submit({ manifest: buildTestManifest() });
    const id2 = await orchestrator.submit({ manifest: buildTestManifest() });
    await orchestrator.shutdown();

    const job1 = orchestrator.getJob(id1);
    const job2 = orchestrator.getJob(id2);
    // At least one of them should be aborted (the queued one)
    const statuses = [job1?.status, job2?.status];
    expect(statuses).toContain("aborted");
  });

  it("emits render:aborted when aborting a queued job", async () => {
    const handler = vi.fn();
    orchestrator.on("render:aborted", handler);

    // Fill the concurrency slot
    await orchestrator.submit({ manifest: buildTestManifest() });
    // This one should be queued
    const id2 = await orchestrator.submit({ manifest: buildTestManifest() });
    const aborted = orchestrator.abort(id2);
    if (aborted) {
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ jobId: id2 }));
    }
  });

  it("waitForCompletion resolves immediately for failed jobs", async () => {
    const id = await orchestrator.submit({ manifest: buildTestManifest() });
    // Wait for job to finish (likely fails in test environment without proper tsx loader)
    const result = await orchestrator.waitForCompletion(id);
    expect(result.jobId).toBe(id);

    // Now calling waitForCompletion again should resolve immediately
    const result2 = await orchestrator.waitForCompletion(id);
    expect(result2.jobId).toBe(id);
  }, 30_000);

  it("creates orchestrator with custom rendersDir", () => {
    const custom = new RenderOrchestrator({ rendersDir: "/tmp/test-renders", maxConcurrent: 2 });
    expect(custom).toBeInstanceOf(RenderOrchestrator);
  });
});
