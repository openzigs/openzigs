/**
 * Director Mode — Media Resolver Tests
 * Issue #245, #597
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveMediaPath, stageMediaFile } from "./media-resolver.js";
import fs from "node:fs";
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

describe("stageMediaFile", () => {
  const bundleDir = "/tmp/remotion-bundle";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns remote HTTP URLs unchanged", () => {
    const result = stageMediaFile("http://example.com/video.mp4", bundleDir);
    expect(result).toBe("http://example.com/video.mp4");
  });

  it("returns remote HTTPS URLs unchanged", () => {
    const result = stageMediaFile("https://cdn.example.com/audio.mp3", bundleDir);
    expect(result).toBe("https://cdn.example.com/audio.mp3");
  });

  it("returns null when source file does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = stageMediaFile("/nonexistent/file.mp4", bundleDir);
    expect(result).toBeNull();
  });

  it("stages a local file via hard link", () => {
    vi.spyOn(fs, "existsSync")
      .mockReturnValueOnce(true)  // source exists
      .mockReturnValueOnce(false); // staged path does not exist yet
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation(() => undefined);
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);

    const result = stageMediaFile("/source/video.mp4", bundleDir);
    expect(result).toMatch(/^\/media-.*-video\.mp4$/);
    expect(linkSpy).toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
  });

  it("falls back to copy when hard link fails", () => {
    vi.spyOn(fs, "existsSync")
      .mockReturnValueOnce(true)  // source exists
      .mockReturnValueOnce(false); // staged path does not exist yet
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);

    const result = stageMediaFile("/source/video.mp4", bundleDir);
    expect(result).toMatch(/^\/media-.*-video\.mp4$/);
    expect(linkSpy).toHaveBeenCalled();
    expect(copySpy).toHaveBeenCalled();
  });

  it("skips staging if file already exists in bundle dir", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true); // both source and staged
    const linkSpy = vi.spyOn(fs, "linkSync");
    const copySpy = vi.spyOn(fs, "copyFileSync");

    const result = stageMediaFile("/source/video.mp4", bundleDir);
    expect(result).toMatch(/^\/media-.*-video\.mp4$/);
    expect(linkSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
  });

  it("generates consistent hash-based filenames", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result1 = stageMediaFile("/source/video.mp4", bundleDir);
    const result2 = stageMediaFile("/source/video.mp4", bundleDir);
    expect(result1).toBe(result2); // same input → same staged name
  });

  it("generates different filenames for different sources", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result1 = stageMediaFile("/source/video1.mp4", bundleDir);
    const result2 = stageMediaFile("/source/video2.mp4", bundleDir);
    expect(result1).not.toBe(result2);
  });
});
