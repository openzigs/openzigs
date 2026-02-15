/**
 * Director Mode — Freesound API Downloader
 * Issue #238: Integration with the Freesound API for royalty-free SFX.
 * API docs: https://freesound.org/docs/api/
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

interface FreesoundResult {
  id: number;
  name: string;
  duration: number;
  tags: string[];
  license: string;
  previews?: {
    "preview-hq-mp3"?: string;
    "preview-lq-mp3"?: string;
  };
  username: string;
}

export class FreesoundDownloader {
  private readonly apiKey: string;
  private readonly baseUrl = "https://freesound.org/apiv2";
  private readonly downloadDir: string;

  constructor(apiKey: string, downloadCacheDir: string) {
    this.apiKey = apiKey;
    this.downloadDir = resolvePath(path.join(downloadCacheDir, "sfx"));
  }

  /** Check if the downloader is configured (has an API key). */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Search the Freesound API.
   */
  async search(params: AssetSearchParams): Promise<AssetMetadata[]> {
    if (!this.isConfigured()) return [];

    const url = new URL(`${this.baseUrl}/search/text/`);
    url.searchParams.set("query", params.query);
    url.searchParams.set("fields", "id,name,duration,tags,license,previews,username");
    url.searchParams.set("token", this.apiKey);
    url.searchParams.set("page_size", String(params.perPage ?? 20));
    if (params.page) url.searchParams.set("page", String(params.page));

    // Apply duration filters
    if (params.minDuration || params.maxDuration) {
      const min = params.minDuration ?? 0;
      const max = params.maxDuration ?? 999999;
      url.searchParams.set("filter", `duration:[${min} TO ${max}]`);
    }

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        logger.warn(`[Freesound] API request failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = (await response.json()) as { results?: FreesoundResult[] };
      if (!data.results) return [];

      return data.results.map((result) => this.mapToAssetMetadata(result));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Freesound] Search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Download a sound from Freesound to the local cache.
   * Stores attribution metadata alongside the audio file.
   */
  async download(previewUrl: string, assetName: string, attribution?: string): Promise<string> {
    await fs.mkdir(this.downloadDir, { recursive: true });

    const fileName = `freesound_${nanoid(8)}_${assetName.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp3`;
    const outputPath = path.join(this.downloadDir, fileName);

    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`Failed to download from Freesound: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    // Store attribution metadata alongside the audio file
    if (attribution) {
      const metadataPath = outputPath.replace(/\.mp3$/, ".attribution.txt");
      await fs.writeFile(metadataPath, attribution, "utf-8");
    }

    logger.info(`[Freesound] Downloaded: ${outputPath}`);
    return outputPath;
  }

  private mapToAssetMetadata(result: FreesoundResult): AssetMetadata {
    const previewUrl = result.previews?.["preview-hq-mp3"] ?? result.previews?.["preview-lq-mp3"];

    // Determine if attribution is required
    const requiresAttribution = result.license.toLowerCase().includes("attribution")
      || result.license.toLowerCase().includes("cc-by");

    return {
      id: `freesound_${result.id}`,
      name: result.name,
      source: "freesound",
      type: "sfx",
      filePath: "",
      duration: result.duration,
      tags: result.tags ?? [],
      license: result.license,
      attribution: requiresAttribution ? `"${result.name}" by ${result.username} (freesound.org) — ${result.license}` : undefined,
      previewUrl,
    };
  }
}
