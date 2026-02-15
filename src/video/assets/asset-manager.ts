/**
 * Director Mode — Asset Manager (Central Registry)
 * Issue #238: Unified search across local library, Pixabay, and Freesound.
 */

import { logger } from "../../logging/logger.js";
import type { AssetMetadata, AssetSearchParams, AssetSearchResult, AssetDownloadResult } from "./asset-types.js";
import { scanLocalLibrary } from "./local-library.js";
import { PixabayDownloader } from "./downloaders/pixabay-downloader.js";
import { FreesoundDownloader } from "./downloaders/freesound-downloader.js";

export interface AssetManagerConfig {
  localLibraryPath: string;
  downloadCachePath: string;
  pixabay: { enabled: boolean; apiKey: string };
  freesound: { enabled: boolean; apiKey: string };
}

export class AssetManager {
  private readonly config: AssetManagerConfig;
  private readonly pixabay: PixabayDownloader;
  private readonly freesound: FreesoundDownloader;
  private localAssets: AssetMetadata[] = [];
  private initialized = false;

  constructor(config: AssetManagerConfig) {
    this.config = config;
    this.pixabay = new PixabayDownloader(
      config.pixabay.enabled ? config.pixabay.apiKey : "",
      config.downloadCachePath,
    );
    this.freesound = new FreesoundDownloader(
      config.freesound.enabled ? config.freesound.apiKey : "",
      config.downloadCachePath,
    );
  }

  /**
   * Initialize: scan local library for available assets.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.localAssets = await scanLocalLibrary(
      this.config.localLibraryPath,
      this.config.downloadCachePath,
    );
    this.initialized = true;
    logger.info(`[AssetManager] Initialized with ${this.localAssets.length} local assets`);
  }

  /**
   * Search for assets across all configured sources.
   */
  async search(params: AssetSearchParams): Promise<AssetSearchResult> {
    if (!this.initialized) await this.initialize();

    const source = params.source ?? "all";
    const perPage = params.perPage ?? 20;
    const page = params.page ?? 1;
    const allResults: AssetMetadata[] = [];

    // Search local library (always available)
    if (source === "all" || source === "local") {
      const localResults = this.searchLocal(params);
      allResults.push(...localResults);
    }

    // Search Pixabay (if enabled and requested)
    if ((source === "all" || source === "pixabay") && this.pixabay.isConfigured()) {
      const pixabayResults = await this.pixabay.search(params);
      allResults.push(...pixabayResults);
    }

    // Search Freesound (if enabled and requested)
    if ((source === "all" || source === "freesound") && this.freesound.isConfigured()) {
      const freesoundResults = await this.freesound.search(params);
      allResults.push(...freesoundResults);
    }

    // Apply type filter
    const filtered = params.type
      ? allResults.filter((a) => a.type === params.type)
      : allResults;

    // Paginate
    const start = (page - 1) * perPage;
    const paged = filtered.slice(start, start + perPage);

    return {
      assets: paged,
      total: filtered.length,
      page,
      perPage,
    };
  }

  /**
   * Get all local assets.
   */
  getLocalAssets(): AssetMetadata[] {
    return this.localAssets;
  }

  /**
   * Download an asset from an external source to the local cache.
   */
  async download(asset: AssetMetadata): Promise<AssetDownloadResult> {
    if (!asset.previewUrl) {
      throw new Error(`Asset ${asset.id} has no download URL`);
    }

    let filePath: string;

    if (asset.source === "pixabay") {
      filePath = await this.pixabay.download(asset.previewUrl, asset.name);
    } else if (asset.source === "freesound") {
      filePath = await this.freesound.download(asset.previewUrl, asset.name, asset.attribution);
    } else {
      throw new Error(`Cannot download local asset ${asset.id} — it's already on disk`);
    }

    // Update the asset with the local file path
    const downloadedAsset = { ...asset, filePath };

    // Add to local assets cache
    this.localAssets.push(downloadedAsset);

    return { asset: downloadedAsset, filePath };
  }

  /**
   * Remove a downloaded asset from the cache.
   */
  async remove(assetId: string): Promise<boolean> {
    const index = this.localAssets.findIndex((a) => a.id === assetId);
    if (index >= 0) {
      const asset = this.localAssets[index];
      if (asset.filePath && asset.source !== "local") {
        const fs = await import("node:fs/promises");
        await fs.unlink(asset.filePath).catch(() => {});
      }
      this.localAssets.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Search the local library by query string.
   */
  private searchLocal(params: AssetSearchParams): AssetMetadata[] {
    const query = params.query.toLowerCase();
    return this.localAssets.filter((asset) => {
      const matchesQuery =
        asset.name.toLowerCase().includes(query) ||
        asset.tags.some((t) => t.toLowerCase().includes(query));

      const matchesDuration =
        (!params.minDuration || asset.duration >= params.minDuration) &&
        (!params.maxDuration || asset.duration <= params.maxDuration);

      return matchesQuery && matchesDuration;
    });
  }
}
