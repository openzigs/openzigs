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

import { describe, it, expect, beforeEach } from "vitest";
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

// ── createSidecarMediaConverter Tests (mocked) ──

// Use dynamic import + vi.mock to test the factory function
import { vi } from "vitest";
import { createSidecarMediaConverter, extractKeyframes } from "./sidecar-media-converter.js";
import type { ExtractedKeyframe } from "./sidecar-media-converter.js";

// Mock child_process.execFile — default: callback with error (command not found)
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    cb(new Error("command not found"));
  }),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake-wav")),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock os.tmpdir
vi.mock("node:os", () => ({
  default: {
    tmpdir: () => "/tmp",
  },
}));

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Helper: make execFile succeed for ffmpeg -version (so ffmpegAvailable returns true).
 */
function mockFfmpegAvailable() {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    if (cmd === "ffmpeg" && args[0] === "-version") {
      cb(null, { stdout: "ffmpeg version 6.0", stderr: "" });
    } else if (cmd === "ffprobe") {
      cb(null, { stdout: "video", stderr: "" });
    } else if (cmd === "ffmpeg") {
      // ffmpeg extraction commands
      cb(null, { stdout: "", stderr: "" });
    } else {
      cb(new Error(`unexpected command: ${cmd}`));
    }
  }) as typeof execFile);
}

/**
 * Helper: make execFile fail for ffmpeg -version (so ffmpegAvailable returns false).
 */
function mockFfmpegUnavailable() {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(((cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    cb(new Error("command not found: ffmpeg"));
  }) as typeof execFile);
}

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("createSidecarMediaConverter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return unavailable when ffmpeg is not found", async () => {
    mockFfmpegUnavailable();

    const reg = await createSidecarMediaConverter();
    expect(reg.available).toBe(false);
    expect(reg.unavailableReason).toContain("ffmpeg not found");

    // The convert function should return an error result
    const result = await reg.convert("/any/file.mp3");
    expect(result.success).toBe(false);
    expect(result.error).toContain("ffmpeg is not installed");
  });

  it("should return unavailable when sidecar is unreachable", async () => {
    mockFfmpegAvailable();
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const reg = await createSidecarMediaConverter({ sidecarUrl: "http://localhost:9999" });
    expect(reg.available).toBe(false);
    expect(reg.unavailableReason).toContain("not reachable");

    const result = await reg.convert("/any/file.mp3");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not reachable");
  });

  it("should return available when both ffmpeg and sidecar are reachable", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: true }); // sidecar health check

    const reg = await createSidecarMediaConverter({ sidecarUrl: "http://localhost:5006" });
    expect(reg.available).toBe(true);
    expect(reg.name).toBe("media-sidecar");
    expect(reg.extensions).toContain(".mp4");
    expect(reg.extensions).toContain(".mp3");
  });

  it("should strip trailing slash from sidecar URL", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: true });

    await createSidecarMediaConverter({ sidecarUrl: "http://localhost:5006/" });
    // Health check should be called without double slash
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:5006/health",
      expect.any(Object),
    );
  });

  it("should handle sidecar health returning non-ok response", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const reg = await createSidecarMediaConverter();
    expect(reg.available).toBe(false);
    expect(reg.unavailableReason).toContain("not reachable");
  });

  it("should convert audio file successfully via sidecar", async () => {
    mockFfmpegAvailable();
    // Health check
    mockFetch.mockResolvedValueOnce({ ok: true });

    const reg = await createSidecarMediaConverter({ sidecarUrl: "http://localhost:5006" });

    // Transcription response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        text: "Hello world",
        language: "en",
        segments: [{ start: 0, end: 2.5, text: "Hello world" }],
        duration_seconds: 2.5,
      }),
    });

    // fs.readFile for wav data
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("fake-wav-data"));

    const result = await reg.convert("/path/to/audio.mp3");
    expect(result.success).toBe(true);
    expect(result.converter).toBe("media-sidecar");
    expect(result.text).toContain("Transcript: audio.mp3");
    expect(result.text).toContain("Hello world");
    expect(result.metadata).toBeDefined();
    expect((result.metadata as Record<string, unknown>).language).toBe("en");
    expect((result.metadata as Record<string, unknown>).isVideo).toBe(false);
  });

  it("should handle sidecar transcription failure", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: true }); // health

    const reg = await createSidecarMediaConverter();

    // Transcription fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("wav"));

    await expect(reg.convert("/path/to/audio.wav")).rejects.toThrow("Sidecar transcription failed (500)");
  });

  it("should log info when video detected but no copilot provided", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: true }); // health

    const reg = await createSidecarMediaConverter({ sidecarUrl: "http://localhost:5006" });

    // Mock ffprobe returning "video" for hasVideoStream
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (cmd === "ffprobe") {
        cb(null, { stdout: "video", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    }) as typeof execFile);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        text: "Video content",
        language: "en",
        segments: [{ start: 0, end: 5, text: "Video content" }],
        duration_seconds: 5,
      }),
    });
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("wav"));

    const result = await reg.convert("/path/to/video.mp4");
    expect(result.success).toBe(true);
    expect((result.metadata as Record<string, unknown>).isVideo).toBe(true);
    // No keyframe descriptions since no copilot
    expect((result.metadata as Record<string, unknown>).keyframeDescriptions).toBeUndefined();
  });

  it("should include segment count and duration in metadata", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: true }); // health

    const reg = await createSidecarMediaConverter();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        text: "First segment. Second segment.",
        language: "fr",
        segments: [
          { start: 0, end: 3, text: "First segment." },
          { start: 3, end: 6, text: "Second segment." },
        ],
        duration_seconds: 6.0,
      }),
    });
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("wav"));

    const result = await reg.convert("/test/file.m4a");
    expect(result.metadata).toBeDefined();
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.segmentCount).toBe(2);
    expect(meta.durationSeconds).toBe(6.0);
    expect(meta.language).toBe("fr");
    expect(meta.sourceFile).toBe("file.m4a");
  });

  it("should include markdown header with duration and engine info", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: true });

    const reg = await createSidecarMediaConverter();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        text: "Test",
        language: "",
        segments: [{ start: 0, end: 1, text: "Test" }],
        duration_seconds: 1.0,
      }),
    });
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("wav"));

    const result = await reg.convert("/test/podcast.ogg");
    expect(result.text).toContain("# Transcript: podcast.ogg");
    expect(result.text).toContain("**Duration:**");
    expect(result.text).toContain("auto-detected");
    expect(result.text).toContain("Audio Sidecar (Whisper MLX)");
  });

  it("should clean up temp WAV file even on transcription error", async () => {
    mockFfmpegAvailable();
    mockFetch.mockResolvedValueOnce({ ok: true });

    const reg = await createSidecarMediaConverter();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad request"),
    });
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("wav"));

    try {
      await reg.convert("/test/bad.mp3");
    } catch {
      // expected
    }

    // fs.unlink should have been called to clean up the temp file
    expect(vi.mocked(fs.unlink)).toHaveBeenCalled();
  });
});

// ── extractKeyframes Tests ──

describe("extractKeyframes (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should extract frames with correct timestamps and default interval", async () => {
    mockFfmpegAvailable();
    vi.mocked(fs.readdir).mockResolvedValueOnce(
      ["frame_0001.jpg", "frame_0002.jpg", "frame_0003.jpg"] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    );

    const { frames, tempDir } = await extractKeyframes("/video.mp4");
    expect(tempDir).toContain("openzigs-keyframes");
    expect(frames).toHaveLength(3);
    expect(frames[0].timestamp).toBe(0);
    expect(frames[1].timestamp).toBe(10); // default interval
    expect(frames[2].timestamp).toBe(20);
    expect(frames[0].framePath).toContain("frame_0001.jpg");
  });

  it("should use custom interval and maxFrames", async () => {
    mockFfmpegAvailable();
    vi.mocked(fs.readdir).mockResolvedValueOnce(
      ["frame_0001.jpg", "frame_0002.jpg"] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    );

    const { frames } = await extractKeyframes("/video.mp4", {
      intervalSeconds: 5,
      maxFrames: 2,
    });
    expect(frames).toHaveLength(2);
    expect(frames[0].timestamp).toBe(0);
    expect(frames[1].timestamp).toBe(5);
  });

  it("should filter non-frame files from temp dir", async () => {
    mockFfmpegAvailable();
    vi.mocked(fs.readdir).mockResolvedValueOnce(
      ["frame_0001.jpg", ".DS_Store", "other.txt", "frame_0002.jpg"] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    );

    const { frames } = await extractKeyframes("/video.mp4");
    expect(frames).toHaveLength(2);
  });

  it("should return empty frames when no frames extracted", async () => {
    mockFfmpegAvailable();
    vi.mocked(fs.readdir).mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const { frames } = await extractKeyframes("/video.mp4");
    expect(frames).toHaveLength(0);
  });
});

// ── parseVisionBatchResponse edge cases ──

describe("parseVisionBatchResponse (additional edge cases)", () => {
  it("should handle descriptions with numbers in text", () => {
    const raw = `1. Frame shows 42 people in a room
2. Graph displaying 2024 Q3 revenue figures`;

    const result = parseVisionBatchResponse(raw, 2);
    expect(result[0]).toBe("Frame shows 42 people in a room");
    expect(result[1]).toBe("Graph displaying 2024 Q3 revenue figures");
  });

  it("should handle expectedCount of 0", () => {
    const result = parseVisionBatchResponse("1. Something", 0);
    expect(result).toEqual([]);
  });
});
