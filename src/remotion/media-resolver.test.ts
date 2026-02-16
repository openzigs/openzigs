/**
 * Director Mode — Media Resolver Tests
 * Issue #245
 */

import { describe, it, expect } from "vitest";
import { resolveMediaPath } from "./media-resolver.js";
import os from "node:os";
import path from "node:path";

describe("resolveMediaPath", () => {
  const baseDir = "/renders/job-123";

  it("passes through HTTP URLs unchanged", () => {
    expect(resolveMediaPath("http://example.com/video.mp4", baseDir)).toBe(
      "http://example.com/video.mp4",
    );
  });

  it("passes through HTTPS URLs unchanged", () => {
    expect(resolveMediaPath("https://cdn.example.com/music.mp3", baseDir)).toBe(
      "https://cdn.example.com/music.mp3",
    );
  });

  it("strips file:// prefix", () => {
    expect(resolveMediaPath("file:///Users/test/clip.mp4", baseDir)).toBe(
      "/Users/test/clip.mp4",
    );
  });

  it("expands tilde to home directory", () => {
    const result = resolveMediaPath("~/media/clip.mp4", baseDir);
    expect(result).toBe(path.join(os.homedir(), "media/clip.mp4"));
  });

  it("expands tilde-only path", () => {
    const result = resolveMediaPath("~/test.mp3", baseDir);
    expect(result).toBe(path.join(os.homedir(), "test.mp3"));
  });

  it("returns absolute paths unchanged", () => {
    expect(resolveMediaPath("/absolute/path/video.mp4", baseDir)).toBe(
      "/absolute/path/video.mp4",
    );
  });

  it("resolves relative paths against baseDir", () => {
    const result = resolveMediaPath("clips/intro.mp4", baseDir);
    expect(result).toBe(path.resolve(baseDir, "clips/intro.mp4"));
  });

  it("resolves bare filename against baseDir", () => {
    const result = resolveMediaPath("output.mp4", baseDir);
    expect(result).toBe(path.resolve(baseDir, "output.mp4"));
  });
});
