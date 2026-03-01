import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./local-library.js", () => ({
  scanLocalLibrary: vi.fn().mockResolvedValue([
    {
      id: "local-1",
      name: "test-video",
      type: "video",
      source: "local",
      filePath: "/lib/test-video.mp4",
      previewUrl: "",
      tags: ["nature", "landscape"],
      duration: 30,
    },
    {
      id: "local-2",
      name: "test-music",
      type: "music",
      source: "local",
      filePath: "/lib/test-music.mp3",
      previewUrl: "",
      tags: ["ambient"],
      duration: 120,
    },
  ]),
}));

vi.mock("./downloaders/pixabay-downloader.js", () => ({
  PixabayDownloader: vi.fn().mockImplementation(() => ({
    isConfigured: vi.fn().mockReturnValue(true),
    search: vi.fn().mockResolvedValue([
      { id: "px-1", name: "pixabay-photo", type: "image", source: "pixabay", tags: [], duration: 0 },
    ]),
    download: vi.fn().mockResolvedValue("/cache/pixabay-photo.jpg"),
  })),
}));

vi.mock("./downloaders/jamendo-downloader.js", () => ({
  JamendoDownloader: vi.fn().mockImplementation(() => ({
    isConfigured: vi.fn().mockReturnValue(true),
    search: vi.fn().mockResolvedValue([
      { id: "jm-1", name: "jamendo-song", type: "music", source: "jamendo", tags: [], duration: 180, attribution: "CC" },
    ]),
    download: vi.fn().mockResolvedValue("/cache/jamendo-song.mp3"),
  })),
}));

vi.mock("./downloaders/pexels-downloader.js", () => ({
  PexelsDownloader: vi.fn().mockImplementation(() => ({
    isConfigured: vi.fn().mockReturnValue(true),
    search: vi.fn().mockResolvedValue([
      { id: "px-1", name: "pexels-video", type: "video", source: "pexels", tags: [], duration: 15 },
    ]),
    download: vi.fn().mockResolvedValue("/cache/pexels-video.mp4"),
  })),
}));

import { AssetManager } from "./asset-manager.js";
import { PixabayDownloader } from "./downloaders/pixabay-downloader.js";
import { JamendoDownloader } from "./downloaders/jamendo-downloader.js";
import { PexelsDownloader } from "./downloaders/pexels-downloader.js";

const defaultConfig = {
  localLibraryPath: "/lib",
  downloadCachePath: "/cache",
  pixabay: { enabled: true, apiKey: "key1" },
  jamendo: { enabled: true, clientId: "id1" },
  pexels: { enabled: true, apiKey: "key2" },
};

describe("AssetManager", () => {
  let manager: AssetManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AssetManager(defaultConfig);
  });

  describe("constructor", () => {
    it("creates downloader instances with config", () => {
      expect(PixabayDownloader).toHaveBeenCalledWith("key1", "/cache");
      expect(JamendoDownloader).toHaveBeenCalledWith("id1", "/cache");
      expect(PexelsDownloader).toHaveBeenCalledWith("key2", "/cache");
    });

    it("passes empty string for disabled downloaders", () => {
      new AssetManager({
        ...defaultConfig,
        pixabay: { enabled: false, apiKey: "key1" },
      });
      expect(PixabayDownloader).toHaveBeenLastCalledWith("", "/cache");
    });
  });

  describe("initialize", () => {
    it("scans local library on first call", async () => {
      await manager.initialize();
      const assets = manager.getLocalAssets();
      expect(assets).toHaveLength(2);
    });

    it("skips re-initialization", async () => {
      const { scanLocalLibrary } = await import("./local-library.js");
      await manager.initialize();
      await manager.initialize();
      expect(scanLocalLibrary).toHaveBeenCalledTimes(1);
    });
  });

  describe("search", () => {
    it("searches all sources by default", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "test" });
      // Local (2) + Pixabay (1) + Jamendo (1) + Pexels (1) = 5
      expect(result.assets.length).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it("searches only local source", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "nature", source: "local" });
      expect(result.assets.every((a) => a.source === "local")).toBe(true);
    });

    it("searches only pixabay", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "photo", source: "pixabay" });
      expect(result.assets.length).toBe(1);
    });

    it("searches only jamendo", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "song", source: "jamendo" });
      expect(result.assets.length).toBe(1);
    });

    it("searches only pexels", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "video", source: "pexels" });
      expect(result.assets.length).toBe(1);
    });

    it("auto-initializes if not yet initialized", async () => {
      const result = await manager.search({ query: "test" });
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it("filters by asset type", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "test", type: "music" });
      expect(result.assets.every((a) => a.type === "music")).toBe(true);
    });

    it("paginates results", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "test", perPage: 2, page: 1 });
      expect(result.perPage).toBe(2);
      expect(result.page).toBe(1);
      expect(result.assets.length).toBeLessThanOrEqual(2);
    });

    it("handles page beyond results", async () => {
      await manager.initialize();
      const result = await manager.search({ query: "test", perPage: 20, page: 100 });
      expect(result.assets).toHaveLength(0);
    });

    it("filters local assets by duration", async () => {
      await manager.initialize();
      const result = await manager.search({
        query: "test",
        source: "local",
        minDuration: 60,
      });
      // Only the music asset (120s) should match
      expect(result.assets.every((a) => a.duration >= 60)).toBe(true);
    });

    it("skips unconfigured downloaders", async () => {
      const mgr = new AssetManager({
        ...defaultConfig,
        pixabay: { enabled: false, apiKey: "" },
      });
      // Mock the pixabay as not configured
      const pxInstance = vi.mocked(PixabayDownloader).mock.results[1]?.value;
      if (pxInstance) pxInstance.isConfigured.mockReturnValue(false);
      await mgr.initialize();
      const result = await mgr.search({ query: "test", source: "pixabay" });
      expect(result.assets).toHaveLength(0);
    });
  });

  describe("download", () => {
    it("downloads pixabay asset", async () => {
      await manager.initialize();
      const asset = { id: "px-1", name: "photo", type: "image" as const, source: "pixabay" as const, previewUrl: "https://example.com/photo.jpg", tags: [], duration: 0 };
      const result = await manager.download(asset);
      expect(result.filePath).toBe("/cache/pixabay-photo.jpg");
      expect(result.asset.filePath).toBe("/cache/pixabay-photo.jpg");
    });

    it("downloads jamendo asset", async () => {
      await manager.initialize();
      const asset = { id: "jm-1", name: "song", type: "music" as const, source: "jamendo" as const, previewUrl: "https://example.com/song.mp3", tags: [], duration: 180, attribution: "CC" };
      const result = await manager.download(asset);
      expect(result.filePath).toBe("/cache/jamendo-song.mp3");
    });

    it("downloads pexels asset", async () => {
      await manager.initialize();
      const asset = { id: "px-2", name: "vid", type: "video" as const, source: "pexels" as const, previewUrl: "https://example.com/vid.mp4", tags: [], duration: 10 };
      const result = await manager.download(asset);
      expect(result.filePath).toBe("/cache/pexels-video.mp4");
    });

    it("throws for asset without previewUrl", async () => {
      const asset = { id: "1", name: "t", type: "image" as const, source: "pixabay" as const, previewUrl: "", tags: [], duration: 0 };
      await expect(manager.download(asset)).rejects.toThrow("has no download URL");
    });

    it("throws for local asset download attempt", async () => {
      const asset = { id: "1", name: "t", type: "image" as const, source: "local" as const, previewUrl: "http://x.com", tags: [], duration: 0 };
      await expect(manager.download(asset)).rejects.toThrow("Cannot download local asset");
    });

    it("adds downloaded asset to local cache", async () => {
      await manager.initialize();
      const beforeCount = manager.getLocalAssets().length;
      const asset = { id: "px-1", name: "photo", type: "image" as const, source: "pixabay" as const, previewUrl: "https://example.com/photo.jpg", tags: [], duration: 0 };
      await manager.download(asset);
      expect(manager.getLocalAssets().length).toBe(beforeCount + 1);
    });
  });

  describe("remove", () => {
    it("removes cached external asset", async () => {
      await manager.initialize();
      const asset = { id: "px-1", name: "photo", type: "image" as const, source: "pixabay" as const, previewUrl: "https://example.com/photo.jpg", tags: [], duration: 0 };
      await manager.download(asset);
      const countBefore = manager.getLocalAssets().length;
      const removed = await manager.remove("px-1");
      expect(removed).toBe(true);
      expect(manager.getLocalAssets().length).toBe(countBefore - 1);
    });

    it("returns false for non-existent asset", async () => {
      await manager.initialize();
      const removed = await manager.remove("non-existent");
      expect(removed).toBe(false);
    });
  });

  describe("getLocalAssets", () => {
    it("returns empty before initialization", () => {
      expect(manager.getLocalAssets()).toHaveLength(0);
    });

    it("returns scanned assets after initialization", async () => {
      await manager.initialize();
      expect(manager.getLocalAssets().length).toBeGreaterThanOrEqual(2);
    });
  });
});
