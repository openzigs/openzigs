import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("nanoid", () => {
  return { nanoid: () => "test1234" };
});

vi.mock("../../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import fs from "node:fs/promises";
import { PexelsDownloader } from "./pexels-downloader.js";

describe("PexelsDownloader", () => {
  let downloader: PexelsDownloader;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    downloader = new PexelsDownloader("test-api-key", "/tmp/pexels-cache");
  });

  describe("isConfigured", () => {
    it("returns true when API key is set", () => {
      expect(downloader.isConfigured()).toBe(true);
    });

    it("returns false when API key is empty", () => {
      const empty = new PexelsDownloader("", "/tmp/cache");
      expect(empty.isConfigured()).toBe(false);
    });
  });

  describe("searchPhotos", () => {
    it("returns empty array when not configured", async () => {
      const empty = new PexelsDownloader("", "/tmp/cache");
      const result = await empty.searchPhotos({ query: "nature" });
      expect(result).toEqual([]);
    });

    it("fetches photos from Pexels API", async () => {
      const mockPhotos = {
        photos: [
          {
            id: 123,
            width: 1920,
            height: 1080,
            url: "https://pexels.com/photo/123",
            photographer: "Test User",
            photographer_url: "https://pexels.com/user",
            alt: "Beautiful sunset",
            src: {
              original: "https://images.pexels.com/photos/123/original.jpg",
              large2x: "https://images.pexels.com/photos/123/large2x.jpg",
              large: "https://images.pexels.com/photos/123/large.jpg",
              medium: "https://images.pexels.com/photos/123/medium.jpg",
              small: "https://images.pexels.com/photos/123/small.jpg",
              portrait: "https://images.pexels.com/photos/123/portrait.jpg",
              landscape: "https://images.pexels.com/photos/123/landscape.jpg",
              tiny: "https://images.pexels.com/photos/123/tiny.jpg",
            },
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockPhotos),
      } as any);

      const results = await downloader.searchPhotos({ query: "sunset" });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("image");
      expect(results[0].source).toBe("pexels");
      expect(results[0].id).toContain("pexels_photo_123");
      expect(results[0].attribution).toContain("Test User");
    });

    it("returns empty array on API error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      } as any);

      const results = await downloader.searchPhotos({ query: "test" });
      expect(results).toEqual([]);
    });

    it("returns empty array on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
      const results = await downloader.searchPhotos({ query: "test" });
      expect(results).toEqual([]);
    });

    it("returns empty when API returns no photos property", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      const results = await downloader.searchPhotos({ query: "test" });
      expect(results).toEqual([]);
    });

    it("sends correct search parameters", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ photos: [] }),
      } as any);

      await downloader.searchPhotos({ query: "ocean", perPage: 10, page: 2 });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const url = fetchCall[0] as string;
      expect(url).toContain("query=ocean");
      expect(url).toContain("per_page=10");
      expect(url).toContain("page=2");
    });

    it("sends Authorization header with API key", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ photos: [] }),
      } as any);

      await downloader.searchPhotos({ query: "test" });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const options = fetchCall[1] as RequestInit;
      expect((options.headers as any).Authorization).toBe("test-api-key");
    });
  });

  describe("searchVideos", () => {
    it("returns empty array when not configured", async () => {
      const empty = new PexelsDownloader("", "/tmp/cache");
      const result = await empty.searchVideos({ query: "nature" });
      expect(result).toEqual([]);
    });

    it("fetches videos from Pexels API", async () => {
      const mockVideos = {
        videos: [
          {
            id: 456,
            width: 1920,
            height: 1080,
            url: "https://pexels.com/video/456",
            duration: 30,
            user: { name: "Vid User", url: "https://pexels.com/vid-user" },
            image: "https://images.pexels.com/videos/456/thumb.jpg",
            video_files: [
              { id: 1, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, link: "https://videos.pexels.com/456/hd.mp4" },
            ],
          },
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockVideos),
      } as any);

      const results = await downloader.searchVideos({ query: "ocean" });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("video");
      expect(results[0].source).toBe("pexels");
      expect(results[0].duration).toBe(30);
    });

    it("passes duration filters to videos API", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ videos: [] }),
      } as any);

      await downloader.searchVideos({ query: "wave", minDuration: 10, maxDuration: 60 });

      const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
      expect(url).toContain("min_duration=10");
      expect(url).toContain("max_duration=60");
    });
  });

  describe("search (unified)", () => {
    it("returns empty array when not configured", async () => {
      const empty = new PexelsDownloader("", "/tmp/cache");
      const result = await empty.search({ query: "nature" });
      expect(result).toEqual([]);
    });

    it("searches both photos and videos by default", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ photos: [], videos: [] }),
      } as any);

      await downloader.search({ query: "test" });
      // Should call fetch twice (photos + videos)
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("searches only photos when type is image", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ photos: [] }),
      } as any);

      await downloader.search({ query: "test", type: "image" });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
      expect(url).toContain("/v1/search");
    });

    it("searches only videos when type is video", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ videos: [] }),
      } as any);

      await downloader.search({ query: "test", type: "video" });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
      expect(url).toContain("/videos/search");
    });
  });

  describe("download", () => {
    it("downloads and saves a photo", async () => {
      const mockBuffer = new ArrayBuffer(8);
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer),
      } as any);

      const result = await downloader.download(
        "https://images.pexels.com/photos/123/large.jpg",
        "sunset-photo",
      );

      expect(result).toContain("pexels_test1234_sunset-photo.jpg");
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("downloads mp4 files with correct extension", async () => {
      const mockBuffer = new ArrayBuffer(8);
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer),
      } as any);

      const result = await downloader.download(
        "https://videos.pexels.com/456/hd.mp4",
        "ocean-vid",
      );

      expect(result).toContain(".mp4");
    });

    it("throws on download failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as any);

      await expect(
        downloader.download("https://images.pexels.com/missing.jpg", "test"),
      ).rejects.toThrow("Failed to download from Pexels: 404");
    });

    it("sanitizes asset name in filename", async () => {
      const mockBuffer = new ArrayBuffer(8);
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer),
      } as any);

      const result = await downloader.download(
        "https://images.pexels.com/photos/123/large.jpg",
        "hello world/test<>file",
      );

      // Should sanitize special characters
      expect(result).not.toContain(" ");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
    });
  });
});
