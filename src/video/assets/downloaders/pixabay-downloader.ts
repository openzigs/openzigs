/**
 * Director Mode — Pixabay Music API Downloader
 * Issue #238: Integration with the Pixabay Music API for royalty-free tracks.
 * API docs: https://pixabay.com/api/docs/#api_search_music
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

interface PixabayHit {
  id: number;
  title: string;
  tags: string;
  duration: number;
  audio_url?: string;
  user: string;
}

export class PixabayDownloader {
  private readonly apiKey: string;
  private readonly baseUrl = "https://pixabay.com/api/music/";
  private readonly downloadDir: string;

  constructor(apiKey: string, downloadCacheDir: string) {
    this.apiKey = apiKey;
    this.downloadDir = resolvePath(path.join(downloadCacheDir, "music"));
  }

  /** Check if the downloader is configured (has an API key). */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Search the Pixabay Music API.
   */
  async search(params: AssetSearchParams): Promise<AssetMetadata[]> {
    if (!this.isConfigured()) return [];

    const url = new URL(this.baseUrl);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("q", params.query);
    url.searchParams.set("per_page", String(params.perPage ?? 20));
    if (params.page) url.searchParams.set("page", String(params.page));

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        logger.warn(`[Pixabay] API request failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = (await response.json()) as { hits?: PixabayHit[] };
      if (!data.hits) return [];

      return data.hits
        .filter((hit) => {
          // Apply duration filters
          if (params.minDuration && hit.duration < params.minDuration) return false;
          if (params.maxDuration && hit.duration > params.maxDuration) return false;
          return true;
        })
        .map((hit) => this.mapToAssetMetadata(hit));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Pixabay] Search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Download a track from Pixabay to the local cache.
   */
  async download(previewUrl: string, assetName: string): Promise<string> {
    // SSRF protection: validate download URL is from expected Pixabay CDN
    const parsed = new URL(previewUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Invalid protocol for Pixabay download: ${parsed.protocol}`);
    }
    if (!parsed.hostname.endsWith(".pixabay.com") && parsed.hostname !== "pixabay.com") {
      throw new Error(`Unexpected download domain: ${parsed.hostname}`);
    }

    await fs.mkdir(this.downloadDir, { recursive: true });

    const fileName = `pixabay_${nanoid(8)}_${assetName.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp3`;
    const outputPath = path.join(this.downloadDir, fileName);

    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`Failed to download from Pixabay: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    logger.info(`[Pixabay] Downloaded: ${outputPath}`);
    return outputPath;
  }

  private mapToAssetMetadata(hit: PixabayHit): AssetMetadata {
    return {
      id: `pixabay_${hit.id}`,
      name: hit.title || `Pixabay Track ${hit.id}`,
      source: "pixabay",
      type: "music",
      filePath: "",
      duration: hit.duration,
      tags: hit.tags ? hit.tags.split(",").map((t) => t.trim()) : [],
      license: "Pixabay License (royalty-free)",
      previewUrl: hit.audio_url,
    };
  }
}
