import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFfmpegInstance = {
  noVideo: vi.fn().mockReturnThis(),
  audioCodec: vi.fn().mockReturnThis(),
  audioFrequency: vi.fn().mockReturnThis(),
  audioChannels: vi.fn().mockReturnThis(),
  output: vi.fn().mockReturnThis(),
  on: vi.fn().mockReturnThis(),
  run: vi.fn(),
};

const mockFfprobe = vi.fn();

const mockFfmpeg = vi.fn(() => mockFfmpegInstance);
(mockFfmpeg as unknown as Record<string, unknown>).ffprobe = mockFfprobe;

vi.mock("fluent-ffmpeg", () => ({
  default: mockFfmpeg,
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { extractAudio, getAudioDuration } from "./audio-extractor.js";

describe("extractAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFfmpegInstance.noVideo.mockReturnThis();
    mockFfmpegInstance.audioCodec.mockReturnThis();
    mockFfmpegInstance.audioFrequency.mockReturnThis();
    mockFfmpegInstance.audioChannels.mockReturnThis();
    mockFfmpegInstance.output.mockReturnThis();
    mockFfmpegInstance.on.mockReturnThis();
  });

  it("extracts audio and returns output path on success", async () => {
    mockFfmpegInstance.on.mockImplementation(function (this: typeof mockFfmpegInstance, event: string, cb: (...args: unknown[]) => void) {
      if (event === "end") {
        // Store callback for later invocation
        setTimeout(() => cb(), 0);
      }
      return this;
    });

    const result = await extractAudio("/videos/test.mp4", "/output");

    expect(result).toBe("/output/test.wav");
    expect(mockFfmpeg).toHaveBeenCalledWith("/videos/test.mp4");
    expect(mockFfmpegInstance.noVideo).toHaveBeenCalled();
    expect(mockFfmpegInstance.audioCodec).toHaveBeenCalledWith("pcm_s16le");
    expect(mockFfmpegInstance.audioFrequency).toHaveBeenCalledWith(16000);
    expect(mockFfmpegInstance.audioChannels).toHaveBeenCalledWith(1);
  });

  it("returns null when video has no audio stream", async () => {
    mockFfmpegInstance.on.mockImplementation(function (this: typeof mockFfmpegInstance, event: string, cb: (...args: unknown[]) => void) {
      if (event === "error") {
        setTimeout(() => cb(new Error("does not contain any stream")), 0);
      }
      return this;
    });

    const result = await extractAudio("/videos/silent.mp4", "/output");
    expect(result).toBeNull();
  });

  it("returns null when ffmpeg reports no audio", async () => {
    mockFfmpegInstance.on.mockImplementation(function (this: typeof mockFfmpegInstance, event: string, cb: (...args: unknown[]) => void) {
      if (event === "error") {
        setTimeout(() => cb(new Error("no audio track found")), 0);
      }
      return this;
    });

    const result = await extractAudio("/videos/no-audio.mp4", "/output");
    expect(result).toBeNull();
  });

  it("rejects with error for non-audio-related ffmpeg errors", async () => {
    mockFfmpegInstance.on.mockImplementation(function (this: typeof mockFfmpegInstance, event: string, cb: (...args: unknown[]) => void) {
      if (event === "error") {
        setTimeout(() => cb(new Error("Permission denied")), 0);
      }
      return this;
    });

    await expect(extractAudio("/videos/locked.mp4", "/output")).rejects.toThrow("Permission denied");
  });

  it("derives output filename from input basename", async () => {
    mockFfmpegInstance.on.mockImplementation(function (this: typeof mockFfmpegInstance, event: string, cb: (...args: unknown[]) => void) {
      if (event === "end") setTimeout(() => cb(), 0);
      return this;
    });

    const result = await extractAudio("/path/to/my-video.mov", "/out");
    expect(result).toBe("/out/my-video.wav");
  });

  it("configures ffmpeg for 16kHz mono WAV output", async () => {
    mockFfmpegInstance.on.mockImplementation(function (this: typeof mockFfmpegInstance, event: string, cb: (...args: unknown[]) => void) {
      if (event === "end") setTimeout(() => cb(), 0);
      return this;
    });

    await extractAudio("/test.mp4", "/out");

    expect(mockFfmpegInstance.audioCodec).toHaveBeenCalledWith("pcm_s16le");
    expect(mockFfmpegInstance.audioFrequency).toHaveBeenCalledWith(16000);
    expect(mockFfmpegInstance.audioChannels).toHaveBeenCalledWith(1);
  });
});

describe("getAudioDuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns duration from ffprobe metadata", async () => {
    mockFfprobe.mockImplementation((_path: string, cb: (err: Error | null, meta: unknown) => void) => {
      cb(null, { format: { duration: 42.5 } });
    });

    const duration = await getAudioDuration("/audio/test.wav");
    expect(duration).toBe(42.5);
  });

  it("returns 0 when duration is missing from metadata", async () => {
    mockFfprobe.mockImplementation((_path: string, cb: (err: Error | null, meta: unknown) => void) => {
      cb(null, { format: {} });
    });

    const duration = await getAudioDuration("/audio/no-duration.wav");
    expect(duration).toBe(0);
  });

  it("returns 0 when format is missing from metadata", async () => {
    mockFfprobe.mockImplementation((_path: string, cb: (err: Error | null, meta: unknown) => void) => {
      cb(null, {});
    });

    const duration = await getAudioDuration("/audio/no-format.wav");
    expect(duration).toBe(0);
  });

  it("rejects when ffprobe returns an error", async () => {
    mockFfprobe.mockImplementation((_path: string, cb: (err: Error | null, meta: unknown) => void) => {
      cb(new Error("ffprobe not found"), null);
    });

    await expect(getAudioDuration("/audio/err.wav")).rejects.toThrow("ffprobe not found");
  });
});
