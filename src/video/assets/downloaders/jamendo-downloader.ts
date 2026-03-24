/**
 * Director Mode — Jamendo Music API Downloader
 * Issue #238: Integration with the Jamendo API for Creative Commons music.
 * API docs: https://developer.jamendo.com/v3.0
 *
 * Replaces the Freesound integration — Jamendo has a simpler API,
 * instant client_id registration, and a large CC-licensed music catalog.
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

interface JamendoTrack {
  id: string;
  name: string;
  duration: number;
  artist_name: string;
  audio: string;          // Full-length streaming URL
  audiodownload: string;  // Downloadable URL
  image: string;          // Album art
  license_ccurl: string;  // CC license URL
  musicinfo?: {
    tags?: { genres: string[]; instruments: string[]; vartags: string[] };
    speed?: string;
    lang?: string;
  };
}

export class JamendoDownloader {
  private readonly clientId: string;
  private readonly baseUrl = "https://api.jamendo.com/v3.0";
  private readonly downloadDir: string;

  constructor(clientId: string, downloadCacheDir: string) {
    this.clientId = clientId;
    this.downloadDir = resolvePath(path.join(downloadCacheDir, "music"));
  }

  /** Check if the downloader is configured (has a client ID). */
  isConfigured(): boolean {
    return this.clientId.length > 0;
  }

  /**
   * Search the Jamendo Music API.
   */
  async search(params: AssetSearchParams): Promise<AssetMetadata[]> {
    if (!this.isConfigured()) return [];

    const url = new URL(`${this.baseUrl}/tracks/`);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("format", "json");
    url.searchParams.set("search", params.query);
    url.searchParams.set("limit", String(params.perPage ?? 20));
    url.searchParams.set("include", "musicinfo");
    url.searchParams.set("audioformat", "mp32");

    if (params.page && params.page > 1) {
      url.searchParams.set("offset", String((params.page - 1) * (params.perPage ?? 20)));
    }

    // Duration filters (Jamendo uses "between" syntax)
    if (params.minDuration || params.maxDuration) {
      const min = params.minDuration ?? 0;
      const max = params.maxDuration ?? 9999;
      url.searchParams.set("durationbetween", `${min}_${max}`);
    }

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        logger.warn(`[Jamendo] API request failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = (await response.json()) as { results?: JamendoTrack[] };
      if (!data.results) return [];

      return data.results.map((track) => this.mapToAssetMetadata(track));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Jamendo] Search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Download a track from Jamendo to the local cache.
   * Stores attribution metadata alongside the audio file.
   */
  async download(previewUrl: string, assetName: string, attribution?: string): Promise<string> {
    // SSRF protection: validate download URL is from expected Jamendo CDN
    const parsed = new URL(previewUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Invalid protocol for Jamendo download: ${parsed.protocol}`);
    }
    if (!parsed.hostname.endsWith(".jamendo.com") && !parsed.hostname.endsWith("cdn.jamendo.com")) {
      throw new Error(`Unexpected download domain: ${parsed.hostname}`);
    }

    await fs.mkdir(this.downloadDir, { recursive: true });

    const fileName = `jamendo_${nanoid(8)}_${assetName.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp3`;
    const outputPath = path.join(this.downloadDir, fileName);

    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`Failed to download from Jamendo: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    // Store attribution metadata alongside the audio file (CC requires it)
    if (attribution) {
      const metadataPath = outputPath.replace(/\.mp3$/, ".attribution.txt");
      await fs.writeFile(metadataPath, attribution, "utf-8");
    }

    logger.info(`[Jamendo] Downloaded: ${outputPath}`);
    return outputPath;
  }

  private mapToAssetMetadata(track: JamendoTrack): AssetMetadata {
    // Build tags from musicinfo
    const tags: string[] = [];
    if (track.musicinfo?.tags) {
      tags.push(...(track.musicinfo.tags.genres ?? []));
      tags.push(...(track.musicinfo.tags.vartags ?? []));
    }

    // Determine license label from CC URL
    const licenseLabel = track.license_ccurl
      ? this.parseCCLicense(track.license_ccurl)
      : "Creative Commons";

    return {
      id: `jamendo_${track.id}`,
      name: track.name,
      source: "jamendo",
      type: "music",
      filePath: "",
      duration: track.duration,
      tags: tags.slice(0, 6),
      license: licenseLabel,
      attribution: `"${track.name}" by ${track.artist_name} (Jamendo) — ${licenseLabel}`,
      previewUrl: track.audio,
    };
  }

  private parseCCLicense(url: string): string {
    if (url.includes("by-sa")) return "CC BY-SA";
    if (url.includes("by-nc-sa")) return "CC BY-NC-SA";
    if (url.includes("by-nc-nd")) return "CC BY-NC-ND";
    if (url.includes("by-nc")) return "CC BY-NC";
    if (url.includes("by-nd")) return "CC BY-ND";
    if (url.includes("by")) return "CC BY";
    if (url.includes("publicdomain") || url.includes("zero")) return "CC0 / Public Domain";
    return "Creative Commons";
  }
}
