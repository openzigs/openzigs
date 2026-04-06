/**
 * Reframe Worker — AI-powered video reframing with subject tracking.
 * Issue #818: Frame sampling → Vision LLM subject detection →
 *             crop trajectory → FFmpeg render.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import {
  interpolateCropTrajectory,
  computeCropDimensions,
  generateCropFilter,
  type CropKeyframe,
} from "./crop-trajectory.js";

export type LayoutMode =
  | "auto"
  | "single-speaker"
  | "split-screen"
  | "gameplay"
  | "action";

export interface ReframeJob {
  id: string;
  source: string;
  targetAspect: string;
  layout: LayoutMode;
  status:
    | "queued"
    | "sampling"
    | "detecting"
    | "interpolating"
    | "rendering"
    | "complete"
    | "failed";
  outputPath?: string;
  detectedLayout?: LayoutMode;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface ReframeRequest {
  source: string;
  targetAspect: string;
  layout?: LayoutMode;
  smoothing?: number;
  outputPath?: string;
}

export type ReframeWorkerChatFn = (
  prompt: string,
  options?: {
    attachments?: Array<{ type: "file"; path: string; displayName?: string }>;
    model?: string;
    tools?: never[];
  },
) => AsyncGenerator<string>;

export interface ReframeWorkerOptions {
  chat: ReframeWorkerChatFn;
  maxConcurrent?: number;
}

const SUBJECT_DETECTION_PROMPT = `You are a video AI assistant analyzing a video frame for subject position.

Identify the primary subject(s) in this frame and return a JSON object:
{
  "subjects": [
    {
      "type": "person" | "object" | "text" | "screen",
      "boundingBox": { "x": number, "y": number, "width": number, "height": number },
      "label": "description"
    }
  ],
  "contentType": "single-speaker" | "split-screen" | "gameplay" | "action" | "other",
  "suggestedCropCenter": { "x": number, "y": number }
}

Bounding box coordinates are in pixels relative to the frame dimensions.
suggestedCropCenter is the optimal center point for cropping this frame.
Return ONLY valid JSON.`;

export class ReframeWorker extends EventEmitter {
  private readonly queue: ReframeJob[] = [];
  private readonly jobs = new Map<string, ReframeJob>();
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private readonly chat: ReframeWorkerChatFn;

  constructor(options: ReframeWorkerOptions) {
    super();
    this.chat = options.chat;
    this.maxConcurrent = options.maxConcurrent ?? 1;
  }

  async submit(request: ReframeRequest): Promise<string> {
    const id = `reframe-${nanoid(10)}`;
    const galleryDir = path.join(os.homedir(), ".openzigs", "gallery");
    fs.mkdirSync(galleryDir, { recursive: true });

    const outputPath =
      request.outputPath ??
      path.join(
        galleryDir,
        `${path.basename(request.source, path.extname(request.source))}_reframed_${Date.now()}${path.extname(request.source)}`,
      );

    const job: ReframeJob = {
      id,
      source: request.source,
      targetAspect: request.targetAspect,
      layout: request.layout ?? "auto",
      status: "queued",
      outputPath,
      createdAt: new Date(),
    };

    this.jobs.set(id, job);
    this.queue.push(job);
    logger.info(
      `[ReframeWorker] Job ${id} queued: ${path.basename(request.source)} → ${request.targetAspect}`,
    );
    this.emit("reframe:queued", { jobId: id });
    this.processNext(request);
    return id;
  }

  getJob(id: string): ReframeJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): ReframeJob[] {
    return [...this.jobs.values()];
  }

  waitForCompletion(jobId: string, timeoutMs = 300_000): Promise<ReframeJob> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) return reject(new Error(`Job ${jobId} not found`));
      if (job.status === "complete") return resolve(job);
      if (job.status === "failed")
        return reject(new Error(job.error ?? "Reframe failed"));

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Reframe job ${jobId} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      const onComplete = (data: { jobId: string }) => {
        if (data.jobId !== jobId) return;
        cleanup();
        resolve(this.jobs.get(jobId)!);
      };

      const onFailed = (data: { jobId: string; error: string }) => {
        if (data.jobId !== jobId) return;
        cleanup();
        reject(new Error(data.error));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener("reframe:complete", onComplete);
        this.removeListener("reframe:failed", onFailed);
      };

      this.on("reframe:complete", onComplete);
      this.on("reframe:failed", onFailed);
    });
  }

  private processNext(request?: ReframeRequest): void {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0)
      return;
    const job = this.queue.shift()!;
    this.activeCount++;

    const smoothing = request?.smoothing ?? 0.7;

    this.runReframe(job, smoothing)
      .then(() => {
        job.status = "complete";
        job.completedAt = new Date();
        logger.info(
          `[ReframeWorker] Job ${job.id} complete: ${job.outputPath}`,
        );
        this.emit("reframe:complete", {
          jobId: job.id,
          outputPath: job.outputPath,
          detectedLayout: job.detectedLayout,
        });
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        logger.error(`[ReframeWorker] Job ${job.id} failed: ${job.error}`);
        this.emit("reframe:failed", { jobId: job.id, error: job.error });
      })
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });
  }

  private async runReframe(job: ReframeJob, smoothing: number): Promise<void> {
    const tmpDir = path.join(os.tmpdir(), `openzigs-reframe-${job.id}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // Step 1: Get video dimensions
      const { width: srcW, height: srcH } = await this.getVideoDimensions(
        job.source,
      );

      // Step 2: Compute target crop dimensions
      const { width: cropW, height: cropH } = computeCropDimensions(
        srcW,
        srcH,
        job.targetAspect,
      );

      // Step 3: Sample frames at 2fps
      job.status = "sampling";
      this.emit("reframe:progress", {
        jobId: job.id,
        stage: "sampling",
        progress: 10,
      });
      const framePaths = await this.sampleFrames(job.source, tmpDir);

      // Step 4: Vision LLM subject detection on sampled frames
      job.status = "detecting";
      this.emit("reframe:progress", {
        jobId: job.id,
        stage: "detecting",
        progress: 30,
      });
      const keyframes = await this.detectSubjects(
        framePaths,
        srcW,
        srcH,
        cropW,
        cropH,
        job,
      );

      // Step 5: Interpolate trajectory
      job.status = "interpolating";
      this.emit("reframe:progress", {
        jobId: job.id,
        stage: "interpolating",
        progress: 60,
      });

      const fps = await this.getVideoFps(job.source);
      const trajectory = interpolateCropTrajectory(keyframes, fps, smoothing);

      // Step 6: Render with FFmpeg
      job.status = "rendering";
      this.emit("reframe:progress", {
        jobId: job.id,
        stage: "rendering",
        progress: 70,
      });

      const cropFilter = generateCropFilter(
        trajectory,
        srcW,
        srcH,
        cropW,
        cropH,
      );
      await this.renderWithCrop(job.source, job.outputPath!, cropFilter);

      this.emit("reframe:progress", {
        jobId: job.id,
        stage: "complete",
        progress: 100,
      });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup
      }
    }
  }

  /** Sample frames at 2fps for subject detection. */
  async sampleFrames(inputPath: string, tmpDir: string): Promise<string[]> {
    const framePattern = path.join(tmpDir, "frame_%05d.jpg");
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-vf",
        "fps=2,scale=640:-1",
        "-q:v",
        "3",
        framePattern,
        "-y",
      ]);

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Frame sampling failed: ${stderr.slice(-500)}`));
          return;
        }
        const files = fs
          .readdirSync(tmpDir)
          .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
          .sort()
          .map((f) => path.join(tmpDir, f));
        resolve(files);
      });

      proc.on("error", reject);
    });
  }

  /** Detect subjects in frames via Vision LLM. */
  private async detectSubjects(
    framePaths: string[],
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number,
    job: ReframeJob,
  ): Promise<CropKeyframe[]> {
    const keyframes: CropKeyframe[] = [];
    const layoutVotes = new Map<LayoutMode, number>();

    // Process every 5th frame to keep API calls manageable
    const step = Math.max(1, Math.floor(framePaths.length / 30));
    for (let i = 0; i < framePaths.length; i += step) {
      const framePath = framePaths[i];
      const timestamp = i * 0.5; // 2fps → 0.5s between frames

      try {
        let response = "";
        for await (const chunk of this.chat(SUBJECT_DETECTION_PROMPT, {
          attachments: [
            {
              type: "file",
              path: framePath,
              displayName: `frame_t${timestamp}s`,
            },
          ],
          tools: [],
        })) {
          response += chunk;
        }

        const parsed = JSON.parse(
          response
            .replace(/```json?\s*/g, "")
            .replace(/```\s*/g, "")
            .trim(),
        ) as {
          subjects?: Array<{
            boundingBox?: {
              x: number;
              y: number;
              width: number;
              height: number;
            };
          }>;
          contentType?: string;
          suggestedCropCenter?: { x: number; y: number };
        };

        // Determine crop position from subject detection
        let cropX: number;
        let cropY: number;

        if (parsed.suggestedCropCenter) {
          // Scale from frame coordinates (640px wide) to source
          const scaleX = srcW / 640;
          const scaleY = srcH / (640 * (srcH / srcW));
          cropX = Math.max(
            0,
            Math.min(
              srcW - cropW,
              Math.round(parsed.suggestedCropCenter.x * scaleX - cropW / 2),
            ),
          );
          cropY = Math.max(
            0,
            Math.min(
              srcH - cropH,
              Math.round(parsed.suggestedCropCenter.y * scaleY - cropH / 2),
            ),
          );
        } else {
          // Default center crop
          cropX = Math.round((srcW - cropW) / 2);
          cropY = Math.round((srcH - cropH) / 2);
        }

        keyframes.push({
          timestamp,
          x: cropX,
          y: cropY,
          width: cropW,
          height: cropH,
        });

        // Vote on layout
        if (parsed.contentType) {
          const layout = parsed.contentType as LayoutMode;
          layoutVotes.set(layout, (layoutVotes.get(layout) ?? 0) + 1);
        }
      } catch {
        // On failure, use center crop for this frame
        keyframes.push({
          timestamp,
          x: Math.round((srcW - cropW) / 2),
          y: Math.round((srcH - cropH) / 2),
          width: cropW,
          height: cropH,
        });
      }
    }

    // Determine layout from votes
    if (job.layout === "auto" && layoutVotes.size > 0) {
      let bestLayout: LayoutMode = "single-speaker";
      let bestCount = 0;
      for (const [layout, count] of layoutVotes) {
        if (count > bestCount) {
          bestLayout = layout;
          bestCount = count;
        }
      }
      job.detectedLayout = bestLayout;
    } else {
      job.detectedLayout = job.layout;
    }

    return keyframes;
  }

  /** Render video with crop filter. */
  private async renderWithCrop(
    inputPath: string,
    outputPath: string,
    cropFilter: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-vf",
        cropFilter,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "copy",
        outputPath,
        "-y",
      ]);

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg render failed: ${stderr.slice(-500)}`));
          return;
        }
        resolve();
      });

      proc.on("error", reject);
    });
  }

  /** Get video dimensions via ffprobe. */
  async getVideoDimensions(
    inputPath: string,
  ): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffprobe", [
        "-v",
        "quiet",
        "-show_entries",
        "stream=width,height",
        "-select_streams",
        "v:0",
        "-of",
        "json",
        inputPath,
      ]);

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("ffprobe failed"));
          return;
        }
        try {
          const data = JSON.parse(stdout) as {
            streams?: Array<{ width?: number; height?: number }>;
          };
          const stream = data.streams?.[0];
          resolve({
            width: stream?.width ?? 1920,
            height: stream?.height ?? 1080,
          });
        } catch {
          resolve({ width: 1920, height: 1080 });
        }
      });

      proc.on("error", reject);
    });
  }

  /** Get video FPS via ffprobe. */
  private async getVideoFps(inputPath: string): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v",
        "quiet",
        "-show_entries",
        "stream=r_frame_rate",
        "-select_streams",
        "v:0",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputPath,
      ]);

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on("close", () => {
        const parts = stdout.trim().split("/");
        if (parts.length === 2) {
          const fps = parseInt(parts[0], 10) / parseInt(parts[1], 10);
          resolve(isNaN(fps) ? 30 : fps);
        } else {
          resolve(30);
        }
      });

      proc.on("error", () => resolve(30));
    });
  }
}
