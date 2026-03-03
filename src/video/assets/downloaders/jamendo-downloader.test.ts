import { describe, it, expect, vi, beforeEach } from "vitest";
import { JamendoDownloader } from "./jamendo-downloader.js";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("nanoid", () => ({ nanoid: () => "TESTID01" }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("JamendoDownloader", () => {
  let downloader: JamendoDownloader;

  beforeEach(() => {
    vi.clearAllMocks();
    downloader = new JamendoDownloader("test-client-id", "/tmp/cache");
  });

  describe("isConfigured", () => {
    it("returns true when client ID is present", () => {
      expect(downloader.isConfigured()).toBe(true);
    });

    it("returns false when client ID is empty", () => {
      const unconfigured = new JamendoDownloader("", "/tmp/cache");
      expect(unconfigured.isConfigured()).toBe(false);
    });
  });

  describe("search", () => {
    it("returns empty array when not configured", async () => {
      const unconfigured = new JamendoDownloader("", "/tmp/cache");
      const result = await unconfigured.search({ query: "chill" });
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns mapped assets on successful search", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                id: "123",
                name: "Chill Vibes",
                duration: 180,
                artist_name: "DJ Test",
                audio: "https://jamendo.com/stream/123",
                audiodownload: "https://jamendo.com/dl/123",
                image: "https://jamendo.com/img/123.jpg",
                license_ccurl: "https://creativecommons.org/licenses/by-sa/4.0/",
                musicinfo: { tags: { genres: ["electronic"], instruments: [], vartags: ["chill"] } },
              },
            ],
          }),
      });

      const results = await downloader.search({ query: "chill" });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("jamendo_123");
      expect(results[0].name).toBe("Chill Vibes");
      expect(results[0].source).toBe("jamendo");
      expect(results[0].type).toBe("music");
      expect(results[0].duration).toBe(180);
      expect(results[0].license).toBe("CC BY-SA");
      expect(results[0].attribution).toContain("DJ Test");
      expect(results[0].tags).toContain("electronic");
      expect(results[0].previewUrl).toBe("https://jamendo.com/stream/123");
    });

    it("passes pagination params correctly", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [] }) });

      await downloader.search({ query: "rock", page: 3, perPage: 10 });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("offset")).toBe("20"); // (3-1) * 10
      expect(url.searchParams.get("limit")).toBe("10");
    });

    it("passes duration filters", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [] }) });

      await downloader.search({ query: "ambient", minDuration: 60, maxDuration: 300 });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("durationbetween")).toBe("60_300");
    });

    it("returns empty array on API error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error" });
      const results = await downloader.search({ query: "test" });
      expect(results).toEqual([]);
    });

    it("returns empty array on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network failure"));
      const results = await downloader.search({ query: "test" });
      expect(results).toEqual([]);
    });

    it("returns empty when results are missing", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      const results = await downloader.search({ query: "test" });
      expect(results).toEqual([]);
    });
  });

  describe("download", () => {
    it("downloads a file and returns the output path", async () => {
      const fakeArrayBuffer = new ArrayBuffer(8);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeArrayBuffer),
      });

      const fsMod = await import("node:fs/promises");
      const outputPath = await downloader.download(
        "https://jamendo.com/dl/123",
        "Chill Vibes",
      );

      expect(outputPath).toContain("jamendo_TESTID01_Chill_Vibes.mp3");
      expect(fsMod.default.mkdir).toHaveBeenCalled();
      expect(fsMod.default.writeFile).toHaveBeenCalled();
    });

    it("writes attribution metadata file when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });

      const fsMod = await import("node:fs/promises");
      await downloader.download("https://jamendo.com/dl/456", "MyTrack", "CC BY-SA by Artist");

      const writeFileCalls = vi.mocked(fsMod.default.writeFile).mock.calls;
      const attrCall = writeFileCalls.find((c) => String(c[0]).includes(".attribution.txt"));
      expect(attrCall).toBeDefined();
      expect(attrCall![1]).toBe("CC BY-SA by Artist");
    });

    it("throws on failed download", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      await expect(
        downloader.download("https://jamendo.com/dl/missing", "Gone"),
      ).rejects.toThrow("Failed to download from Jamendo: 404");
    });

    it("sanitizes filenames", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });

      const outputPath = await downloader.download("https://jamendo.com/dl/1", "Bad/File:Name!");
      expect(outputPath).toContain("Bad_File_Name_");
      expect(outputPath).not.toContain("/File");
    });
  });

  describe("parseCCLicense (via mapToAssetMetadata)", () => {
    it.each([
      ["https://creativecommons.org/licenses/by-sa/4.0/", "CC BY-SA"],
      ["https://creativecommons.org/licenses/by-nc-sa/4.0/", "CC BY-NC-SA"],
      ["https://creativecommons.org/licenses/by-nc-nd/4.0/", "CC BY-NC-ND"],
      ["https://creativecommons.org/licenses/by-nc/4.0/", "CC BY-NC"],
      ["https://creativecommons.org/licenses/by-nd/4.0/", "CC BY-ND"],
      ["https://creativecommons.org/licenses/by/4.0/", "CC BY"],
      ["https://creativecommons.org/publicdomain/zero/1.0/", "CC0 / Public Domain"],
      ["https://example.com/unknown", "Creative Commons"],
    ])("parses %s as %s", async (url, expected) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                id: "1",
                name: "Track",
                duration: 60,
                artist_name: "Artist",
                audio: "https://jamendo.com/stream/1",
                audiodownload: "",
                image: "",
                license_ccurl: url,
              },
            ],
          }),
      });

      const results = await downloader.search({ query: "test" });
      expect(results[0].license).toBe(expected);
    });
  });
});
