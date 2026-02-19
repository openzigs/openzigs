/**
 * Presenter Mode — Thumbnail Generator
 * Issue #276 (SI-1): Extract a frame from a video via ffmpeg for catalog thumbnails.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { logger } from "../logging/logger.js";

const execFileAsync = promisify(execFile);

const THUMBNAIL_DIR = path.join(os.homedir(), ".openzigs", "video-output", "thumbnails");

/**
 * Generate a thumbnail for a video by extracting a single frame at 25% duration.
 * Returns the absolute path to the generated JPEG, or null on failure.
 */
export async function generateThumbnail(
  videoPath: string,
  presentationId: string,
  durationSeconds: number,
): Promise<string | null> {
  try {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

    const seekTime = Math.max(0, durationSeconds * 0.25);
    const outputPath = path.join(THUMBNAIL_DIR, `${presentationId}.jpg`);

    await execFileAsync(
      "ffmpeg",
      [
        "-ss", seekTime.toFixed(2),
        "-i", videoPath,
        "-vframes", "1",
        "-q:v", "2",
        outputPath,
        "-y",
      ],
      { timeout: 30_000 },
    );

    if (fs.existsSync(outputPath)) {
      return outputPath;
    }

    logger.warn(`[ThumbnailGenerator] ffmpeg succeeded but output not found: ${outputPath}`);
    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[ThumbnailGenerator] Failed to generate thumbnail: ${msg}`);
    return null;
  }
}
