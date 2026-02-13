import { describe, it, expect, beforeEach } from "vitest";
import { TokenTracker, MODEL_CONTEXT_WINDOWS } from "./token-tracker.js";

describe("TokenTracker", () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker();
  });

  describe("record()", () => {
    it("creates accumulator on first call and returns delta + cumulative", () => {
      const event = tracker.record("sess-1", 100, 50);
      expect(event).toEqual({
        sessionId: "sess-1",
        delta: { inputTokens: 100, outputTokens: 50 },
        cumulative: { inputTokens: 100, outputTokens: 50, totalTokens: 150, turns: 1 },
      });
    });

    it("accumulates across multiple calls", () => {
      tracker.record("sess-1", 100, 50);
      const event = tracker.record("sess-1", 200, 100);
      expect(event.cumulative).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
        turns: 2,
      });
      expect(event.delta).toEqual({ inputTokens: 200, outputTokens: 100 });
    });

    it("tracks sessions independently", () => {
      tracker.record("sess-1", 100, 50);
      tracker.record("sess-2", 400, 200);

      const usage1 = tracker.getUsage("sess-1");
      const usage2 = tracker.getUsage("sess-2");

      expect(usage1?.totalTokens).toBe(150);
      expect(usage2?.totalTokens).toBe(600);
    });

    it("increments turns on each call", () => {
      tracker.record("sess-1", 10, 5);
      tracker.record("sess-1", 20, 10);
      tracker.record("sess-1", 30, 15);

      const usage = tracker.getUsage("sess-1");
      expect(usage?.turns).toBe(3);
    });
  });

  describe("getUsage()", () => {
    it("returns null for unknown session", () => {
      expect(tracker.getUsage("nonexistent")).toBeNull();
    });

    it("returns correct snapshot without modifying internal state", () => {
      tracker.record("sess-1", 100, 50);
      const first = tracker.getUsage("sess-1");
      const second = tracker.getUsage("sess-1");
      expect(first).toEqual(second);
      expect(first).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        turns: 1,
      });
    });
  });

  describe("clearUsage()", () => {
    it("returns usage and removes it from tracker", () => {
      tracker.record("sess-1", 100, 50);
      const cleared = tracker.clearUsage("sess-1");
      expect(cleared).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        turns: 1,
      });
      expect(tracker.getUsage("sess-1")).toBeNull();
      expect(tracker.hasUsage("sess-1")).toBe(false);
    });

    it("returns null for unknown session", () => {
      expect(tracker.clearUsage("nonexistent")).toBeNull();
    });
  });

  describe("hasUsage()", () => {
    it("returns false for unknown session", () => {
      expect(tracker.hasUsage("nonexistent")).toBe(false);
    });

    it("returns true after recording", () => {
      tracker.record("sess-1", 10, 5);
      expect(tracker.hasUsage("sess-1")).toBe(true);
    });
  });

  describe("getContextWindow()", () => {
    it("returns known model context window", () => {
      expect(tracker.getContextWindow("gpt-4.1")).toBe(1_000_000);
      expect(tracker.getContextWindow("claude-sonnet-4")).toBe(200_000);
      expect(tracker.getContextWindow("gpt-4o")).toBe(128_000);
    });

    it("returns undefined for unknown model", () => {
      expect(tracker.getContextWindow("unknown-model")).toBeUndefined();
    });
  });

  describe("MODEL_CONTEXT_WINDOWS", () => {
    it("exports a non-empty record of known models", () => {
      expect(Object.keys(MODEL_CONTEXT_WINDOWS).length).toBeGreaterThan(5);
    });

    it("all values are positive integers", () => {
      for (const [, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
        expect(value).toBeGreaterThan(0);
        expect(Number.isInteger(value)).toBe(true);
      }
    });
  });
});
