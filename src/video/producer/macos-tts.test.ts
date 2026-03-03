import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecAsync, mockFsWriteFile, mockFsStat, mockFsUnlink } = vi.hoisted(() => ({
  mockExecAsync: vi.fn(),
  mockFsWriteFile: vi.fn(),
  mockFsStat: vi.fn(),
  mockFsUnlink: vi.fn(),
}));

vi.mock("node:child_process", () => ({ exec: vi.fn() }));
vi.mock("node:util", () => ({
  promisify: () => mockExecAsync,
}));
vi.mock("node:fs/promises", () => ({
  default: {
    writeFile: (...args: any[]) => mockFsWriteFile(...args),
    stat: (...args: any[]) => mockFsStat(...args),
    unlink: (...args: any[]) => mockFsUnlink(...args),
  },
}));
vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isAvailable, synthesize } from "./macos-tts.js";

describe("macos-tts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFsUnlink.mockResolvedValue(undefined);
  });

  describe("isAvailable", () => {
    it("returns false on non-darwin platforms", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true });
      try {
        const result = await isAvailable();
        expect(result).toBe(false);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
      }
    });

    it("returns true on darwin with say and ffmpeg available", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true });
      mockExecAsync.mockResolvedValue({ stdout: "/usr/bin/say\n/usr/local/bin/ffmpeg" });
      try {
        const result = await isAvailable();
        expect(result).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
      }
    });

    it("returns false on darwin when commands not found", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true });
      mockExecAsync.mockRejectedValue(new Error("not found"));
      try {
        const result = await isAvailable();
        expect(result).toBe(false);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
      }
    });
  });

  describe("synthesize", () => {
    it("generates mp3 from text via say + ffmpeg", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "" }) // say command
        .mockResolvedValueOnce({ stdout: "" }); // ffmpeg command
      mockFsStat.mockResolvedValue({ size: 12345 });

      const result = await synthesize("Hello world");

      expect(result).toContain("openzigs-tts-");
      expect(result).toContain(".mp3");
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("openzigs-tts-"),
        "Hello world",
        "utf-8",
      );
      // say command with default Samantha voice
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('say -v "Samantha"'),
      );
      // ffmpeg conversion
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining("ffmpeg"),
      );
    });

    it("uses custom voice when provided", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecAsync.mockResolvedValue({ stdout: "" });
      mockFsStat.mockResolvedValue({ size: 5000 });

      await synthesize("Test voice", "Alex");

      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('say -v "Alex"'),
      );
    });

    it("cleans up aiff and txt files in finally block", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecAsync.mockResolvedValue({ stdout: "" });
      mockFsStat.mockResolvedValue({ size: 5000 });

      await synthesize("Cleanup test");

      // Should unlink .aiff and .txt temp files
      expect(mockFsUnlink).toHaveBeenCalledTimes(2);
      expect(mockFsUnlink).toHaveBeenCalledWith(expect.stringContaining(".aiff"));
      expect(mockFsUnlink).toHaveBeenCalledWith(expect.stringContaining(".txt"));
    });

    it("cleans up temp files even on say failure", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecAsync.mockRejectedValueOnce(new Error("say failed"));

      await expect(synthesize("Fail test")).rejects.toThrow("say failed");

      // Should still attempt cleanup
      expect(mockFsUnlink).toHaveBeenCalledTimes(2);
    });
  });
});
