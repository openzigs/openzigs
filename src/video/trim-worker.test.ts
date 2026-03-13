/**
 * TrimWorker Unit Tests
 * Issue #441
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { TrimWorker } from "./trim-worker.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  },
}));

import { spawn } from "node:child_process";
import fs from "node:fs";

function createMockProcess(exitCode = 0): EventEmitter & { stderr: EventEmitter; stdout: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter; stdout: EventEmitter };
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();

  // Simulate async completion
  setTimeout(() => {
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

describe("TrimWorker", () => {
  let worker: TrimWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new TrimWorker({ maxConcurrent: 1 });
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      createMockProcess(0),
    );
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it("assigns a unique ID to each submitted job", async () => {
    const id1 = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out1.mp4",
      startTime: 0,
      endTime: 10,
    });
    const id2 = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out2.mp4",
      startTime: 5,
      endTime: 15,
    });
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("initial job status is queued or processing", async () => {
    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    const job = worker.getJob(id);
    expect(["queued", "processing"]).toContain(job!.status);
  });

  it("retrieves a job by ID", async () => {
    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    const retrieved = worker.getJob(id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(id);
  });

  it("returns undefined for unknown job ID", () => {
    expect(worker.getJob("nonexistent")).toBeUndefined();
  });

  it("lists all submitted jobs", async () => {
    await worker.submit({ inputPath: "/a.mp4", outputPath: "/b.mp4", startTime: 0, endTime: 5 });
    await worker.submit({ inputPath: "/c.mp4", outputPath: "/d.mp4", startTime: 0, endTime: 5 });
    expect(worker.listJobs()).toHaveLength(2);
  });

  it("emits trim:queued event on submit", async () => {
    const handler = vi.fn();
    worker.on("trim:queued", handler);
    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    expect(handler).toHaveBeenCalledWith({ jobId: id });
  });

  it("emits trim:processing when job starts", async () => {
    const handler = vi.fn();
    worker.on("trim:processing", handler);
    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    // Processing is immediate for first job in queue
    await new Promise((r) => setTimeout(r, 5));
    expect(handler).toHaveBeenCalledWith({ jobId: id });
  });

  it("emits trim:complete on successful FFmpeg execution", async () => {
    const handler = vi.fn();
    worker.on("trim:complete", handler);
    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id }),
    );
    expect(worker.getJob(id)!.status).toBe("complete");
  });

  it("emits trim:failed when FFmpeg exits non-zero", async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      createMockProcess(1),
    );

    const handler = vi.fn();
    worker.on("trim:failed", handler);
    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id }),
    );
    expect(worker.getJob(id)!.status).toBe("failed");
  });

  it("emits trim:failed when input file does not exist", async () => {
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const handler = vi.fn();
    worker.on("trim:failed", handler);
    const id = await worker.submit({
      inputPath: "/nonexistent.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalled();
    expect(worker.getJob(id)!.status).toBe("failed");
  });

  it("waitForCompletion resolves on success", async () => {
    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    const job = await worker.waitForCompletion(id, 5000);
    expect(job.status).toBe("complete");
  });

  it("waitForCompletion rejects on failure", async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      createMockProcess(1),
    );

    const id = await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 0,
      endTime: 5,
    });
    await expect(worker.waitForCompletion(id, 5000)).rejects.toThrow();
  });

  it("waitForCompletion rejects for unknown job", async () => {
    await expect(worker.waitForCompletion("unknown-id", 1000)).rejects.toThrow("not found");
  });

  it("passes correct FFmpeg args for MP4 files", async () => {
    await worker.submit({
      inputPath: "/tmp/video.mp4",
      outputPath: "/tmp/out.mp4",
      startTime: 5,
      endTime: 15,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(spawn).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-ss", "5", "-to", "15", "-c", "copy", "-movflags", "+faststart"]),
      expect.any(Object),
    );
  });

  it("skips -movflags for WebM files", async () => {
    await worker.submit({
      inputPath: "/tmp/video.webm",
      outputPath: "/tmp/out.webm",
      startTime: 0,
      endTime: 5,
    });
    await new Promise((r) => setTimeout(r, 5));
    const callArgs = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(callArgs).not.toContain("-movflags");
  });
});
