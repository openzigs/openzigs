/**
 * Director Mode — Pexels API Downloader
 * Issue #238: Integration with the Pexels API for royalty-free images & videos.
 * API docs: https://www.pexels.com/api/documentation/
 *
 * Pexels has instant API key approval (no gating), a generous rate limit
 * (200 req/hr), and a large library of free stock photos and videos.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../../../logging/logger.js";
import type { AssetMetadata, AssetSearchParams } from "../asset-types.js";

function resolvePath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  duration: number;
  user: { name: string; url: string };
  image: string;  // thumbnail
  video_files: Array<{
    id: number;
    quality: string;
    file_type: string;
    width: number;
    height: number;
    link: string;
  }>;
}

export class PexelsDownloader {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.pexels.com";
  private readonly downloadDir: string;

  constructor(apiKey: string, downloadCacheDir: string) {
    this.apiKey = apiKey;
    this.downloadDir = resolvePath(path.join(downloadCacheDir, "images"));
  }

  /** Check if the downloader is configured (has an API key). */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Search the Pexels Photos API.
   */
  async searchPhotos(params: AssetSearchParams): Promise<AssetMetadata[]> {
    if (!this.isConfigured()) return [];

    const url = new URL(`${this.baseUrl}/v1/search`);
    url.searchParams.set("query", params.query);
    url.searchParams.set("per_page", String(params.perPage ?? 20));
    if (params.page) url.searchParams.set("page", String(params.page));

    try {
      const response = await fetch(url.toString(), {
        headers: { Authorization: this.apiKey },
      });
      if (!response.ok) {
        logger.warn(`[Pexels] Photos API request failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = (await response.json()) as { photos?: PexelsPhoto[] };
      if (!data.photos) return [];

      return data.photos.map((photo) => this.mapPhotoToAsset(photo));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Pexels] Photos search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Search the Pexels Videos API.
   */
  async searchVideos(params: AssetSearchParams): Promise<AssetMetadata[]> {
    if (!this.isConfigured()) return [];

    const url = new URL(`${this.baseUrl}/videos/search`);
    url.searchParams.set("query", params.query);
    url.searchParams.set("per_page", String(params.perPage ?? 20));
    if (params.page) url.searchParams.set("page", String(params.page));

    // Pexels supports min/max duration for videos
    if (params.minDuration) url.searchParams.set("min_duration", String(params.minDuration));
    if (params.maxDuration) url.searchParams.set("max_duration", String(params.maxDuration));

    try {
      const response = await fetch(url.toString(), {
        headers: { Authorization: this.apiKey },
      });
      if (!response.ok) {
        logger.warn(`[Pexels] Videos API request failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = (await response.json()) as { videos?: PexelsVideo[] };
      if (!data.videos) return [];

      return data.videos.map((video) => this.mapVideoToAsset(video));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Pexels] Videos search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Unified search — returns images and/or videos based on the type filter.
   */
  async search(params: AssetSearchParams): Promise<AssetMetadata[]> {
    if (!this.isConfigured()) return [];

    const results: AssetMetadata[] = [];

    if (!params.type || params.type === "image") {
      const photos = await this.searchPhotos(params);
      results.push(...photos);
    }

    if (!params.type || params.type === "video") {
      const videos = await this.searchVideos(params);
      results.push(...videos);
    }

    return results;
  }

  /**
   * Download a photo from Pexels to the local cache.
   */
  async download(downloadUrl: string, assetName: string): Promise<string> {
    await fs.mkdir(this.downloadDir, { recursive: true });

    const ext = downloadUrl.includes(".mp4") ? "mp4" : "jpg";
    const fileName = `pexels_${nanoid(8)}_${assetName.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`;
    const outputPath = path.join(this.downloadDir, fileName);

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download from Pexels: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    logger.info(`[Pexels] Downloaded: ${outputPath}`);
    return outputPath;
  }

  private mapPhotoToAsset(photo: PexelsPhoto): AssetMetadata {
    return {
      id: `pexels_photo_${photo.id}`,
      name: photo.alt || `Pexels Photo ${photo.id}`,
      source: "pexels",
      type: "image",
      filePath: "",
      duration: 0,
      width: photo.width,
      height: photo.height,
      tags: photo.alt ? photo.alt.split(" ").slice(0, 5) : [],
      license: "Pexels License (free for all uses)",
      attribution: `Photo by ${photo.photographer} on Pexels`,
      previewUrl: photo.src.large,
      thumbnailUrl: photo.src.small,
    };
  }

  private mapVideoToAsset(video: PexelsVideo): AssetMetadata {
    // Pick highest quality mp4
    const bestFile = video.video_files
      .filter((f) => f.file_type === "video/mp4")
      .sort((a, b) => b.width - a.width)[0];

    return {
      id: `pexels_video_${video.id}`,
      name: `Pexels Video ${video.id}`,
      source: "pexels",
      type: "video",
      filePath: "",
      duration: video.duration,
      width: video.width,
      height: video.height,
      tags: [],
      license: "Pexels License (free for all uses)",
      attribution: `Video by ${video.user.name} on Pexels`,
      previewUrl: bestFile?.link ?? "",
      thumbnailUrl: video.image,
    };
  }
}
