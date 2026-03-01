import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

import { execFile } from "node:child_process";
import fs from "node:fs";
import { generateThumbnail } from "./thumbnail-generator.js";
import { logger } from "../logging/logger.js";

describe("thumbnail-generator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateThumbnail", () => {
    it("creates thumbnail directory recursively", async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: unknown, _opts: unknown, cb?: Function) => {
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await generateThumbnail("/path/to/video.mp4", "pres-123", 100);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("thumbnails"),
        { recursive: true },
      );
    });

    it("calls ffmpeg with correct seek time at 25%", async () => {
      let capturedArgs: string[] = [];
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: unknown, _opts: unknown, cb?: Function) => {
          capturedArgs = args as string[];
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await generateThumbnail("/path/video.mp4", "pres-1", 200);

      // Seek time = 200 * 0.25 = 50.00
      expect(capturedArgs).toContain("-ss");
      const ssIndex = capturedArgs.indexOf("-ss");
      expect(capturedArgs[ssIndex + 1]).toBe("50.00");
    });

    it("uses presentation ID for output filename", async () => {
      let capturedArgs: string[] = [];
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: unknown, _opts: unknown, cb?: Function) => {
          capturedArgs = args as string[];
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await generateThumbnail("/path/video.mp4", "unique-pres-id", 60);

      const outputArg = capturedArgs.find((a: string) => a.endsWith(".jpg"));
      expect(outputArg).toContain("unique-pres-id.jpg");
    });

    it("returns the output path when file exists after ffmpeg", async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: unknown, _opts: unknown, cb?: Function) => {
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await generateThumbnail("/path/video.mp4", "pres-abc", 120);

      expect(result).toContain("pres-abc.jpg");
    });

    it("returns null when output file does not exist after ffmpeg", async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: unknown, _opts: unknown, cb?: Function) => {
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await generateThumbnail("/path/video.mp4", "pres-missing", 120);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("output not found"),
      );
    });

    it("returns null when ffmpeg fails", async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: unknown, _opts: unknown, cb?: Function) => {
          if (cb) cb(new Error("ffmpeg not found"), "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );

      const result = await generateThumbnail("/path/video.mp4", "pres-err", 60);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to generate thumbnail"),
      );
    });

    it("handles zero duration gracefully (seek at 0)", async () => {
      let capturedArgs: string[] = [];
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: unknown, _opts: unknown, cb?: Function) => {
          capturedArgs = args as string[];
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await generateThumbnail("/path/video.mp4", "pres-zero", 0);

      const ssIndex = capturedArgs.indexOf("-ss");
      expect(capturedArgs[ssIndex + 1]).toBe("0.00");
    });

    it("clamps negative seek time to 0", async () => {
      let capturedArgs: string[] = [];
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: unknown, _opts: unknown, cb?: Function) => {
          capturedArgs = args as string[];
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      // -10 * 0.25 = -2.5, Math.max(0, -2.5) = 0
      await generateThumbnail("/path/video.mp4", "pres-neg", -10);

      const ssIndex = capturedArgs.indexOf("-ss");
      expect(capturedArgs[ssIndex + 1]).toBe("0.00");
    });

    it("passes -y flag to overwrite existing thumbnails", async () => {
      let capturedArgs: string[] = [];
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: unknown, _opts: unknown, cb?: Function) => {
          capturedArgs = args as string[];
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await generateThumbnail("/path/video.mp4", "pres-overwrite", 100);

      expect(capturedArgs).toContain("-y");
    });

    it("extracts only 1 frame (-vframes 1)", async () => {
      let capturedArgs: string[] = [];
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: unknown, _opts: unknown, cb?: Function) => {
          capturedArgs = args as string[];
          if (cb) cb(null, "", "");
          return {} as ReturnType<typeof execFile>;
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await generateThumbnail("/path/video.mp4", "pres-frames", 60);

      const vfIdx = capturedArgs.indexOf("-vframes");
      expect(vfIdx).toBeGreaterThan(-1);
      expect(capturedArgs[vfIdx + 1]).toBe("1");
    });
  });
});
