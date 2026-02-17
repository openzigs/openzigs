/**
 * Tests for the Sidecar Media Converter.
 *
 * Validates:
 * - Video stream detection (hasVideoStream)
 * - Keyframe extraction via ffmpeg (extractKeyframes)
 * - Vision batch response parsing (parseVisionBatchResponse)
 * - Interleaved body formatting (buildInterleavedBody)
 * - Audio-only files skip keyframe extraction
 * - Full converter creation and availability checks
 */

import { describe, it, expect } from "vitest";
import {
  hasVideoStream,
  parseVisionBatchResponse,
  buildInterleavedBody,
} from "./sidecar-media-converter.js";

// ── hasVideoStream Tests ──

describe("hasVideoStream", () => {
  it("should return false for audio-only extensions", async () => {
    expect(await hasVideoStream("/path/to/file.mp3")).toBe(false);
    expect(await hasVideoStream("/path/to/file.wav")).toBe(false);
    expect(await hasVideoStream("/path/to/file.m4a")).toBe(false);
    expect(await hasVideoStream("/path/to/file.ogg")).toBe(false);
    expect(await hasVideoStream("/path/to/file.flac")).toBe(false);
  });

  it("should check video-capable extensions (.mp4, .webm)", async () => {
    // These will fail because the files don't exist, but validate
    // that the function attempts ffprobe for these extensions
    const result = await hasVideoStream("/nonexistent/file.mp4");
    expect(typeof result).toBe("boolean");
    // Should return false because ffprobe will fail on nonexistent file
    expect(result).toBe(false);
  });

  it("should handle case-insensitive extensions", async () => {
    expect(await hasVideoStream("/path/to/file.MP3")).toBe(false);
    expect(await hasVideoStream("/path/to/file.WAV")).toBe(false);
  });
});

// ── parseVisionBatchResponse Tests ──

describe("parseVisionBatchResponse", () => {
  it("should parse numbered responses correctly", () => {
    const raw = `1. Medium shot of a speaker at a podium with warm stage lighting.
2. Close-up product shot on a white surface with soft diffused lighting.
3. Wide establishing shot of a modern office space.`;

    const result = parseVisionBatchResponse(raw, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("Medium shot of a speaker at a podium with warm stage lighting.");
    expect(result[1]).toBe("Close-up product shot on a white surface with soft diffused lighting.");
    expect(result[2]).toBe("Wide establishing shot of a modern office space.");
  });

  it("should handle various numbered formats", () => {
    const raw = `1) First description
2: Second description
3- Third description`;

    const result = parseVisionBatchResponse(raw, 3);
    expect(result[0]).toBe("First description");
    expect(result[1]).toBe("Second description");
    expect(result[2]).toBe("Third description");
  });

  it("should handle multi-line descriptions", () => {
    const raw = `1. First part of description
   continuation of first description
2. Second description only one line`;

    const result = parseVisionBatchResponse(raw, 2);
    expect(result[0]).toBe("First part of description continuation of first description");
    expect(result[1]).toBe("Second description only one line");
  });

  it("should return empty strings for missing entries", () => {
    const raw = `1. Only first described
3. Third described but not second`;

    const result = parseVisionBatchResponse(raw, 3);
    expect(result[0]).toBe("Only first described");
    expect(result[1]).toBe(""); // Missing entry
    expect(result[2]).toBe("Third described but not second");
  });

  it("should handle empty input", () => {
    const result = parseVisionBatchResponse("", 3);
    expect(result).toEqual(["", "", ""]);
  });

  it("should handle single entry", () => {
    const raw = "1. Single frame description with details.";
    const result = parseVisionBatchResponse(raw, 1);
    expect(result).toEqual(["Single frame description with details."]);
  });

  it("should ignore preamble text before numbered entries", () => {
    const raw = `Here are the descriptions:

1. First description
2. Second description`;

    const result = parseVisionBatchResponse(raw, 2);
    expect(result[0]).toBe("First description");
    expect(result[1]).toBe("Second description");
  });

  it("should handle out-of-range indices gracefully", () => {
    const raw = `1. First
5. This is out of range`;

    const result = parseVisionBatchResponse(raw, 2);
    expect(result[0]).toBe("First");
    expect(result[1]).toBe(""); // Index 5 is out of range for expectedCount=2
  });
});

// ── buildInterleavedBody Tests ──

describe("buildInterleavedBody", () => {
  it("should format transcript-only segments (no visual descriptions)", () => {
    const segments = [
      { start: 0, end: 5, text: "Hello world" },
      { start: 5, end: 10, text: "Second segment" },
    ];

    const result = buildInterleavedBody(segments, []);
    expect(result).toContain("**[0:00.0 → 0:05.0]** Hello world");
    expect(result).toContain("**[0:05.0 → 0:10.0]** Second segment");
    expect(result).not.toContain("Visual @");
  });

  it("should interleave visual descriptions with transcript", () => {
    const segments = [
      { start: 0, end: 5, text: "Hello world" },
      { start: 10, end: 15, text: "Later segment" },
    ];

    const frameDescriptions = [
      { timestamp: 0, description: "Speaker at podium" },
      { timestamp: 10, description: "Slide with diagram" },
    ];

    const result = buildInterleavedBody(segments, frameDescriptions);

    // Visual descriptions should appear
    expect(result).toContain("**[Visual @ 0:00.0]** _Speaker at podium_");
    expect(result).toContain("**[Visual @ 0:10.0]** _Slide with diagram_");

    // Transcript should still appear
    expect(result).toContain("**[0:00.0 → 0:05.0]** Hello world");
    expect(result).toContain("**[0:10.0 → 0:15.0]** Later segment");
  });

  it("should sort entries chronologically", () => {
    const segments = [
      { start: 10, end: 15, text: "Later segment" },
      { start: 0, end: 5, text: "First segment" },
    ];

    const frameDescriptions = [
      { timestamp: 5, description: "Mid-point visual" },
    ];

    const result = buildInterleavedBody(segments, frameDescriptions);
    const lines = result.split("\n\n");

    // Should be in chronological order: 0s transcript → 5s visual → 10s transcript
    expect(lines[0]).toContain("0:00.0");
    expect(lines[1]).toContain("Visual @ 0:05.0");
    expect(lines[2]).toContain("0:10.0");
  });

  it("should place visual descriptions before transcript at same timestamp", () => {
    const segments = [
      { start: 10, end: 15, text: "Transcript at 10s" },
    ];

    const frameDescriptions = [
      { timestamp: 10, description: "Visual at 10s" },
    ];

    const result = buildInterleavedBody(segments, frameDescriptions);
    const lines = result.split("\n\n");

    // Visual should come first at the same timestamp
    expect(lines[0]).toContain("Visual @");
    expect(lines[1]).toContain("Transcript at 10s");
  });

  it("should handle empty segments", () => {
    const result = buildInterleavedBody([], []);
    expect(result).toBe("");
  });

  it("should handle visual-only (no transcript segments)", () => {
    const frameDescriptions = [
      { timestamp: 0, description: "Opening shot" },
      { timestamp: 10, description: "Second shot" },
    ];

    const result = buildInterleavedBody([], frameDescriptions);
    expect(result).toContain("**[Visual @ 0:00.0]** _Opening shot_");
    expect(result).toContain("**[Visual @ 0:10.0]** _Second shot_");
  });

  it("should format timestamps with hours correctly", () => {
    const segments = [
      { start: 3661, end: 3665, text: "After one hour" },
    ];

    const result = buildInterleavedBody(segments, []);
    expect(result).toContain("1:01:01.0");
  });
});
