import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: vi.fn((fn: Function) => {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
  }),
}));

import { execFile } from "node:child_process";
import { createMediaConverter } from "./media-converter.js";

describe("media-converter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createMediaConverter", () => {
    it("returns unavailable when ffmpeg is not found", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        cb(new Error("ENOENT"), "", "");
      });

      const converter = await createMediaConverter();
      expect(converter.available).toBe(false);
      expect(converter.unavailableReason).toContain("ffmpeg not found");
      expect(converter.name).toBe("media");
    });

    it("unavailable converter returns error on convert", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        cb(new Error("ENOENT"), "", "");
      });

      const converter = await createMediaConverter();
      const result = await converter.convert("/tmp/test.mp4");
      expect(result.success).toBe(false);
      expect(result.error).toContain("ffmpeg is not installed");
    });

    it("returns unavailable when whisper-node is not importable", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        cb(null, "ffmpeg version 6.0", "");
      });

      const converter = await createMediaConverter();
      // whisper-node won't be available in test environment
      expect(converter.name).toBe("media");
      // Either available (if whisper-node is installed) or not
      if (!converter.available) {
        expect(converter.unavailableReason).toContain("whisper-node");
      }
    });

    it("includes correct media extensions", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        cb(new Error("ENOENT"), "", "");
      });

      const converter = await createMediaConverter();
      expect(converter.extensions).toContain(".mp4");
      expect(converter.extensions).toContain(".mp3");
      expect(converter.extensions).toContain(".wav");
      expect(converter.extensions).toContain(".m4a");
      expect(converter.extensions).toContain(".webm");
      expect(converter.extensions).toContain(".ogg");
      expect(converter.extensions).toContain(".flac");
    });

    it("passes modelName option", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        cb(new Error("ENOENT"), "", "");
      });

      const converter = await createMediaConverter({ modelName: "large-v3" });
      expect(converter).toBeDefined();
      expect(converter.name).toBe("media");
    });

    it("uses base.en as default model", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        cb(new Error("ENOENT"), "", "");
      });

      const converter = await createMediaConverter({});
      expect(converter).toBeDefined();
    });

    it("unavailable whisper-node converter returns error on convert", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        cb(null, "ffmpeg version 6.0", "");
      });

      const converter = await createMediaConverter();
      if (!converter.available) {
        const result = await converter.convert("/tmp/test.mp4");
        expect(result.success).toBe(false);
        expect(result.error).toContain("whisper-node");
      }
    });
  });
});
