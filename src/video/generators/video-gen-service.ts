/**
 * Director Mode — Video Generation Service (Queue-Integrated)
 * Issue #330: T2V/I2V execution engine that routes video generation
 * through the push-based media queue to the M2 Pro worker.
 */

import { logger } from "../../logging/logger.js";
import type { MediaQueueRepository } from "../../queue/media-queue-repository.js";
import type { MediaJob } from "../../queue/types.js";
import { MAX_VIDEO_FRAMES, MAX_VIDEO_DURATION_SEC, DEFAULT_VIDEO_FPS } from "../../queue/types.js";

// ── Types ─────────────────────────────────────────────────────

export interface VideoGenOptions {
  /** Text prompt describing the desired video */
  prompt: string;
  /** Width in pixels (default: 768) */
  width?: number;
  /** Height in pixels (default: 512) */
  height?: number;
  /** Number of frames (max 97 = 4s at 24fps) */
  numFrames?: number;
  /** Frames per second (default: 24) */
  fps?: number;
  /** Random seed for reproducibility */
  seed?: number;
  /** Base64-encoded source image for img2video */
  initImage?: string;
  /** Project ID to group jobs */
  projectId?: string;
  /** Priority (higher = processed first) */
  priority?: number;
}

export interface VideoGenResult {
  /** Queue job ID */
  jobId: string;
  /** Job status */
  status: string;
  /** Result URL when complete */
  resultUrl: string | null;
  /** Gallery asset ID when complete */
  galleryAssetId: string | null;
}

// ── Service ───────────────────────────────────────────────────

export class VideoGenService {
  constructor(private readonly repo: MediaQueueRepository) {}

  /**
   * Submit a text-to-video generation job to the queue.
   * Returns immediately with the job ID — actual generation is async.
   */
  async submitTextToVideo(options: VideoGenOptions): Promise<VideoGenResult> {
    const numFrames = Math.min(options.numFrames ?? MAX_VIDEO_FRAMES, MAX_VIDEO_FRAMES);
    const fps = options.fps ?? DEFAULT_VIDEO_FPS;

    logger.info(
      `[VideoGenService] Submitting txt2video: ${numFrames} frames, ${fps}fps, ` +
      `${(numFrames / fps).toFixed(1)}s`,
    );

    const job = this.repo.createJob({
      type: "txt2video",
      payload: {
        prompt: options.prompt,
        width: options.width ?? 768,
        height: options.height ?? 512,
        num_frames: numFrames,
        fps,
        seed: options.seed,
      },
      projectId: options.projectId,
      priority: options.priority ?? 0,
    });

    return this.toResult(job);
  }

  /**
   * Submit an image-to-video generation job to the queue.
   * The init image is animated into a 4-second video clip.
   */
  async submitImageToVideo(options: VideoGenOptions): Promise<VideoGenResult> {
    if (!options.initImage) {
      throw new Error("initImage (base64) is required for img2video");
    }

    const numFrames = Math.min(options.numFrames ?? MAX_VIDEO_FRAMES, MAX_VIDEO_FRAMES);
    const fps = options.fps ?? DEFAULT_VIDEO_FPS;

    logger.info(
      `[VideoGenService] Submitting img2video: ${numFrames} frames, ${fps}fps`,
    );

    const job = this.repo.createJob({
      type: "img2video",
      payload: {
        prompt: options.prompt,
        width: options.width ?? 768,
        height: options.height ?? 512,
        num_frames: numFrames,
        fps,
        seed: options.seed,
        init_image: options.initImage,
      },
      projectId: options.projectId,
      priority: options.priority ?? 0,
    });

    return this.toResult(job);
  }

  /**
   * Poll a job until complete or timeout.
   * Useful for blocking Director pipeline stages.
   */
  async waitForJob(jobId: string, timeoutMs = 300_000, pollIntervalMs = 2000): Promise<VideoGenResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = this.repo.getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);

      if (job.status === "complete") {
        return this.toResult(job);
      }

      if (job.status === "failed") {
        throw new Error(`Video generation failed: ${job.error ?? "Unknown error"}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Video generation timed out after ${timeoutMs}ms`);
  }

  /**
   * Get the current status of a job.
   */
  getJobStatus(jobId: string): VideoGenResult | null {
    const job = this.repo.getJob(jobId);
    if (!job) return null;
    return this.toResult(job);
  }

  private toResult(job: MediaJob): VideoGenResult {
    return {
      jobId: job.id,
      status: job.status,
      resultUrl: job.resultUrl,
      galleryAssetId: job.galleryAssetId,
    };
  }
}

// ── Constants Re-export ──────────────────────────────────────

export { MAX_VIDEO_FRAMES, MAX_VIDEO_DURATION_SEC, DEFAULT_VIDEO_FPS };
