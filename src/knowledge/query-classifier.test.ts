import { describe, it, expect } from "vitest";
import { classifyQuery  } from "./query-classifier.js";

describe("classifyQuery", () => {
  it("detects media keywords", () => {
    const result = classifyQuery("Show me the podcast transcript");
    expect(result.isMediaQuery).toBe(true);
    expect(result.targetTypes).toContain("media");
    expect(result.mediaBoost).toBeGreaterThan(1.0);
  });

  it("detects image keywords", () => {
    const result = classifyQuery("Find the chart diagram");
    expect(result.isMediaQuery).toBe(true);
    expect(result.targetTypes).toContain("image");
  });

  it("returns no boost for non-media queries", () => {
    const result = classifyQuery("What is the capital of France?");
    expect(result.isMediaQuery).toBe(false);
    expect(result.targetTypes).toEqual([]);
    expect(result.mediaBoost).toBe(1.0);
    expect(result.includeTimestamps).toBe(false);
  });

  it("extracts temporal references (MM:SS)", () => {
    const result = classifyQuery("What was said at 5:30?");
    expect(result.temporalHints.length).toBeGreaterThan(0);
    expect(result.includeTimestamps).toBe(true);
  });

  it("extracts temporal references (at X minutes)", () => {
    const result = classifyQuery("What happens at 10 minutes 30 seconds?");
    expect(result.temporalHints.length).toBeGreaterThan(0);
    expect(result.isMediaQuery).toBe(true);
  });

  it("extracts temporal references (first/last segment)", () => {
    const result = classifyQuery("What was in the first segment?");
    expect(result.temporalHints.length).toBeGreaterThan(0);
  });

  it("applies high boost for 3+ media keywords", () => {
    const result = classifyQuery("Show me the podcast audio recording transcript");
    expect(result.mediaBoost).toBe(1.5);
  });

  it("applies medium boost for 2 media keywords", () => {
    const result = classifyQuery("Where did the speaker mention this in the interview?");
    expect(result.mediaBoost).toBe(1.3);
  });

  it("applies low boost for 1 media keyword", () => {
    const result = classifyQuery("Check the mp3 format");
    expect(result.mediaBoost).toBe(1.15);
  });

  it("detects both media and image types", () => {
    const result = classifyQuery("Show me the video screenshot image");
    expect(result.targetTypes).toContain("media");
    expect(result.targetTypes).toContain("image");
  });

  it("detects timestamp keyword", () => {
    const result = classifyQuery("Give me the timestamp");
    expect(result.temporalHints.length).toBeGreaterThan(0);
  });

  it("detects HH:MM:SS format", () => {
    const result = classifyQuery("What was discussed at 1:23:45?");
    expect(result.temporalHints).toContain("1:23:45");
  });

  it("detects about/around X minutes", () => {
    const result = classifyQuery("around 5 minutes in");
    expect(result.temporalHints.length).toBeGreaterThan(0);
  });

  it("detects file extension keywords", () => {
    const r1 = classifyQuery("Check the mp3 file");
    expect(r1.isMediaQuery).toBe(true);
    const r2 = classifyQuery("Open the mp4");
    expect(r2.isMediaQuery).toBe(true);
  });
});
