/**
 * Director Mode — Asset Management barrel export.
 */
export { AssetManager } from "./asset-manager.js";
export { scanLocalLibrary } from "./local-library.js";
export { PixabayDownloader } from "./downloaders/pixabay-downloader.js";
export { JamendoDownloader } from "./downloaders/jamendo-downloader.js";
export { PexelsDownloader } from "./downloaders/pexels-downloader.js";
export type { AssetMetadata, AssetSearchParams, AssetSearchResult, AssetDownloadResult, AssetSource, AssetType } from "./asset-types.js";
