/**
 * AnalyzeWorker Unit Tests
 * Issue #444
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnalyzeWorker } from "./analyze-worker.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter } = require("node:events");
  return {
    spawn: vi.fn().mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      setTimeout(() => proc.emit("close", 0), 10);
      return proc;
    }),
  };
});

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([
    "frame_0001.jpg",
    "frame_0002.jpg",
    "frame_0003.jpg",
  ]),
  readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-jpg-data")),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue(["frame_0001.jpg", "frame_0002.jpg", "frame_0003.jpg"]),
    readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-jpg-data")),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

describe("AnalyzeWorker", () => {
  let worker: AnalyzeWorker;
  let mockVisionChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVisionChat = vi.fn().mockResolvedValue(
      JSON.stringify([
        { start: 5, end: 12, reason: "Repeated sentence" },
        { start: 30, end: 35, reason: "Dead space" },
      ]),
    );
    worker = new AnalyzeWorker({
      visionChat: mockVisionChat,
      maxFramesPerBatch: 10,
    });
  });

  it("assigns a unique ID to each submitted job", async () => {
    const id1 = await worker.submit({ assetId: "asset-1", inputPath: "/tmp/video1.mp4" });
    const id2 = await worker.submit({ assetId: "asset-2", inputPath: "/tmp/video2.mp4" });
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("emits analyze:queued event on submit", async () => {
    const handler = vi.fn();
    worker.on("analyze:queued", handler);
    const id = await worker.submit({ assetId: "asset-1", inputPath: "/tmp/video.mp4" });
    expect(handler).toHaveBeenCalledWith({ jobId: id });
  });

  it("retrieves a job by ID", async () => {
    const id = await worker.submit({ assetId: "asset-1", inputPath: "/tmp/video.mp4" });
    const job = worker.getJob(id);
    expect(job).toBeDefined();
    expect(job!.id).toBe(id);
    expect(job!.assetId).toBe("asset-1");
  });

  it("returns undefined for unknown job ID", () => {
    expect(worker.getJob("nonexistent")).toBeUndefined();
  });

  it("calls visionChat with frames on job execution", async () => {
    const id = await worker.submit({ assetId: "asset-1", inputPath: "/tmp/video.mp4" });
    await worker.waitForCompletion(id, 5000);
    expect(mockVisionChat).toHaveBeenCalled();
  });

  it("emits analyze:complete with suggested cuts", async () => {
    const handler = vi.fn();
    worker.on("analyze:complete", handler);
    const id = await worker.submit({ assetId: "asset-1", inputPath: "/tmp/video.mp4" });
    await worker.waitForCompletion(id, 5000);
    expect(handler).toHaveBeenCalledWith({
      jobId: id,
      suggestedCuts: expect.arrayContaining([
        expect.objectContaining({ start: 5, end: 12, reason: "Repeated sentence" }),
      ]),
    });
  });

  it("parseLLMResponse extracts valid JSON cuts", () => {
    const raw = `Here are the cuts: [{"start": 10, "end": 20, "reason": "Dead space"}, {"start": 40, "end": 50, "reason": "Repeat"}]`;
    const cuts = worker.parseLLMResponse(raw);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]).toEqual({ start: 10, end: 20, reason: "Dead space" });
  });

  it("parseLLMResponse returns empty for invalid JSON", () => {
    const cuts = worker.parseLLMResponse("I don't see any issues with this video.");
    expect(cuts).toEqual([]);
  });

  it("parseLLMResponse returns empty array for []", () => {
    const cuts = worker.parseLLMResponse("[]");
    expect(cuts).toEqual([]);
  });

  it("parseLLMResponse filters out invalid entries", () => {
    const raw = `[{"start": 10, "end": 20, "reason": "OK"}, {"start": "bad", "end": 20, "reason": "Invalid"}, {"start": 30, "end": 30, "reason": "Zero length"}]`;
    const cuts = worker.parseLLMResponse(raw);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].start).toBe(10);
  });

  it("waitForCompletion rejects for unknown job", async () => {
    await expect(worker.waitForCompletion("unknown-id", 1000)).rejects.toThrow("not found");
  });

  it("handles visionChat error gracefully", async () => {
    mockVisionChat.mockRejectedValue(new Error("LLM unavailable"));
    const handler = vi.fn();
    worker.on("analyze:failed", handler);
    const id = await worker.submit({ assetId: "asset-1", inputPath: "/tmp/video.mp4" });
    await new Promise((r) => setTimeout(r, 100));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id }),
    );
    expect(worker.getJob(id)!.status).toBe("failed");
  });
});
