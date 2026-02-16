/**
 * Director Mode — Media Path Resolver
 * Issue #245: Resolves relative media paths to absolute file:// URLs
 * that Remotion can consume during SSR rendering.
 */

import path from "node:path";
import os from "node:os";

/**
 * Resolve a media path to an absolute path that Remotion can access.
 *
 * Handles:
 * - Already absolute paths: returned as-is
 * - Tilde (~) paths: expanded to home directory
 * - Relative paths: resolved against the outputDir
 * - URLs (http/https): returned as-is
 *
 * @param mediaPath - The source path from the manifest
 * @param baseDir - The base directory for resolving relative paths
 * @returns Absolute file path or URL
 */
export function resolveMediaPath(mediaPath: string, baseDir: string): string {
  // Already a URL — pass through
  if (mediaPath.startsWith("http://") || mediaPath.startsWith("https://")) {
    return mediaPath;
  }

  // file:// URL — strip the prefix and resolve
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
