/**
 * Director Mode — Asset Types
 * Issue #238: Shared types for the asset management subsystem.
 */

export interface AssetMetadata {
  id: string;
  name: string;
  source: "local" | "pixabay" | "freesound";
  type: "music" | "sfx";
  filePath: string;
  duration: number;           // seconds
  bpm?: number;               // for music tracks
  tags: string[];
  license: string;
  attribution?: string;       // Required for some Freesound CC-BY tracks
  previewUrl?: string;        // For streaming preview before download
}

export interface AssetSearchParams {
  query: string;
  type?: "music" | "sfx";
  source?: "local" | "pixabay" | "freesound" | "all";
  minDuration?: number;
  maxDuration?: number;
  page?: number;
  perPage?: number;
}

export interface AssetSearchResult {
  assets: AssetMetadata[];
  total: number;
  page: number;
  perPage: number;
}

export interface AssetDownloadResult {
  asset: AssetMetadata;
  filePath: string;
}
