/**
 * Director Mode — Ingestion Orchestrator
 * Issue #237: Coordinates the full media ingestion pipeline.
 * Input: raw video file paths → Output: structured ContextPayload.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { logger } from "../../logging/logger.js";
import { extractAudio } from "./audio-extractor.js";
import { extractKeyframes } from "./scene-detector.js";
import { transcribe } from "./transcriber.js";
import { assembleContext } from "./context-assembler.js";
import type { IngestionInput, IngestionResult, ClipAnalysis } from "./types.js";

export interface IngestionOptions {
  /** Scene change threshold for keyframe detection (default: 0.3) */
  sceneThreshold?: number;
  /** Minimum seconds between fallback keyframes (default: 5) */
  keyframeInterval?: number;
  /** Whisper model name (default: "base.en") */
  whisperModel?: string;
  /** Increase threshold for long videos (default: true) */
  adaptiveThreshold?: boolean;
}

/**
 * Run the full ingestion pipeline on a set of input clips.
 * Processes clips in parallel where possible.
 */
export async function ingest(
  input: IngestionInput,
  options: IngestionOptions = {},
): Promise<IngestionResult> {
  const {
    sceneThreshold = 0.3,
    keyframeInterval = 5,
    whisperModel = "base.en",
    adaptiveThreshold = true,
  } = options;

  // Create a temporary working directory for extracted assets
  const workingDir = path.join(os.tmpdir(), `openzigs-ingest-${nanoid(8)}`);
  await fs.mkdir(workingDir, { recursive: true });

  logger.info(`[Ingestion] Starting pipeline for ${input.clips.length} clip(s) in ${workingDir}`);

  // Process all clips in parallel
  const clipPromises = input.clips.map(async (clipPath, index) => {
    return processClip(clipPath, index, workingDir, {
      sceneThreshold,
      keyframeInterval,
      whisperModel,
      adaptiveThreshold,
    });
  });

  const clips = await Promise.allSettled(clipPromises);

  const successfulClips: ClipAnalysis[] = [];
  for (let i = 0; i < clips.length; i++) {
    const result = clips[i];
    if (result.status === "fulfilled") {
      successfulClips.push(result.value);
    } else {
      logger.error(`[Ingestion] Failed to process clip ${i} (${input.clips[i]}): ${result.reason}`);
    }
  }

  if (successfulClips.length === 0) {
    throw new Error("All clips failed during ingestion — check file paths and formats");
  }

  // Assemble the context payload for the LLM
  const contextPayload = assembleContext(successfulClips);
  const totalDuration = successfulClips.reduce((sum, c) => sum + c.duration, 0);

  logger.info(
    `[Ingestion] Pipeline complete: ${successfulClips.length}/${input.clips.length} clips, ` +
    `${totalDuration.toFixed(1)}s total duration`,
  );

  return {
    clips: successfulClips,
    contextPayload,
    totalDuration,
    workingDir,
  };
}

/**
 * Process a single video clip through the ingestion pipeline.
 */
async function processClip(
  clipPath: string,
  clipIndex: number,
  workingDir: string,
  options: {
    sceneThreshold: number;
    keyframeInterval: number;
    whisperModel: string;
    adaptiveThreshold: boolean;
  },
): Promise<ClipAnalysis> {
  const clipDir = path.join(workingDir, `clip_${clipIndex}`);
  await fs.mkdir(clipDir, { recursive: true });

  // Get video metadata (duration, resolution, fps)
  const metadata = await probeVideoMetadata(clipPath);

  // Adjust scene threshold for long videos (> 30 min)
  let effectiveThreshold = options.sceneThreshold;
  if (options.adaptiveThreshold && metadata.duration > 1800) {
    effectiveThreshold = Math.max(options.sceneThreshold, 0.5);
    logger.info(`[Ingestion] Long video (${metadata.duration.toFixed(0)}s) — raised scene threshold to ${effectiveThreshold}`);
  }

  // Run audio extraction and keyframe extraction in parallel
  const [audioPath, keyframes] = await Promise.all([
    extractAudio(clipPath, clipDir),
    extractKeyframes(clipPath, path.join(clipDir, "keyframes"), {
      sceneThreshold: effectiveThreshold,
      minInterval: options.keyframeInterval,
    }),
  ]);

  // Transcribe audio (if audio was extracted)
  let transcript: ClipAnalysis["transcript"] = [];
  if (audioPath) {
    transcript = await transcribe(audioPath, clipIndex, options.whisperModel);
  }

  return {
    sourcePath: clipPath,
    duration: metadata.duration,
    resolution: metadata.resolution,
    fps: metadata.fps,
    audioPath,
    keyframes,
    transcript,
  };
}

/**
 * Probe video metadata using ffprobe.
 */
async function probeVideoMetadata(
  videoPath: string,
): Promise<{ duration: number; resolution: { width: number; height: number }; fps: number }> {
  try {
    const ffmpeg = (await import("fluent-ffmpeg")).default;

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err: Error | null, metadata: {
        format?: { duration?: number };
        streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; codec_type?: string }>;
      }) => {
        if (err) {
          reject(err);
          return;
        }
        const duration = metadata?.format?.duration ?? 0;
        const videoStream = metadata?.streams?.find((s) => s.codec_type === "video");
        const width = videoStream?.width ?? 1920;
        const height = videoStream?.height ?? 1080;

        // Parse FPS from r_frame_rate (e.g., "30/1" or "30000/1001")
        let fps = 30;
        if (videoStream?.r_frame_rate) {
          const parts = videoStream.r_frame_rate.split("/");
          if (parts.length === 2) {
            fps = Math.round(parseInt(parts[0], 10) / parseInt(parts[1], 10));
          } else {
            fps = parseInt(parts[0], 10) || 30;
          }
        }

        resolve({ duration, resolution: { width, height }, fps });
      });
    });
  } catch {
    // ffprobe not available — return defaults
    return { duration: 0, resolution: { width: 1920, height: 1080 }, fps: 30 };
  }
}

/**
 * Cleanup the working directory after ingestion results are consumed.
 */
export async function cleanupWorkingDir(workingDir: string): Promise<void> {
  try {
    await fs.rm(workingDir, { recursive: true, force: true });
    logger.info(`[Ingestion] Cleaned up working directory: ${workingDir}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[Ingestion] Failed to cleanup ${workingDir}: ${msg}`);
  }
}
