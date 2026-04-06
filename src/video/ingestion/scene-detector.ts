/**
 * Director Mode — Scene Detector
 * Issue #237: Adaptive scene detection via ffmpeg + keyframe extraction.
 * Extracts keyframes at visual transitions with configurable thresholds,
 * plus fallback interval-based extraction for static content.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { logger } from "../../logging/logger.js";
import type { KeyframeInfo } from "./types.js";

export interface SceneDetectionOptions {
  /** Scene change threshold 0-1 (default: 0.3) */
  sceneThreshold?: number;
  /** Minimum interval between keyframes in seconds (default: 5) */
  minInterval?: number;
  /** Maximum number of keyframes per clip (default: 100) */
  maxKeyframes?: number;
}

/**
 * Extract keyframes from a video using scene detection + interval fallback.
 */
export async function extractKeyframes(
  videoPath: string,
  outputDir: string,
  options: SceneDetectionOptions = {},
): Promise<KeyframeInfo[]> {
  const { sceneThreshold = 0.3, minInterval = 5, maxKeyframes = 100 } = options;

  await fs.mkdir(outputDir, { recursive: true });

  // Phase 1: Scene-change detection via ffmpeg
  const sceneFrames = await extractSceneChangeFrames(
    videoPath,
    outputDir,
    sceneThreshold,
  );

  // Phase 2: Fallback interval extraction
  const duration = await getVideoDuration(videoPath);
  const intervalFrames = await extractIntervalFrames(
    videoPath,
    outputDir,
    minInterval,
    duration,
  );

  // Phase 3: Merge and deduplicate (within 2s window)
  const merged = mergeKeyframes(sceneFrames, intervalFrames, 2.0);

  // Limit to maxKeyframes
  return merged.slice(0, maxKeyframes);
}

/**
 * Extract frames at scene changes using ffmpeg's scene filter.
 */
async function extractSceneChangeFrames(
  videoPath: string,
  outputDir: string,
  threshold: number,
): Promise<KeyframeInfo[]> {
  const keyframes: KeyframeInfo[] = [];

  try {
    const ffmpeg = (await import("fluent-ffmpeg")).default;
    const prefix = path.join(outputDir, "scene");

    await new Promise<void>((resolve, _reject) => {
      const sceneTimestamps: number[] = [];

      ffmpeg(videoPath)
        .videoFilters(`select='gt(scene,${threshold})',showinfo`)
        .outputOptions(["-vsync", "vfr", "-frame_pts", "true"])
        .output(`${prefix}_%04d.jpg`)
        .on("stderr", (line: string) => {
          // Parse "showinfo" output for PTS timestamps
          const match = line.match(/pts_time:\s*([\d.]+)/);
          if (match) {
            sceneTimestamps.push(parseFloat(match[1]));
          }
        })
        .on("end", () => {
          // Map extracted frames to KeyframeInfo objects
          for (let i = 0; i < sceneTimestamps.length; i++) {
            const framePath = `${prefix}_${String(i + 1).padStart(4, "0")}.jpg`;
            keyframes.push({
              timestamp: sceneTimestamps[i],
              framePath,
              sceneScore: threshold, // Approximation — exact score isn't easily extractable
            });
          }
          resolve();
        })
        .on("error", (err: Error) => {
          logger.warn(`[SceneDetector] Scene detection failed: ${err.message}`);
          resolve(); // Non-fatal — we have interval fallback
        })
        .run();
    });
  } catch {
    // fluent-ffmpeg not available — skip scene detection
    logger.warn("[SceneDetector] ffmpeg not available for scene detection");
  }

  return keyframes;
}

/**
 * Extract frames at fixed intervals (fallback for static content).
 */
async function extractIntervalFrames(
  videoPath: string,
  outputDir: string,
  intervalSec: number,
  totalDuration: number,
): Promise<KeyframeInfo[]> {
  const keyframes: KeyframeInfo[] = [];

  try {
    const ffmpeg = (await import("fluent-ffmpeg")).default;
    const prefix = path.join(outputDir, "interval");

    await new Promise<void>((resolve, _reject) => {
      ffmpeg(videoPath)
        .videoFilters(`fps=1/${intervalSec}`)
        .output(`${prefix}_%04d.jpg`)
        .on("end", () => {
          // Calculate timestamps from interval
          const frameCount = Math.ceil(totalDuration / intervalSec);
          for (let i = 0; i < frameCount; i++) {
            const framePath = `${prefix}_${String(i + 1).padStart(4, "0")}.jpg`;
            keyframes.push({
              timestamp: i * intervalSec,
              framePath,
              sceneScore: 0, // Interval-based — no scene detection score
            });
          }
          resolve();
        })
        .on("error", (err: Error) => {
          logger.warn(
            `[SceneDetector] Interval extraction failed: ${err.message}`,
          );
          resolve();
        })
        .run();
    });
  } catch {
    // fluent-ffmpeg not available
    logger.warn("[SceneDetector] ffmpeg not available for interval extraction");
  }

  return keyframes;
}

/**
 * Get video duration in seconds via ffprobe.
 */
async function getVideoDuration(videoPath: string): Promise<number> {
  try {
    const ffmpeg = (await import("fluent-ffmpeg")).default;
    return new Promise<number>((resolve, _reject) => {
      ffmpeg.ffprobe(
        videoPath,
        (err: Error | null, metadata: { format?: { duration?: number } }) => {
          if (err) {
            resolve(0);
            return;
          }
          resolve(metadata?.format?.duration ?? 0);
        },
      );
    });
  } catch {
    return 0;
  }
}

/**
 * Merge scene-change and interval keyframes, deduplicating within a time window.
 */
function mergeKeyframes(
  sceneFrames: KeyframeInfo[],
  intervalFrames: KeyframeInfo[],
  dedupeWindowSec: number,
): KeyframeInfo[] {
  // Combine and sort by timestamp
  const all = [...sceneFrames, ...intervalFrames].sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  // Deduplicate: keep the one with the higher sceneScore if within the window
  const deduped: KeyframeInfo[] = [];
  for (const frame of all) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(frame.timestamp - last.timestamp) < dedupeWindowSec) {
      // Keep the one with higher scene score
      if (frame.sceneScore > last.sceneScore) {
        deduped[deduped.length - 1] = frame;
      }
    } else {
      deduped.push(frame);
    }
  }

  return deduped;
}

export { getVideoDuration };
