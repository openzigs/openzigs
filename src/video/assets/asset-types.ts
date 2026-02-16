/**
 * Director Mode — Asset Types
 * Issue #238: Shared types for the asset management subsystem.
 */

export type AssetSource = "local" | "pixabay" | "jamendo" | "pexels";
export type AssetType = "music" | "sfx" | "image" | "video";

export interface AssetMetadata {
  id: string;
  name: string;
  source: AssetSource;
  type: AssetType;
  filePath: string;
  duration: number;           // seconds (0 for images)
  bpm?: number;               // for music tracks
  tags: string[];
  license: string;
  attribution?: string;       // Required for CC-BY tracks
  previewUrl?: string;        // For streaming preview / thumbnail
  thumbnailUrl?: string;      // For image/video thumbnail
  width?: number;             // For images/videos
  height?: number;            // For images/videos
}

export interface AssetSearchParams {
  query: string;
  type?: AssetType;
  source?: AssetSource | "all";
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
