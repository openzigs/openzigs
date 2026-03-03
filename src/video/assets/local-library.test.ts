import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanLocalLibrary } from "./local-library.js";
import type { Dirent } from "node:fs";

vi.mock("nanoid", () => ({ nanoid: () => "TESTID0001" }));

const mockReaddir = vi.fn();
vi.mock("node:fs/promises", () => ({
  default: {
    readdir: (...args: unknown[]) => mockReaddir(...args),
  },
}));

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: "",
    path: "",
  } as Dirent;
}

describe("scanLocalLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when directories don't exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const assets = await scanLocalLibrary("/no/such/path", "/no/cache");
    expect(assets).toEqual([]);
  });

  it("scans audio files and maps them correctly", async () => {
    // First call: local library dir
    mockReaddir.mockResolvedValueOnce([
      makeDirent("background.mp3", false),
      makeDirent("narration.wav", false),
      makeDirent("readme.txt", false),
    ]);
    // Second call: cache dir
    mockReaddir.mockResolvedValueOnce([]);

    const assets = await scanLocalLibrary("/assets/music", "/cache");

    expect(assets).toHaveLength(2);
    expect(assets[0].name).toBe("Background");
    expect(assets[0].type).toBe("music");
    expect(assets[0].license).toBe("local");
    expect(assets[1].name).toBe("Narration");
  });

  it("detects sfx type from parent directory name", async () => {
    // Local library dir contains "sfx" subdir
    mockReaddir.mockResolvedValueOnce([makeDirent("sfx", true)]);
    // The sfx subdir
    mockReaddir.mockResolvedValueOnce([makeDirent("click.wav", false)]);
    // Cache dir
    mockReaddir.mockResolvedValueOnce([]);

    const assets = await scanLocalLibrary("/assets", "/cache");

    expect(assets).toHaveLength(1);
    expect(assets[0].type).toBe("sfx");
    expect(assets[0].tags).toContain("sfx");
  });

  it("supports all expected audio extensions", async () => {
    const audioFiles = [
      makeDirent("a.mp3", false),
      makeDirent("b.wav", false),
      makeDirent("c.ogg", false),
      makeDirent("d.m4a", false),
      makeDirent("e.flac", false),
      makeDirent("f.aac", false),
    ];
    mockReaddir.mockResolvedValueOnce(audioFiles);
    mockReaddir.mockResolvedValueOnce([]);

    const assets = await scanLocalLibrary("/lib", "/cache");
    expect(assets).toHaveLength(6);
  });

  it("ignores non-audio files", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent("video.mp4", false),
      makeDirent("doc.pdf", false),
      makeDirent("image.png", false),
    ]);
    mockReaddir.mockResolvedValueOnce([]);

    const assets = await scanLocalLibrary("/lib", "/cache");
    expect(assets).toHaveLength(0);
  });

  it("formats filenames as human-readable names", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent("background-music_loop.mp3", false),
    ]);
    mockReaddir.mockResolvedValueOnce([]);

    const assets = await scanLocalLibrary("/lib", "/cache");
    expect(assets[0].name).toBe("Background Music Loop");
  });

  it("recursively scans subdirectories", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent("subdir", true),
      makeDirent("root.mp3", false),
    ]);
    mockReaddir.mockResolvedValueOnce([
      makeDirent("nested.wav", false),
    ]);
    mockReaddir.mockResolvedValueOnce([]);

    const assets = await scanLocalLibrary("/lib", "/cache");
    expect(assets).toHaveLength(2);
  });

  it("scans both local library and cache directories", async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent("local.mp3", false)]);
    mockReaddir.mockResolvedValueOnce([makeDirent("cached.mp3", false)]);

    const assets = await scanLocalLibrary("/lib", "/cache");
    expect(assets).toHaveLength(2);
  });
});
