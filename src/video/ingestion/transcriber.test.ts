import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("transcriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("transcribe", () => {
    it("returns mapped transcript segments on success", async () => {
      const mockTranscript = [
        { start: "00:00:01", end: "00:00:03", speech: "Hello world" },
        { start: "00:00:04", end: "00:00:07", speech: "  Goodbye world  " },
      ];

      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockResolvedValue(mockTranscript),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip.wav", 0);

      expect(segments).toEqual([
        { start: "00:00:01", end: "00:00:03", speech: "Hello world", clipIndex: 0 },
        { start: "00:00:04", end: "00:00:07", speech: "Goodbye world", clipIndex: 0 },
      ]);
    });

    it("uses clip index in returned segments", async () => {
      const mockTranscript = [
        { start: "00:00:00", end: "00:00:02", speech: "Test" },
      ];

      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockResolvedValue(mockTranscript),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip3.wav", 3);

      expect(segments[0].clipIndex).toBe(3);
    });

    it("passes model name to whisper", async () => {
      const mockWhisper = vi.fn().mockResolvedValue([]);

      vi.doMock("whisper-node", () => ({
        default: mockWhisper,
      }));

      const { transcribe } = await import("./transcriber.js");
      await transcribe("/audio/clip.wav", 0, "large-v3");

      expect(mockWhisper).toHaveBeenCalledWith("/audio/clip.wav", {
        modelName: "large-v3",
        whisperOptions: {
          language: "auto",
          word_timestamps: true,
        },
      });
    });

    it("uses default model name base.en", async () => {
      const mockWhisper = vi.fn().mockResolvedValue([]);

      vi.doMock("whisper-node", () => ({
        default: mockWhisper,
      }));

      const { transcribe } = await import("./transcriber.js");
      await transcribe("/audio/clip.wav", 0);

      expect(mockWhisper).toHaveBeenCalledWith(
        "/audio/clip.wav",
        expect.objectContaining({ modelName: "base.en" }),
      );
    });

    it("returns empty array when transcript is null", async () => {
      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockResolvedValue(null),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip.wav", 0);

      expect(segments).toEqual([]);
    });

    it("returns empty array when transcript is not an array", async () => {
      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockResolvedValue("not an array"),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip.wav", 0);

      expect(segments).toEqual([]);
    });

    it("returns empty array and logs warning on model-related error", async () => {
      const { logger } = await import("../../logging/logger.js");

      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockRejectedValue(new Error("model not found: base.en")),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip.wav", 1);

      expect(segments).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Whisper model 'base.en' not found"),
      );
    });

    it("returns empty array and logs warning on download-related error", async () => {
      const { logger } = await import("../../logging/logger.js");

      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockRejectedValue(new Error("download failed")),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip.wav", 0, "large-v3");

      expect(segments).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Whisper model 'large-v3' not found"),
      );
    });

    it("returns empty array and logs generic error for other failures", async () => {
      const { logger } = await import("../../logging/logger.js");

      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockRejectedValue(new Error("ENOENT: file not found")),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/nonexistent.wav", 2);

      expect(segments).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Transcription failed for clip 2"),
      );
    });

    it("handles speech being undefined/null gracefully", async () => {
      const mockTranscript = [
        { start: "00:00:00", end: "00:00:01", speech: undefined },
        { start: "00:00:01", end: "00:00:02", speech: null },
      ];

      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockResolvedValue(mockTranscript),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip.wav", 0);

      expect(segments).toHaveLength(2);
      expect(segments[0].speech).toBe("");
      expect(segments[1].speech).toBe("");
    });

    it("handles non-Error throw types", async () => {
      const { logger } = await import("../../logging/logger.js");

      vi.doMock("whisper-node", () => ({
        default: vi.fn().mockRejectedValue("string error"),
      }));

      const { transcribe } = await import("./transcriber.js");
      const segments = await transcribe("/audio/clip.wav", 0);

      expect(segments).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("string error"),
      );
    });
  });
});
