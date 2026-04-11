/**
 * Reframe Worker — Unit Tests
 * Issue #818: AI Video Reframing.
 */

import { describe, it, expect, vi } from "vitest";
import { ReframeWorker, type ReframeWorkerChatFn } from "./reframe-worker.js";

function createMockChat(): ReframeWorkerChatFn {
  return async function* mockChat() {
    yield JSON.stringify({
      subjects: [
        {
          type: "person",
          boundingBox: { x: 100, y: 50, width: 200, height: 300 },
          label: "speaker",
        },
      ],
      contentType: "single-speaker",
      suggestedCropCenter: { x: 200, y: 200 },
    });
  };
}

describe("ReframeWorker", () => {
  it("creates a job and assigns an ID", async () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    vi.spyOn(worker as never, "runReframe" as never).mockResolvedValue(
      undefined as never,
    );

    const id = await worker.submit({
      source: "/tmp/test.mp4",
      targetAspect: "9:16",
    });

    expect(id).toMatch(/^reframe-/);
    const job = worker.getJob(id);
    expect(job).toBeDefined();
    expect(job!.targetAspect).toBe("9:16");
  });

  it("lists all jobs", async () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    vi.spyOn(worker as never, "runReframe" as never).mockResolvedValue(
      undefined as never,
    );

    await worker.submit({ source: "/tmp/a.mp4", targetAspect: "9:16" });
    await worker.submit({ source: "/tmp/b.mp4", targetAspect: "1:1" });

    const jobs = worker.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("emits reframe:queued on submit", async () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    vi.spyOn(worker as never, "runReframe" as never).mockResolvedValue(
      undefined as never,
    );

    const handler = vi.fn();
    worker.on("reframe:queued", handler);

    await worker.submit({ source: "/tmp/test.mp4", targetAspect: "9:16" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: expect.stringMatching(/^reframe-/) }),
    );
  });

  it("emits reframe:complete on success", async () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    vi.spyOn(worker as never, "runReframe" as never).mockResolvedValue(
      undefined as never,
    );

    const handler = vi.fn();
    worker.on("reframe:complete", handler);

    const id = await worker.submit({
      source: "/tmp/test.mp4",
      targetAspect: "9:16",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id }),
    );
  });

  it("emits reframe:failed on error", async () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    vi.spyOn(worker as never, "runReframe" as never).mockRejectedValue(
      new Error("Test failure"),
    );

    const handler = vi.fn();
    worker.on("reframe:failed", handler);

    const id = await worker.submit({
      source: "/tmp/test.mp4",
      targetAspect: "9:16",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id, error: "Test failure" }),
    );
  });

  it("waitForCompletion resolves on success", async () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    vi.spyOn(worker as never, "runReframe" as never).mockResolvedValue(
      undefined as never,
    );

    const id = await worker.submit({
      source: "/tmp/test.mp4",
      targetAspect: "9:16",
    });
    const job = await worker.waitForCompletion(id, 5000);
    expect(job.status).toBe("complete");
  });

  it("waitForCompletion rejects for unknown job", async () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    await expect(worker.waitForCompletion("nonexistent")).rejects.toThrow(
      "not found",
    );
  });

  it("sampleFrames method exists", () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    expect(typeof worker.sampleFrames).toBe("function");
  });

  it("getVideoDimensions method exists", () => {
    const worker = new ReframeWorker({ chat: createMockChat() });
    expect(typeof worker.getVideoDimensions).toBe("function");
  });
});
