import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process — must use factory-only pattern to avoid hoisting issues
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ size: 1024 * 1024 }),
  },
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createIngestYouTubeTools } from "./ingest-youtube-tools.js";

const mockExecFile = vi.mocked(execFile);
const mockReaddir = vi.mocked(fs.readdir);
const mockStat = vi.mocked(fs.stat);
const mockMkdir = vi.mocked(fs.mkdir);

function makeMockRepo() {
  return {
    createAsset: vi.fn().mockReturnValue("asset-123"),
  };
}

// Utility to make execFileAsync (promisified) resolve/reject
function setupExecFile(...results: Array<{ stdout?: string; stderr?: string } | Error>) {
  for (const result of results) {
    if (result instanceof Error) {
      mockExecFile.mockImplementationOnce((...fnArgs: any[]) => {
        const cb = fnArgs[fnArgs.length - 1];
        if (typeof cb === "function") cb(result, "", "");
        return undefined as any;
      });
    } else {
      mockExecFile.mockImplementationOnce((...fnArgs: any[]) => {
        const cb = fnArgs[fnArgs.length - 1];
        if (typeof cb === "function") cb(null, result.stdout ?? "", result.stderr ?? "");
        return undefined as any;
      });
    }
  }
}

describe("createIngestYouTubeTools", () => {
  let repo: ReturnType<typeof makeMockRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock Date.now to produce predictable timestamps in filenames
    vi.spyOn(Date, "now").mockReturnValue(12345);
    // Restore base implementations after clearAllMocks
    mockMkdir.mockResolvedValue(undefined as any);
    mockReaddir.mockResolvedValue([] as any);
    mockStat.mockResolvedValue({ size: 1024 * 1024 } as any);
    repo = makeMockRepo();
  });

  it("returns one tool definition", () => {
    const tools = createIngestYouTubeTools({ repo: repo as any });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("ingest-youtube");
    expect(tools[0].category).toBe("productivity");
    expect(tools[0].riskLevel).toBe("high");
  });

  it("rejects invalid URLs", async () => {
    const tools = createIngestYouTubeTools({ repo: repo as any });
    const result = await tools[0].handler({ url: "not-a-url", format: "audio" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid URL");
  });

  it("rejects non-http protocols", async () => {
    const tools = createIngestYouTubeTools({ repo: repo as any });
    const result = await tools[0].handler({ url: "ftp://example.com/file", format: "audio" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid URL");
  });

  it("returns error when yt-dlp is not installed", async () => {
    // `which yt-dlp` fails
    setupExecFile(new Error("not found"));

    const tools = createIngestYouTubeTools({ repo: repo as any });
    const result = await tools[0].handler({ url: "https://youtube.com/watch?v=test", format: "audio" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("yt-dlp is not installed");
  });

  it("fetches metadata and proceeds to download", async () => {
    // 1. which yt-dlp
    setupExecFile({ stdout: "/usr/local/bin/yt-dlp" });
    // 2. metadata
    setupExecFile({ stdout: "Test Video\n120\nTestUploader" });
    // 3. download
    setupExecFile({ stdout: "", stderr: "" });

    // readdir returns empty — file "not found" but download itself succeeded
    const tools = createIngestYouTubeTools({ repo: repo as any });
    const result = await tools[0].handler({
      url: "https://www.youtube.com/watch?v=abc",
      format: "audio",
      artist: "TestArtist",
      tags: ["music"],
    });

    // Download succeeded but file not found in gallery
    expect(result.isError).toBe(true);
    expect(result.text).toContain("output file not found");
    // Verify all 3 exec calls happened (which, metadata, download)
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("returns error when output file not found", async () => {
    setupExecFile({ stdout: "/usr/local/bin/yt-dlp" });
    setupExecFile({ stdout: "Video\n60\nUser" });
    setupExecFile({ stdout: "", stderr: "" });

    // Default readdir mock returns []

    const tools = createIngestYouTubeTools({ repo: repo as any });
    const result = await tools[0].handler({
      url: "https://www.youtube.com/watch?v=abc",
      format: "audio",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  it("handles download failure gracefully", async () => {
    setupExecFile({ stdout: "/usr/local/bin/yt-dlp" });
    setupExecFile({ stdout: "Video\n60\nUser" });
    setupExecFile(new Error("Download failed: network error"));

    const tools = createIngestYouTubeTools({ repo: repo as any });
    const result = await tools[0].handler({
      url: "https://www.youtube.com/watch?v=abc",
      format: "video",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Download failed");
  });
});
