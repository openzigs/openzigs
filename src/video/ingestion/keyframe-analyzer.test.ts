import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: { access: vi.fn() },
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import fs from "node:fs/promises";
import { analyzeKeyframes } from "./keyframe-analyzer.js";
import type { KeyframeInfo } from "./types.js";

function makeKeyframe(overrides: Partial<KeyframeInfo> = {}): KeyframeInfo {
  return {
    timestamp: 1.0,
    framePath: "/tmp/frame-001.jpg",
    sceneScore: 0.5,
    description: undefined,
    ...overrides,
  };
}

function makeCopilot(response: string) {
  return {
    chat: vi.fn().mockImplementation(function* () {
      yield response;
    }),
  } as any;
}

describe("keyframe-analyzer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.access).mockResolvedValue(undefined);
  });

  it("returns zeros when keyframes array is empty", async () => {
    const copilot = makeCopilot("");
    const result = await analyzeKeyframes([], copilot);
    expect(result).toEqual({ analyzed: 0, skipped: 0, failed: 0 });
  });

  it("skips keyframes with existing non-generic descriptions", async () => {
    const kf = makeKeyframe({ description: "A detailed custom description of the scene." });
    const copilot = makeCopilot("");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.skipped).toBe(1);
    expect(result.analyzed).toBe(0);
    expect(copilot.chat).not.toHaveBeenCalled();
  });

  it("treats 'Major visual transition' as generic description", async () => {
    const kf = makeKeyframe({ description: "Major visual transition at 5.2s" });
    const copilot = makeCopilot("1. A person standing in front of a whiteboard.");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.analyzed).toBe(1);
    expect(kf.description).toContain("whiteboard");
  });

  it("treats 'Scene change' as generic description", async () => {
    const kf = makeKeyframe({ description: "Scene change detected" });
    const copilot = makeCopilot("1. Wide shot of a city skyline at dusk.");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.analyzed).toBe(1);
  });

  it("treats 'Visual sample at' as generic description", async () => {
    const kf = makeKeyframe({ description: "Visual sample at 3.5s" });
    const copilot = makeCopilot("1. Close-up of hands typing on a keyboard.");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.analyzed).toBe(1);
  });

  it("skips keyframes where file does not exist", async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
    const kf = makeKeyframe();
    const copilot = makeCopilot("");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.skipped).toBe(1);
    expect(result.analyzed).toBe(0);
  });

  it("analyzes a single keyframe via batch and sets description", async () => {
    const kf = makeKeyframe({ timestamp: 2.5 });
    const copilot = makeCopilot("1. Medium shot of a speaker at a podium.");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.analyzed).toBe(1);
    expect(result.failed).toBe(0);
    expect(kf.description).toBe("Medium shot of a speaker at a podium.");
  });

  it("analyzes multiple keyframes in a single batch request", async () => {
    const kf1 = makeKeyframe({ timestamp: 1.0, framePath: "/tmp/f1.jpg" });
    const kf2 = makeKeyframe({ timestamp: 3.0, framePath: "/tmp/f2.jpg", sceneScore: 0.8 });
    const kf3 = makeKeyframe({ timestamp: 5.0, framePath: "/tmp/f3.jpg", sceneScore: 0.3 });

    const copilot = makeCopilot(
      "1. Wide shot of a conference room.\n2. Close-up of a presentation slide.\n3. Audience reaction shot.",
    );

    const result = await analyzeKeyframes([kf1, kf2, kf3], copilot);
    expect(result.analyzed).toBe(3);
    expect(kf1.description).toContain("conference room");
    expect(kf2.description).toContain("presentation slide");
    expect(kf3.description).toContain("Audience reaction");
    // Should be a single chat call (batched)
    expect(copilot.chat).toHaveBeenCalledTimes(1);
  });

  it("handles multi-line descriptions per numbered item", async () => {
    const kf = makeKeyframe();
    const copilot = makeCopilot(
      "1. Medium shot of a speaker at a podium.\nThe lighting is warm and the backdrop is blue.",
    );
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.analyzed).toBe(1);
    expect(kf.description).toContain("lighting is warm");
  });

  it("falls back to individual calls when batch fails", async () => {
    const kf1 = makeKeyframe({ timestamp: 1.0, framePath: "/tmp/f1.jpg" });
    const kf2 = makeKeyframe({ timestamp: 2.0, framePath: "/tmp/f2.jpg" });

    const copilot = {
      chat: vi.fn()
        // First call (batch) throws
        .mockImplementationOnce(function* () {
          throw new Error("Model overloaded");
        })
        // Individual fallback calls
        .mockImplementationOnce(function* () {
          yield "Close-up of hands on a keyboard.";
        })
        .mockImplementationOnce(function* () {
          yield "Wide shot of an office.";
        }),
    } as any;

    const result = await analyzeKeyframes([kf1, kf2], copilot);
    expect(result.analyzed).toBe(2);
    expect(kf1.description).toContain("keyboard");
    expect(kf2.description).toContain("office");
  });

  it("counts failures when individual fallback also fails", async () => {
    const kf = makeKeyframe();
    const copilot = {
      chat: vi.fn()
        .mockImplementationOnce(function* () {
          throw new Error("Batch error");
        })
        .mockImplementationOnce(function* () {
          throw new Error("Individual error");
        }),
    } as any;

    const result = await analyzeKeyframes([kf], copilot);
    expect(result.failed).toBe(1);
    expect(result.analyzed).toBe(0);
  });

  it("marks failed when batch returns empty descriptions", async () => {
    const kf = makeKeyframe();
    const copilot = makeCopilot(""); // empty response
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.failed).toBe(1);
  });

  it("calls onProgress callback during analysis", async () => {
    const kf = makeKeyframe();
    const copilot = makeCopilot("1. Establishing shot of a building.");
    const onProgress = vi.fn();

    await analyzeKeyframes([kf], copilot, { onProgress });
    expect(onProgress).toHaveBeenCalled();
  });

  it("respects maxKeyframes option for large sets", async () => {
    // Create 50 keyframes
    const keyframes = Array.from({ length: 50 }, (_, i) =>
      makeKeyframe({
        timestamp: i,
        framePath: `/tmp/f${i}.jpg`,
        sceneScore: Math.random(),
      }),
    );

    const descriptions = Array.from({ length: 30 }, (_, i) => `${i + 1}. Description ${i}`).join("\n");
    const copilot = makeCopilot(descriptions);

    const result = await analyzeKeyframes(keyframes, copilot, { maxKeyframes: 30 });
    // Should analyze at most 30
    expect(result.analyzed + result.skipped + result.failed).toBeLessThanOrEqual(30);
  });

  it("handles colon-separated response format", async () => {
    const kf = makeKeyframe();
    const copilot = makeCopilot("1: Studio lighting on a product showcase.");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.analyzed).toBe(1);
    expect(kf.description).toContain("product showcase");
  });

  it("handles parenthesis-separated response format", async () => {
    const kf = makeKeyframe();
    const copilot = makeCopilot("1) Aerial drone shot of a coastline.");
    const result = await analyzeKeyframes([kf], copilot);
    expect(result.analyzed).toBe(1);
    expect(kf.description).toContain("coastline");
  });

  it("passes model option when specified", async () => {
    const kf = makeKeyframe();
    const copilot = makeCopilot("1. Test description.");
    await analyzeKeyframes([kf], copilot, { model: "gpt-4-vision" });
    const chatCall = copilot.chat.mock.calls[0];
    expect(chatCall[1]).toHaveProperty("model", "gpt-4-vision");
  });
});
