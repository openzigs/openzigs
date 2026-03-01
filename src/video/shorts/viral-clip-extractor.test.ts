import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { extractViralClip } from "./viral-clip-extractor.js";
import type { ClipAnalysis } from "../ingestion/types.js";

function makeClip(overrides: Partial<ClipAnalysis> = {}): ClipAnalysis {
  return {
    source: "/tmp/test.mp4",
    duration: 120,
    resolution: { width: 1920, height: 1080 },
    keyframes: Array.from({ length: 10 }, (_, i) => ({
      timestamp: i * 12,
      path: `/tmp/frame-${i}.jpg`,
      description: `Frame ${i} description`,
    })),
    transcript: [
      { start: "0:00", end: "0:05", speech: "Hello world" },
      { start: "0:05", end: "0:10", speech: "This is a test" },
      { start: "0:30", end: "0:35", speech: "Main content here" },
      { start: "0:50", end: "0:55", speech: "Exciting moment" },
    ],
    ...overrides,
  } as ClipAnalysis;
}

function makeCopilot(response: string) {
  return {
    chat: vi.fn().mockImplementation(function* () {
      yield response;
    }),
  } as any;
}

describe("extractViralClip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses valid JSON response from LLM", async () => {
    const clip = makeClip();
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 30,
        endSeconds: 75,
        rationale: "This has the best content",
        suggestedHook: "You won't believe this!",
      }),
    );

    const result = await extractViralClip(clip, copilot);

    expect(result.startSeconds).toBe(30);
    expect(result.endSeconds).toBe(75);
    expect(result.rationale).toBe("This has the best content");
    expect(result.suggestedHook).toBe("You won't believe this!");
  });

  it("strips markdown code fences from response", async () => {
    const clip = makeClip();
    const copilot = makeCopilot(
      '```json\n{"startSeconds": 10, "endSeconds": 50, "rationale": "Good", "suggestedHook": "Wow"}\n```',
    );

    const result = await extractViralClip(clip, copilot);
    expect(result.startSeconds).toBe(10);
    expect(result.endSeconds).toBe(50);
  });

  it("clamps start to 0 and end to clip duration", async () => {
    const clip = makeClip({ duration: 60 });
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: -5,
        endSeconds: 100,
        rationale: "Out of range",
        suggestedHook: "Hook",
      }),
    );

    const result = await extractViralClip(clip, copilot);
    expect(result.startSeconds).toBe(0);
    expect(result.endSeconds).toBe(60);
  });

  it("falls back to center segment on invalid JSON", async () => {
    const clip = makeClip({ duration: 100 });
    const copilot = makeCopilot("This is not JSON at all");

    const result = await extractViralClip(clip, copilot);
    expect(result.rationale).toContain("Fallback");
    expect(result.startSeconds).toBeGreaterThanOrEqual(0);
    expect(result.endSeconds).toBeLessThanOrEqual(100);
  });

  it("falls back when endSeconds <= startSeconds", async () => {
    const clip = makeClip({ duration: 100 });
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 50,
        endSeconds: 30,
        rationale: "Bad",
        suggestedHook: "Hook",
      }),
    );

    const result = await extractViralClip(clip, copilot);
    expect(result.rationale).toContain("Fallback");
  });

  it("falls back when times are not finite", async () => {
    const clip = makeClip({ duration: 100 });
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: "not a number",
        endSeconds: 50,
        rationale: "Bad",
        suggestedHook: "Hook",
      }),
    );

    const result = await extractViralClip(clip, copilot);
    expect(result.rationale).toContain("Fallback");
  });

  it("warns but still returns when duration outside expected range", async () => {
    const clip = makeClip({ duration: 600 });
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 0,
        endSeconds: 5,
        rationale: "Very short",
        suggestedHook: "Hook",
      }),
    );

    const result = await extractViralClip(clip, copilot);
    expect(result.startSeconds).toBe(0);
    expect(result.endSeconds).toBe(5);
  });

  it("respects targetDuration option", async () => {
    const clip = makeClip();
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 10,
        endSeconds: 40,
        rationale: "30s clip",
        suggestedHook: "Hook",
      }),
    );

    await extractViralClip(clip, copilot, { targetDuration: 30 });

    const prompt = copilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("30 seconds");
  });

  it("respects style option", async () => {
    const clip = makeClip();
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 10,
        endSeconds: 50,
        rationale: "React",
        suggestedHook: "Hook",
      }),
    );

    await extractViralClip(clip, copilot, { style: "react" });

    const prompt = copilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("reaction-worthy");
  });

  it("passes model option to copilot.chat", async () => {
    const clip = makeClip();
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 10,
        endSeconds: 50,
        rationale: "Ok",
        suggestedHook: "Hook",
      }),
    );

    await extractViralClip(clip, copilot, { model: "gpt-4o" });

    const opts = copilot.chat.mock.calls[0][1];
    expect(opts.model).toBe("gpt-4o");
  });

  it("samples keyframes when more than maxCount", async () => {
    const manyFrames = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i,
      path: `/tmp/frame-${i}.jpg`,
      description: `Frame ${i}`,
    }));
    const clip = makeClip({ keyframes: manyFrames });
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 10,
        endSeconds: 50,
        rationale: "Ok",
        suggestedHook: "Hook",
      }),
    );

    await extractViralClip(clip, copilot);

    const prompt = copilot.chat.mock.calls[0][0] as string;
    // Should have sampled down to 40 keyframes max
    const frameLines = prompt.split("\n").filter((l: string) => l.match(/^\s+\d+\.\s+\[/));
    expect(frameLines.length).toBeLessThanOrEqual(40);
  });

  it("handles empty transcript", async () => {
    const clip = makeClip({ transcript: [] });
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 10,
        endSeconds: 50,
        rationale: "Ok",
        suggestedHook: "Hook",
      }),
    );

    const result = await extractViralClip(clip, copilot);

    const prompt = copilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("no speech detected");
    expect(result.startSeconds).toBe(10);
  });

  it("limits transcript to 100 segments", async () => {
    const longTranscript = Array.from({ length: 200 }, (_, i) => ({
      start: `${i}:00`,
      end: `${i}:05`,
      speech: `Segment ${i}`,
    }));
    const clip = makeClip({ transcript: longTranscript });
    const copilot = makeCopilot(
      JSON.stringify({
        startSeconds: 10,
        endSeconds: 50,
        rationale: "Ok",
        suggestedHook: "Hook",
      }),
    );

    await extractViralClip(clip, copilot);

    const prompt = copilot.chat.mock.calls[0][0] as string;
    // Should not contain segment 150
    expect(prompt).not.toContain("Segment 150");
  });
});
