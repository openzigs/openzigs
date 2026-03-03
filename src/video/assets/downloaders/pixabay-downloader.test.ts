import { describe, it, expect, vi, beforeEach } from "vitest";
import { PixabayDownloader } from "./pixabay-downloader.js";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("nanoid", () => ({ nanoid: () => "TESTID01" }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("PixabayDownloader", () => {
  let downloader: PixabayDownloader;

  beforeEach(() => {
    vi.clearAllMocks();
    downloader = new PixabayDownloader("test-api-key", "/tmp/cache");
  });

  describe("isConfigured", () => {
    it("returns true when API key is present", () => {
      expect(downloader.isConfigured()).toBe(true);
    });

    it("returns false when API key is empty", () => {
      const unconfigured = new PixabayDownloader("", "/tmp/cache");
      expect(unconfigured.isConfigured()).toBe(false);
    });
  });

  describe("search", () => {
    it("returns empty array when not configured", async () => {
      const unconfigured = new PixabayDownloader("", "/tmp/cache");
      const result = await unconfigured.search({ query: "chill" });
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns mapped assets from successful search", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            hits: [
              {
                id: 456,
                title: "Ambient Loop",
                tags: "ambient, chill, relax",
                duration: 120,
                audio_url: "https://pixabay.com/audio/456.mp3",
                user: "soundmaker",
              },
            ],
          }),
      });

      const results = await downloader.search({ query: "ambient" });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("pixabay_456");
      expect(results[0].name).toBe("Ambient Loop");
      expect(results[0].source).toBe("pixabay");
      expect(results[0].type).toBe("music");
      expect(results[0].duration).toBe(120);
      expect(results[0].tags).toEqual(["ambient", "chill", "relax"]);
      expect(results[0].license).toBe("Pixabay License (royalty-free)");
      expect(results[0].previewUrl).toBe("https://pixabay.com/audio/456.mp3");
    });

    it("uses title fallback when title is empty", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            hits: [{ id: 99, title: "", tags: "", duration: 30, user: "u" }],
          }),
      });

      const results = await downloader.search({ query: "beat" });
      expect(results[0].name).toBe("Pixabay Track 99");
    });

    it("applies duration filters client-side", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            hits: [
              { id: 1, title: "Short", tags: "", duration: 10, user: "u" },
              { id: 2, title: "Medium", tags: "", duration: 60, user: "u" },
              { id: 3, title: "Long", tags: "", duration: 300, user: "u" },
            ],
          }),
      });

      const results = await downloader.search({ query: "test", minDuration: 30, maxDuration: 120 });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Medium");
    });

    it("passes pagination params correctly", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ hits: [] }) });

      await downloader.search({ query: "rock", page: 2, perPage: 5 });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("per_page")).toBe("5");
    });

    it("returns empty array on API error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" });
      const results = await downloader.search({ query: "test" });
      expect(results).toEqual([]);
    });

    it("returns empty array on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("DNS failure"));
      const results = await downloader.search({ query: "test" });
      expect(results).toEqual([]);
    });

    it("returns empty when hits are missing", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      const results = await downloader.search({ query: "test" });
      expect(results).toEqual([]);
    });

    it("handles empty tags string", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            hits: [{ id: 7, title: "No Tags", tags: "", duration: 45, user: "u" }],
          }),
      });

      const results = await downloader.search({ query: "test" });
      expect(results[0].tags).toEqual([]);
    });
  });

  describe("download", () => {
    it("downloads a file and returns the output path", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });

      const fsMod = await import("node:fs/promises");
      const outputPath = await downloader.download(
        "https://pixabay.com/audio/456.mp3",
        "Ambient Loop",
      );

      expect(outputPath).toContain("pixabay_TESTID01_Ambient_Loop.mp3");
      expect(fsMod.default.mkdir).toHaveBeenCalled();
      expect(fsMod.default.writeFile).toHaveBeenCalled();
    });

    it("throws on failed download", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
      await expect(
        downloader.download("https://pixabay.com/audio/missing.mp3", "Gone"),
      ).rejects.toThrow("Failed to download from Pixabay: 403");
    });

    it("sanitizes filenames", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });

      const outputPath = await downloader.download("https://pixabay.com/audio/1.mp3", "Bad/File:Name!");
      expect(outputPath).toContain("Bad_File_Name_");
    });
  });
});
