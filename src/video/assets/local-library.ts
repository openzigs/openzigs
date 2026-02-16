/**
 * Director Mode — Local Asset Library
 * Issue #238: Scans local asset directories for music and SFX files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../../logging/logger.js";
import type { AssetMetadata } from "./asset-types.js";

/** Resolve ~ to home directory. */
function resolvePath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

const SUPPORTED_AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);

/**
 * Scan a directory for audio files and return AssetMetadata for each.
 */
export async function scanLocalLibrary(
  localLibraryPath: string,
  downloadCachePath: string,
): Promise<AssetMetadata[]> {
  const assets: AssetMetadata[] = [];

  // Scan shipped local assets
  const resolvedLocal = resolvePath(localLibraryPath);
  await scanDirectory(resolvedLocal, "local", assets);

  // Scan downloaded asset cache
  const resolvedCache = resolvePath(downloadCachePath);
  await scanDirectory(resolvedCache, "local", assets);

  logger.info(`[LocalLibrary] Found ${assets.length} local audio assets`);
  return assets;
}

/**
 * Recursively scan a directory tree for audio files.
 */
async function scanDirectory(
  dirPath: string,
  source: AssetMetadata["source"],
  assets: AssetMetadata[],
): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await scanDirectory(fullPath, source, assets);
      } else if (entry.isFile() && SUPPORTED_AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        // Determine type from parent directory name
        const parentDir = path.basename(path.dirname(fullPath)).toLowerCase();
        const type: AssetMetadata["type"] = parentDir === "sfx" ? "sfx" : "music";

        // Extract a human-readable name from the filename
        const name = path.basename(entry.name, path.extname(entry.name))
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());

        assets.push({
          id: nanoid(10),
          name,
          source,
          type,
          filePath: fullPath,
          duration: 0, // Duration would need ffprobe — set at runtime
          tags: [type, parentDir],
          license: "local",
        });
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable — ignore silently
  }
}
