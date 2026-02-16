/**
 * Director Mode — Media Path Resolver
 * Issue #245: Resolves relative media paths to absolute filesystem paths
 * and stages local files into the Remotion bundle for SSR rendering.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Resolve a media path to an absolute filesystem path.
 *
 * Handles:
 * - URLs (http/https): returned as-is (remote media)
 * - file:// URLs: converted to absolute path
 * - Tilde (~) paths: expanded to home directory
 * - Absolute paths: returned as-is
 * - Relative paths: resolved against the baseDir
 *
 * @param mediaPath - The source path from the manifest
 * @param baseDir - The base directory for resolving relative paths
 * @returns Absolute file path or remote URL
 */
export function resolveMediaPath(mediaPath: string, baseDir: string): string {
  // Already a remote URL — pass through
  if (mediaPath.startsWith("http://") || mediaPath.startsWith("https://")) {
    return mediaPath;
  }

  // file:// URL — strip the prefix
  if (mediaPath.startsWith("file://")) {
    return mediaPath.slice(7);
  }

  // Expand tilde
  if (mediaPath.startsWith("~")) {
    return path.join(os.homedir(), mediaPath.slice(1));
  }

  // Already absolute
  if (path.isAbsolute(mediaPath)) {
    return mediaPath;
  }

  // Relative — resolve against baseDir
  return path.resolve(baseDir, mediaPath);
}

/**
 * Stage a local media file into the Remotion bundle directory.
 *
 * Remotion's SSR renderer serves the webpack bundle via a local HTTP server.
 * Local filesystem paths can't be loaded by the headless browser as video src.
 * This function symlinks (or copies) a local file into the bundle directory
 * and returns a root-relative path that the bundle's HTTP server can serve.
 *
 * Remote URLs (http/https) are returned unchanged.
 *
 * @param resolvedPath - Absolute file path or remote URL
 * @param bundleDir - The Remotion bundle serve directory
 * @returns A path usable as a video/audio src within the Remotion bundle
 */
export function stageMediaFile(resolvedPath: string, bundleDir: string): string | null {
  // Remote URLs don't need staging
  if (resolvedPath.startsWith("http://") || resolvedPath.startsWith("https://")) {
    return resolvedPath;
  }

  // If the source file doesn't exist, return null.
  // The LLM may generate references to music tracks or other media that
  // don't actually exist on disk — this is expected and non-fatal.
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const basename = path.basename(resolvedPath);
  // Use a content-addressable prefix to avoid name collisions
  const hash = simpleHash(resolvedPath);
  const stagedName = `media-${hash}-${basename}`;
  const stagedPath = path.join(bundleDir, stagedName);

  // Stage the file if not already present (hard link > copy for speed)
  if (!fs.existsSync(stagedPath)) {
    try {
      fs.linkSync(resolvedPath, stagedPath);
    } catch {
      // Fallback to copy if hard link fails (e.g., cross-device)
      fs.copyFileSync(resolvedPath, stagedPath);
    }
  }

  // Return root-relative path for the bundle's HTTP server
  return `/${stagedName}`;
}

/** Simple string hash for generating collision-resistant filenames. */
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
