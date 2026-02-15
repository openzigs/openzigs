/**
 * Director Mode — Context Assembler Tests
 * Issue #237
 */

import { describe, it, expect } from "vitest";
import { assembleContext, formatContextForPrompt } from "./context-assembler.js";
import type { ClipAnalysis } from "./types.js";

function buildTestClip(overrides: Partial<ClipAnalysis> = {}): ClipAnalysis {
  return {
    sourcePath: "/test/clip1.mp4",
    duration: 10.5,
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    audioPath: "/test/clip1.wav",
    keyframes: [
      { timestamp: 0, framePath: "/test/kf0.jpg", sceneScore: 0.0 },
      { timestamp: 5, framePath: "/test/kf5.jpg", sceneScore: 0.6 },
    ],
    transcript: [
      { start: "00:00:00.000", end: "00:00:03.000", speech: "Hello world", clipIndex: 0 },
      { start: "00:00:05.000", end: "00:00:08.000", speech: "This is a test", clipIndex: 0 },
    ],
    ...overrides,
  };
}

describe("assembleContext", () => {
  it("produces a ContextPayload from a single clip", () => {
    const clips = [buildTestClip()];
    const payload = assembleContext(clips);

    expect(payload.clips).toHaveLength(1);
    expect(payload.totalDuration).toBeCloseTo(10.5);
    expect(payload.clips[0].source).toBe("/test/clip1.mp4");
    expect(payload.resolution.width).toBe(1920);
  });

  it("aggregates multiple clips", () => {
    const clip1 = buildTestClip({ sourcePath: "/a.mp4", duration: 5.0 });
    const clip2 = buildTestClip({ sourcePath: "/b.mp4", duration: 10.0 });
    const payload = assembleContext([clip1, clip2]);

    expect(payload.clips).toHaveLength(2);
    expect(payload.totalDuration).toBeCloseTo(15.0);
    expect(payload.clips[0].timeline.length).toBeGreaterThan(0);
  });

  it("builds an interleaved timeline from transcript + keyframes", () => {
    const clips = [buildTestClip()];
    const payload = assembleContext(clips);

    // Timeline should have entries from both keyframes and transcript segments
    expect(payload.clips[0].timeline.length).toBeGreaterThanOrEqual(2);
    const types = new Set(payload.clips[0].timeline.map((e) => e.type));
    expect(types.has("visual")).toBe(true);
    expect(types.has("audio")).toBe(true);
  });

  it("handles clips with no transcript gracefully", () => {
    const clip = buildTestClip({ transcript: [] });
    const payload = assembleContext([clip]);

    expect(payload.clips).toHaveLength(1);
    // Should still have visual entries from keyframes
    expect(payload.clips[0].timeline.some((e) => e.type === "visual")).toBe(true);
  });

  it("handles clips with no keyframes gracefully", () => {
    const clip = buildTestClip({ keyframes: [] });
    const payload = assembleContext([clip]);

    expect(payload.clips).toHaveLength(1);
    expect(payload.clips[0].timeline.some((e) => e.type === "audio")).toBe(true);
  });
});

describe("formatContextForPrompt", () => {
  it("formats context as human-readable text", () => {
    const clips = [buildTestClip()];
    const payload = assembleContext(clips);
    const text = formatContextForPrompt(payload);

    expect(text).toContain("clip1.mp4");
    expect(text).toContain("Hello world");
    expect(text).toContain("1920x1080");
  });

  it("includes all clips in formatted output", () => {
    const clip1 = buildTestClip({ sourcePath: "/a.mp4" });
    const clip2 = buildTestClip({ sourcePath: "/b.mp4" });
    const payload = assembleContext([clip1, clip2]);
    const text = formatContextForPrompt(payload);

    expect(text).toContain("a.mp4");
    expect(text).toContain("b.mp4");
    expect(text).toContain("CLIP 0");
    expect(text).toContain("CLIP 1");
  });
});
