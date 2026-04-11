/**
 * Scene Graph — Unit Tests
 * Issue #821: Multi-modal AI clip extraction.
 */

import { describe, it, expect } from "vitest";
import {
  buildSceneGraph,
  computeSegmentBoundaries,
  computeHookStrength,
  type TranscriptSegment,
  type VisualFrame,
  type SceneChange,
} from "./scene-graph.js";

describe("computeSegmentBoundaries", () => {
  it("returns [0, duration] for short videos", () => {
    const result = computeSegmentBoundaries(20, [], 30);
    expect(result).toEqual([0, 20]);
  });

  it("returns [0] for zero duration", () => {
    const result = computeSegmentBoundaries(0, [], 30);
    expect(result).toEqual([0]);
  });

  it("splits at target duration when no scene changes", () => {
    const result = computeSegmentBoundaries(90, [], 30);
    expect(result).toEqual([0, 30, 60, 90]);
  });

  it("prefers scene change boundaries near target", () => {
    const sceneChanges: SceneChange[] = [
      { timestamp: 28, score: 0.5 },
      { timestamp: 55, score: 0.4 },
    ];
    const result = computeSegmentBoundaries(90, sceneChanges, 30);
    expect(result[1]).toBe(28);
    // Second boundary should be near 28+30=58, scene change at 55 is close
    expect(result[2]).toBe(55);
    expect(result[result.length - 1]).toBe(90);
  });

  it("falls back to target when no nearby scene changes", () => {
    const sceneChanges: SceneChange[] = [{ timestamp: 5, score: 0.3 }];
    const result = computeSegmentBoundaries(90, sceneChanges, 30);
    expect(result[1]).toBe(30); // No scene change near 30
  });
});

describe("computeHookStrength", () => {
  it("returns baseline score for neutral content", () => {
    const score = computeHookStrength("hello world", [], []);
    expect(score).toBe(50);
  });

  it("boosts score for hook phrases", () => {
    const score = computeHookStrength(
      "You won't believe what happened next?",
      [],
      [],
    );
    expect(score).toBeGreaterThan(60);
  });

  it("boosts score for emotional frames", () => {
    const frames: VisualFrame[] = [
      {
        timestamp: 1,
        description: "Person laughing",
        subjects: ["person"],
        onScreenText: [],
        sceneType: "talking-head",
        emotionalTone: "excited",
      },
    ];
    const score = computeHookStrength("some text", frames, []);
    expect(score).toBe(55);
  });

  it("boosts score for scene changes", () => {
    const sceneChanges: SceneChange[] = [
      { timestamp: 1, score: 0.5 },
      { timestamp: 2, score: 0.6 },
    ];
    const score = computeHookStrength("some text", [], sceneChanges);
    expect(score).toBe(56); // 50 + 2*3
  });

  it("caps at 100", () => {
    const frames: VisualFrame[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: i,
      description: "exciting",
      subjects: ["person1", "person2"],
      onScreenText: [],
      sceneType: "action",
      emotionalTone: "excited",
    }));
    const score = computeHookStrength(
      "You won't believe the biggest mistake? Game changer! Watch this! Check this out! The secret number one most important thing!",
      frames,
      Array.from({ length: 10 }, (_, i) => ({ timestamp: i, score: 0.5 })),
    );
    expect(score).toBe(100);
  });
});

describe("buildSceneGraph", () => {
  it("returns empty for zero duration", () => {
    const graph = buildSceneGraph({
      duration: 0,
      transcript: [],
      frames: [],
      sceneChanges: [],
    });
    expect(graph.segments).toHaveLength(0);
    expect(graph.duration).toBe(0);
  });

  it("builds segments from transcript and frames", () => {
    const transcript: TranscriptSegment[] = [
      { text: "Hello world", start: 0, end: 5, words: [] },
      { text: "Next segment", start: 5, end: 10, words: [] },
    ];
    const frames: VisualFrame[] = [
      {
        timestamp: 2,
        description: "Person talking",
        subjects: ["speaker"],
        onScreenText: [],
        sceneType: "talking-head",
        emotionalTone: "neutral",
      },
      {
        timestamp: 7,
        description: "Person gesturing",
        subjects: ["speaker"],
        onScreenText: [],
        sceneType: "talking-head",
        emotionalTone: "excited",
      },
    ];

    const graph = buildSceneGraph({
      duration: 10,
      transcript,
      frames,
      sceneChanges: [],
      segmentDuration: 30, // larger than duration, so single segment
    });

    expect(graph.segments).toHaveLength(1);
    expect(graph.segments[0].transcript).toContain("Hello world");
    expect(graph.segments[0].transcript).toContain("Next segment");
    expect(graph.segments[0].subjects).toContain("speaker");
  });

  it("splits into multiple segments based on duration", () => {
    const transcript: TranscriptSegment[] = [
      { text: "Part one", start: 0, end: 15, words: [] },
      { text: "Part two", start: 15, end: 30, words: [] },
      { text: "Part three", start: 30, end: 45, words: [] },
    ];

    const graph = buildSceneGraph({
      duration: 45,
      transcript,
      frames: [],
      sceneChanges: [],
      segmentDuration: 20,
    });

    expect(graph.segments.length).toBeGreaterThanOrEqual(2);
    expect(graph.segments[0].start).toBe(0);
    expect(graph.segments[graph.segments.length - 1].end).toBe(45);
  });

  it("preserves scene changes in graph", () => {
    const sceneChanges: SceneChange[] = [
      { timestamp: 10, score: 0.5 },
      { timestamp: 20, score: 0.7 },
    ];

    const graph = buildSceneGraph({
      duration: 30,
      transcript: [],
      frames: [],
      sceneChanges,
    });

    expect(graph.sceneChanges).toHaveLength(2);
  });
});
