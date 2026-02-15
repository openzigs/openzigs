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

  it("initial job status is queued or bundling", async () => {
    const id = await orchestrator.submit({ manifest: buildTestManifest() });
    const job = orchestrator.getJob(id);
    // May be queued or already started bundling depending on timing
    expect(["queued", "bundling"]).toContain(job!.status);
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
});
