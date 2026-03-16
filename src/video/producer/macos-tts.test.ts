import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFileAsync, mockFsWriteFile, mockFsStat, mockFsUnlink } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockFsWriteFile: vi.fn(),
  mockFsStat: vi.fn(),
  mockFsUnlink: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
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
      mockExecFileAsync.mockResolvedValue({ stdout: "/usr/bin/say" });
      try {
        const result = await isAvailable();
        expect(result).toBe(true);
        // Should call which for both 'say' and 'ffmpeg' separately
        expect(mockExecFileAsync).toHaveBeenCalledWith("which", ["say"]);
        expect(mockExecFileAsync).toHaveBeenCalledWith("which", ["ffmpeg"]);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
      }
    });

    it("returns false on darwin when commands not found", async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true });
      mockExecFileAsync.mockRejectedValue(new Error("not found"));
      try {
        const result = await isAvailable();
        expect(result).toBe(false);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
      }
    });
  });

  describe("synthesize", () => {
    it("generates mp3 from text via say + ffmpeg using execFile (no shell)", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecFileAsync
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
      // say command with args as array (not shell string)
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "say",
        expect.arrayContaining(["-v", "Samantha"]),
      );
      // ffmpeg conversion with args as array
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "ffmpeg",
        expect.arrayContaining(["-codec:a", "libmp3lame"]),
      );
    });

    it("uses custom voice when provided", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecFileAsync.mockResolvedValue({ stdout: "" });
      mockFsStat.mockResolvedValue({ size: 5000 });

      await synthesize("Test voice", "Alex");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "say",
        expect.arrayContaining(["-v", "Alex"]),
      );
    });

    it("cleans up aiff and txt files in finally block", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecFileAsync.mockResolvedValue({ stdout: "" });
      mockFsStat.mockResolvedValue({ size: 5000 });

      await synthesize("Cleanup test");

      // Should unlink .aiff and .txt temp files
      expect(mockFsUnlink).toHaveBeenCalledTimes(2);
      expect(mockFsUnlink).toHaveBeenCalledWith(expect.stringContaining(".aiff"));
      expect(mockFsUnlink).toHaveBeenCalledWith(expect.stringContaining(".txt"));
    });

    it("cleans up temp files even on say failure", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecFileAsync.mockRejectedValueOnce(new Error("say failed"));

      await expect(synthesize("Fail test")).rejects.toThrow("say failed");

      // Should still attempt cleanup
      expect(mockFsUnlink).toHaveBeenCalledTimes(2);
    });

    // ── Shell injection prevention tests (Issue #466) ───────

    it("rejects voice names with shell metacharacters", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      await expect(synthesize("Hello", '"; rm -rf / #')).rejects.toThrow("Invalid voice name");
    });

    it("rejects voice names with backticks", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      await expect(synthesize("Hello", "`whoami`")).rejects.toThrow("Invalid voice name");
    });

    it("rejects voice names with $() command substitution", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      await expect(synthesize("Hello", "$(cat /etc/passwd)")).rejects.toThrow("Invalid voice name");
    });

    it("rejects voice names with semicolons", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      await expect(synthesize("Hello", "Sam; rm -rf /")).rejects.toThrow("Invalid voice name");
    });

    it("passes args as array to execFile, never as shell string", async () => {
      mockFsWriteFile.mockResolvedValue(undefined);
      mockExecFileAsync.mockResolvedValue({ stdout: "" });
      mockFsStat.mockResolvedValue({ size: 5000 });

      await synthesize("Hello", "Samantha");

      // Verify all calls use array-based args (execFile), not string (exec)
      for (const call of mockExecFileAsync.mock.calls) {
        expect(typeof call[0]).toBe("string"); // command name
        expect(Array.isArray(call[1])).toBe(true); // args array
      }
    });
  });
});
