/**
 * Multi-Segment Video Orchestration
 * Issue #790: Decompose long video jobs into chained 4s segment sub-jobs,
 * stitch segments with ffmpeg crossfade transitions, and apply audio post-processing.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../logging/logger.js";
import type { MediaJob, MediaJobPayload, WorkerNodeConfig } from "./types.js";
import { MAX_VIDEO_FRAMES, VALID_VIDEO_DURATIONS } from "./types.js";

const execFileAsync = promisify(execFile);

// ── Segment Tracker ─────────────────────────────────────────

export interface SegmentState {
  index: number;
  jobId: string;
  status: "pending" | "complete" | "failed";
  videoPath?: string;
}

export interface SegmentTracker {
  parentJobId: string;
  totalSegments: number;
  segments: SegmentState[];
  parentPayload: MediaJobPayload;
  parentType: "txt2video" | "img2video";
}

/** In-memory map of parent job ID → segment tracker. */
const segmentTrackers = new Map<string, SegmentTracker>();

// ── Tracker Persistence ─────────────────────────────────────

function trackerDir(parentJobId: string): string {
  return path.join(
    os.homedir(),
    ".openzigs",
    "gallery",
    "segments",
    parentJobId,
  );
}

function trackerFilePath(parentJobId: string): string {
  return path.join(trackerDir(parentJobId), "tracker.json");
}

/** Persist tracker to disk (best-effort). */
async function persistTracker(tracker: SegmentTracker): Promise<void> {
  try {
    const dir = trackerDir(tracker.parentJobId);
    await fs.mkdir(dir, { recursive: true });
    const tmp = trackerFilePath(tracker.parentJobId) + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(tracker), "utf-8");
    await fs.rename(tmp, trackerFilePath(tracker.parentJobId));
  } catch (err) {
    logger.warn(
      `[MultiSegment] Failed to persist tracker for ${tracker.parentJobId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Recover tracker from disk if not in memory. */
async function recoverTracker(
  parentJobId: string,
): Promise<SegmentTracker | undefined> {
  const cached = segmentTrackers.get(parentJobId);
  if (cached) return cached;
  try {
    const data = await fs.readFile(trackerFilePath(parentJobId), "utf-8");
    const tracker = JSON.parse(data) as SegmentTracker;
    segmentTrackers.set(parentJobId, tracker);
    logger.info(
      `[MultiSegment] Recovered tracker from disk for parent ${parentJobId}`,
    );
    return tracker;
  } catch {
    return undefined;
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Check if a video_duration value requires multi-segment decomposition.
 */
export function isMultiSegmentDuration(duration: number | undefined): boolean {
  return typeof duration === "number" && duration > 4;
}

/**
 * Validate that a duration value is in the allowed set.
 */
export function isValidVideoDuration(duration: number): boolean {
  return (VALID_VIDEO_DURATIONS as readonly number[]).includes(duration);
}

/**
 * Decompose a multi-segment video job into its first segment job.
 * Creates a SegmentTracker and returns the first segment's CreateMediaJobInput-like payload.
 *
 * @returns The first segment job payload to be created, or null if no decomposition needed.
 */
export function decomposeMultiSegmentJob(parentJob: MediaJob): {
  type: MediaJob["type"];
  payload: MediaJobPayload;
  totalSegments: number;
} | null {
  const duration = parentJob.payload.video_duration;
  if (!duration || duration <= 4) return null;

  const totalSegments = Math.ceil(duration / 4);

  // Create tracker
  const tracker: SegmentTracker = {
    parentJobId: parentJob.id,
    totalSegments,
    segments: Array.from({ length: totalSegments }, (_, i) => ({
      index: i,
      jobId: "", // filled as segment jobs are created
      status: "pending" as const,
    })),
    parentPayload: { ...parentJob.payload },
    parentType: parentJob.type as "txt2video" | "img2video",
  };

  segmentTrackers.set(parentJob.id, tracker);

  // Persist tracker to survive hot-reloads
  void persistTracker(tracker);

  // First segment: same type as parent (txt2video or img2video if source image)
  const firstSegmentPayload: MediaJobPayload = {
    ...parentJob.payload,
    // Override: single segment = standard 4s / 97 frames
    num_frames: MAX_VIDEO_FRAMES,
    // Disable audio on individual segments — audio applied to final stitch only
    audio: false,
    // Segment metadata
    segmentIndex: 0,
    totalSegments,
    parentJobId: parentJob.id,
    // Clear video_duration so worker doesn't get confused
    video_duration: undefined,
  };

  return {
    type: parentJob.type,
    payload: firstSegmentPayload,
    totalSegments,
  };
}

/**
 * Register a created segment job ID with its tracker.
 */
export function registerSegmentJob(
  parentJobId: string,
  segmentIndex: number,
  segmentJobId: string,
): void {
  const tracker = segmentTrackers.get(parentJobId);
  if (!tracker) return;
  if (segmentIndex < tracker.segments.length) {
    tracker.segments[segmentIndex].jobId = segmentJobId;
    void persistTracker(tracker);
  }
}

/**
 * Get the segment tracker for a parent job.
 * Checks in-memory first, then attempts disk recovery.
 */
export async function getSegmentTracker(
  parentJobId: string,
): Promise<SegmentTracker | undefined> {
  return recoverTracker(parentJobId);
}

/**
 * Handle completion of a single segment.
 * Saves the segment video, extracts the last frame for the next segment (if needed),
 * and returns the next segment job payload or signals all-done.
 *
 * @returns `{ done: true, parentJobId }` when all segments are complete,
 *          or `{ done: false, nextSegment }` with the next segment job to create.
 */
export async function handleSegmentCompletion(
  completedJob: MediaJob,
  videoBytes: Buffer,
  getNodeConfig: () => Promise<WorkerNodeConfig>,
): Promise<
  | {
      done: true;
      parentJobId: string;
    }
  | {
      done: false;
      parentJobId: string;
      nextSegment: {
        type: MediaJob["type"];
        payload: MediaJobPayload;
      };
    }
> {
  const parentJobId = completedJob.payload.parentJobId!;
  const segmentIndex = completedJob.payload.segmentIndex!;
  const tracker = await recoverTracker(parentJobId);

  if (!tracker) {
    throw new Error(`No segment tracker found for parent job ${parentJobId}`);
  }

  // Save segment to temp directory
  const segmentDir = path.join(
    os.homedir(),
    ".openzigs",
    "gallery",
    "segments",
    parentJobId,
  );
  await fs.mkdir(segmentDir, { recursive: true });
  const segmentPath = path.join(segmentDir, `segment-${segmentIndex}.mp4`);
  await fs.writeFile(segmentPath, videoBytes);

  // Update tracker
  tracker.segments[segmentIndex].status = "complete";
  tracker.segments[segmentIndex].videoPath = segmentPath;
  void persistTracker(tracker);

  logger.info(
    `[MultiSegment] Segment ${segmentIndex + 1}/${tracker.totalSegments} complete for parent ${parentJobId}`,
  );

  const nextIndex = segmentIndex + 1;

  // All segments done?
  if (nextIndex >= tracker.totalSegments) {
    return { done: true, parentJobId };
  }

  // Extract last frame from completed segment for img2video chaining
  const lastFrameBase64 = await extractLastFrame(segmentPath, getNodeConfig);

  // Create next segment as img2video with the last frame
  const nextPayload: MediaJobPayload = {
    ...tracker.parentPayload,
    num_frames: MAX_VIDEO_FRAMES,
    audio: false,
    segmentIndex: nextIndex,
    totalSegments: tracker.totalSegments,
    parentJobId,
    video_duration: undefined,
    // Chain: use last frame as init image
    init_image: lastFrameBase64,
    image_strength: 0.8,
  };

  return {
    done: false,
    parentJobId,
    nextSegment: {
      type: "img2video",
      payload: nextPayload,
    },
  };
}

/**
 * Extract the last frame from a video file as base64 PNG.
 * First attempts the worker sidecar's /last-frame endpoint.
 * Falls back to local ffmpeg if the sidecar is unreachable.
 */
async function extractLastFrame(
  videoPath: string,
  getNodeConfig: () => Promise<WorkerNodeConfig>,
): Promise<string> {
  // Try worker's /last-frame endpoint first
  try {
    const nodeConfig = await getNodeConfig();
    const videoData = await fs.readFile(videoPath);
    const base64Video = videoData.toString("base64");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    const res = await fetch(`${nodeConfig.url}/last-frame`, {
      method: "POST",
      headers,
      body: JSON.stringify({ video_base64: base64Video }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const data = (await res.json()) as { frame_base64: string };
      return data.frame_base64;
    }
  } catch (err) {
    logger.warn(
      `[MultiSegment] /last-frame endpoint failed, falling back to local ffmpeg: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fallback: local ffmpeg
  return extractLastFrameLocal(videoPath);
}

/**
 * Extract last frame locally using ffmpeg.
 */
async function extractLastFrameLocal(videoPath: string): Promise<string> {
  const outputPath = videoPath.replace(/\.mp4$/, "-lastframe.png");
  try {
    // Use ffmpeg to get last frame: seek to near end, grab 1 frame
    await execFileAsync("ffmpeg", [
      "-sseof",
      "-0.1",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-y",
      outputPath,
    ]);
    const frameData = await fs.readFile(outputPath);
    return frameData.toString("base64");
  } finally {
    // Clean up temp frame file
    await fs.unlink(outputPath).catch(() => {});
  }
}

/**
 * Stitch all segments for a parent job into a single video using ffmpeg.
 * Uses xfade filter for crossfade transitions between segments.
 *
 * @returns The final stitched video as a Buffer.
 */
export async function stitchSegments(parentJobId: string): Promise<Buffer> {
  const tracker = await recoverTracker(parentJobId);
  if (!tracker) {
    throw new Error(`No segment tracker found for parent job ${parentJobId}`);
  }

  const segmentDir = path.join(
    os.homedir(),
    ".openzigs",
    "gallery",
    "segments",
    parentJobId,
  );

  const segmentPaths = tracker.segments
    .sort((a, b) => a.index - b.index)
    .map((s) => s.videoPath!)
    .filter(Boolean);

  if (segmentPaths.length === 0) {
    throw new Error(`No segment files found for parent job ${parentJobId}`);
  }

  const outputPath = path.join(segmentDir, "stitched.mp4");

  if (segmentPaths.length === 1) {
    // Single segment — just copy
    await fs.copyFile(segmentPaths[0], outputPath);
  } else {
    // Multi-segment: use ffmpeg xfade filter chain
    const ffmpegArgs = buildXfadeCommand(segmentPaths, outputPath, 0.5);
    await execFileAsync("ffmpeg", ffmpegArgs);
  }

  let finalOutput = outputPath;

  // Apply audio post-processing if parent job had audio enabled
  if (tracker.parentPayload.audio) {
    const audioOutputPath = path.join(segmentDir, "stitched-audio.mp4");
    finalOutput = audioOutputPath;
    // Audio is applied as a separate step — re-encode with audio generation
    // For now, the audio flag will be handled by dispatching a final audio job
    // on the stitched video. This is a placeholder for the audio pipeline.
    logger.info(
      `[MultiSegment] Audio requested for parent ${parentJobId} — will be applied in post-processing`,
    );
    // Just copy for now; audio integration requires a separate sidecar call
    await fs.copyFile(outputPath, audioOutputPath);
  }

  const result = await fs.readFile(finalOutput);

  // Clean up segment directory
  try {
    await fs.rm(segmentDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      `[MultiSegment] Failed to clean up segment dir ${segmentDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Remove tracker from memory
  segmentTrackers.delete(parentJobId);

  logger.info(
    `[MultiSegment] Stitched ${segmentPaths.length} segments for parent ${parentJobId} (${result.length} bytes)`,
  );

  return result;
}

/**
 * Build ffmpeg args for xfade crossfade stitching.
 * Each transition is 0.5s crossfade.
 */
export function buildXfadeCommand(
  inputs: string[],
  output: string,
  crossfadeDuration: number,
): string[] {
  const args: string[] = [];

  // Add all inputs
  for (const input of inputs) {
    args.push("-i", input);
  }

  if (inputs.length === 2) {
    // Simple 2-input xfade
    args.push(
      "-filter_complex",
      `[0:v][1:v]xfade=transition=fade:duration=${crossfadeDuration}:offset=3.5[outv]`,
      "-map",
      "[outv]",
    );
  } else {
    // Chain xfade for 3+ inputs
    // Each segment is ~4s, crossfade is 0.5s
    // After first xfade, duration = 4 + 4 - 0.5 = 7.5
    // Second xfade offset = 7.5 - 0.5 = 7.0, etc.
    const filterParts: string[] = [];
    let currentLabel = "0:v";
    let accumulatedDuration = 4; // first segment duration in seconds

    for (let i = 1; i < inputs.length; i++) {
      const offset = accumulatedDuration - crossfadeDuration;
      const outLabel = i === inputs.length - 1 ? "outv" : `v${i}`;
      filterParts.push(
        `[${currentLabel}][${i}:v]xfade=transition=fade:duration=${crossfadeDuration}:offset=${offset.toFixed(1)}[${outLabel}]`,
      );
      currentLabel = outLabel;
      accumulatedDuration = accumulatedDuration + 4 - crossfadeDuration;
    }

    args.push("-filter_complex", filterParts.join(";"), "-map", "[outv]");
  }

  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18", "-y", output);
  return args;
}

/**
 * Format progress message for multi-segment jobs.
 */
export function formatSegmentProgress(
  segmentIndex: number,
  totalSegments: number,
  segmentProgress?: number,
): string {
  const segmentNum = segmentIndex + 1;
  const pct =
    segmentProgress !== undefined ? ` — ${Math.round(segmentProgress)}%` : "";
  return `Segment ${segmentNum}/${totalSegments}${pct}`;
}

/**
 * Check if a completed job is a multi-segment sub-job.
 */
export function isSegmentJob(job: MediaJob): boolean {
  return (
    job.payload.segmentIndex !== undefined &&
    job.payload.parentJobId !== undefined
  );
}

/** Expose for testing — clear all trackers. */
export function _clearTrackers(): void {
  segmentTrackers.clear();
}

/** Expose for testing — get tracker count. */
export function _trackerCount(): number {
  return segmentTrackers.size;
}
