import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranscriptClassifier } from "./transcript-classifier.js";
import type { PresentationRow } from "./presentation-repository.js";

function makeMockCopilot() {
  return { chat: vi.fn() };
}

function makePresentation(overrides: Partial<PresentationRow> = {}): PresentationRow {
  return {
    id: "pres-1",
    title: "Test Talk",
    video_path: "/tmp/test.mp4",
    thumbnail_path: null,
    duration_seconds: 100,
    fps: 30,
    script_json: JSON.stringify([
      { text: "Introduction to topic", startTime: 0, endTime: 20 },
      { text: "Deep dive analysis", startTime: 20, endTime: 50 },
      { text: "Summary and wrap up", startTime: 50, endTime: 80 },
      { text: "Final thoughts", startTime: 80, endTime: 100 },
    ]),
    chapters: "[]",
    voice_id: null,
    quiz_enabled: 0,
    quiz_config: null,
    director_manifest_path: null,
    mode: "presentation",
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

async function* yieldTokens(text: string) {
  yield text;
}

describe("TranscriptClassifier", () => {
  let copilot: ReturnType<typeof makeMockCopilot>;
  let classifier: TranscriptClassifier;

  beforeEach(() => {
    copilot = makeMockCopilot();
    classifier = new TranscriptClassifier(copilot as any);
  });

  it("returns empty array for empty chapters", async () => {
    const result = await classifier.classify(makePresentation(), []);
    expect(result).toEqual([]);
    expect(copilot.chat).not.toHaveBeenCalled();
  });

  it("distributes evenly when no valid segments exist", async () => {
    const pres = makePresentation({
      script_json: "[]",
      duration_seconds: 90,
    });

    const chapters = [
      { title: "Part 1", description: "First part" },
      { title: "Part 2", description: "Second part" },
      { title: "Part 3", description: "Third part" },
    ];

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(3);
    expect(result[0].startSeconds).toBe(0);
    expect(result[0].endSeconds).toBe(30);
    expect(result[1].startSeconds).toBe(30);
    expect(result[1].endSeconds).toBe(60);
    expect(result[2].startSeconds).toBe(60);
    expect(result[2].endSeconds).toBe(90);
    expect(result[0].coverage).toBe(0);
  });

  it("distributes evenly when script_json is invalid", async () => {
    const pres = makePresentation({
      script_json: "not-json",
      duration_seconds: 60,
    });

    const chapters = [
      { title: "A", description: "" },
      { title: "B", description: "" },
    ];

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(2);
    expect(result[0].endSeconds).toBe(30);
    expect(result[1].startSeconds).toBe(30);
  });

  it("classifies segments using LLM assignments", async () => {
    const pres = makePresentation();
    const chapters = [
      { title: "Intro", description: "Getting started" },
      { title: "Analysis", description: "Deep dive" },
    ];

    // LLM assigns: seg0->ch0, seg1->ch1, seg2->ch1, seg3->ch1
    copilot.chat.mockReturnValue(yieldTokens("[0, 1, 1, 1]"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Intro");
    expect(result[0].startSeconds).toBe(0);
    expect(result[0].endSeconds).toBe(20);
    expect(result[0].coverage).toBe(0.25); // 1 of 4 segments

    expect(result[1].title).toBe("Analysis");
    expect(result[1].startSeconds).toBe(20);
    // Last chapter extends to totalDuration
    expect(result[1].endSeconds).toBe(100);
    expect(result[1].coverage).toBe(0.75); // 3 of 4 segments
  });

  it("handles assignments wrapped in markdown code fences", async () => {
    const pres = makePresentation();
    const chapters = [
      { title: "A", description: "" },
      { title: "B", description: "" },
    ];

    copilot.chat.mockReturnValue(yieldTokens("```json\n[0, 0, 1, 1]\n```"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(2);
    expect(result[0].coverage).toBe(0.5);
    expect(result[1].coverage).toBe(0.5);
  });

  it("falls back to even distribution when LLM returns invalid JSON", async () => {
    const pres = makePresentation();
    const chapters = [
      { title: "A", description: "" },
      { title: "B", description: "" },
    ];

    copilot.chat.mockReturnValue(yieldTokens("I don't understand the question"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(2);
    // Fallback even distribution: 4 segments across 2 chapters → [0,0,1,1]
    expect(result[0].coverage).toBe(0.5);
    expect(result[1].coverage).toBe(0.5);
  });

  it("clamps out-of-range chapter indices", async () => {
    const pres = makePresentation();
    const chapters = [
      { title: "Only", description: "Single chapter" },
    ];

    // LLM returns indices beyond chapterCount — should be clamped to 0
    copilot.chat.mockReturnValue(yieldTokens("[0, 5, -1, 99]"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(1);
    expect(result[0].coverage).toBe(1); // all segments in the only chapter
    expect(result[0].endSeconds).toBe(100);
  });

  it("gap-fills chapters with no matched segments", async () => {
    const pres = makePresentation();
    const chapters = [
      { title: "Intro", description: "" },
      { title: "Empty", description: "Gets no segments" },
      { title: "Outro", description: "" },
    ];

    // All segments go to chapters 0 and 2, chapter 1 gets nothing
    copilot.chat.mockReturnValue(yieldTokens("[0, 0, 2, 2]"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(3);
    // Chapter 1 (Empty) should be gap-filled between ch0's end and ch2's start
    expect(result[1].startSeconds).toBe(result[0].endSeconds);
    expect(result[1].endSeconds).toBe(result[2].startSeconds);
    expect(result[1].coverage).toBe(0);
  });

  it("snaps overlapping chapter starts", async () => {
    const pres = makePresentation();
    const chapters = [
      { title: "A", description: "" },
      { title: "B", description: "" },
    ];

    // All segments map to chapter 0, making chapter 1 overlap
    copilot.chat.mockReturnValue(yieldTokens("[0, 0, 0, 0]"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(2);
    // Chapter B's start should not be less than chapter A's end
    expect(result[1].startSeconds).toBeGreaterThanOrEqual(result[0].endSeconds);
  });

  it("extends last chapter to totalDuration", async () => {
    const pres = makePresentation({ duration_seconds: 200 });
    const chapters = [
      { title: "A", description: "" },
      { title: "B", description: "" },
    ];

    copilot.chat.mockReturnValue(yieldTokens("[0, 0, 1, 1]"));

    const result = await classifier.classify(pres, chapters);
    expect(result[result.length - 1].endSeconds).toBe(200);
  });

  it("uses startSeconds variant in script_json", async () => {
    const pres = makePresentation({
      script_json: JSON.stringify([
        { text: "Seg1", startSeconds: 0, endSeconds: 25 },
        { text: "Seg2", startSeconds: 25, endSeconds: 50 },
      ]),
    });
    const chapters = [
      { title: "A", description: "" },
      { title: "B", description: "" },
    ];

    copilot.chat.mockReturnValue(yieldTokens("[0, 1]"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(2);
    expect(result[0].startSeconds).toBe(0);
    expect(result[0].endSeconds).toBe(25);
  });

  it("filters out segments with missing timing data", async () => {
    const pres = makePresentation({
      script_json: JSON.stringify([
        { text: "Good", startTime: 0, endTime: 30 },
        { text: "No timing" }, // should be filtered
        { text: "", startTime: 30, endTime: 60 }, // empty text, filtered
        { text: "Also good", startTime: 60, endTime: 90 },
      ]),
      duration_seconds: 90,
    });
    const chapters = [{ title: "All", description: "" }];

    copilot.chat.mockReturnValue(yieldTokens("[0, 0]"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(1);
    expect(result[0].coverage).toBe(1); // 2 valid segments, both assigned to ch0
  });

  it("pads assignments when LLM returns fewer than segment count", async () => {
    const pres = makePresentation(); // 4 segments
    const chapters = [
      { title: "A", description: "" },
      { title: "B", description: "" },
    ];

    // Only 2 assignments for 4 segments — should pad with 0
    copilot.chat.mockReturnValue(yieldTokens("[1, 0]"));

    const result = await classifier.classify(pres, chapters);
    expect(result).toHaveLength(2);
    // The missing assignments default to 0, so ch0 gets 3 segments, ch1 gets 1
    expect(result[0].coverage + result[1].coverage).toBeCloseTo(1);
  });
});
