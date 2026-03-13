/**
 * Studio — Lossless Video Trim Worker
 * Issue #441: FFmpeg stream-copy trimming with EventEmitter lifecycle.
 *
 * Uses `ffmpeg -ss -to -c copy` for near-instant lossless cuts.
 * Follows the same EventEmitter pattern as RenderOrchestrator.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";

export interface TrimJob {
  id: string;
  inputPath: string;
  outputPath: string;
  startTime: number;
  endTime: number;
  status: "queued" | "processing" | "complete" | "failed";
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface TrimRequest {
  inputPath: string;
  outputPath: string;
  startTime: number;
  endTime: number;
}

export interface TrimWorkerOptions {
  maxConcurrent?: number;
}

export class TrimWorker extends EventEmitter {
  private readonly queue: TrimJob[] = [];
  private readonly jobs = new Map<string, TrimJob>();
  private readonly maxConcurrent: number;
  private activeCount = 0;

  constructor(options: TrimWorkerOptions = {}) {
    super();
    this.maxConcurrent = options.maxConcurrent ?? 2;
  }

  async submit(request: TrimRequest): Promise<string> {
    const id = `trim-${nanoid(10)}`;
    const job: TrimJob = {
      id,
      inputPath: request.inputPath,
      outputPath: request.outputPath,
      startTime: request.startTime,
      endTime: request.endTime,
      status: "queued",
      createdAt: new Date(),
    };

    this.jobs.set(id, job);
    this.queue.push(job);
    logger.info(`[TrimWorker] Job ${id} queued: ${path.basename(request.inputPath)} [${request.startTime}s → ${request.endTime}s]`);
    this.emit("trim:queued", { jobId: id });
    this.processNext();
    return id;
  }

  getJob(id: string): TrimJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): TrimJob[] {
    return [...this.jobs.values()];
  }

  waitForCompletion(jobId: string, timeoutMs = 60_000): Promise<TrimJob> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) return reject(new Error(`Job ${jobId} not found`));
      if (job.status === "complete") return resolve(job);
      if (job.status === "failed") return reject(new Error(job.error ?? "Trim failed"));

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Trim job ${jobId} timed out after ${timeoutMs}ms`));
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
        this.removeListener("trim:complete", onComplete);
        this.removeListener("trim:failed", onFailed);
      };

      this.on("trim:complete", onComplete);
      this.on("trim:failed", onFailed);
    });
  }

  private processNext(): void {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.activeCount++;
    job.status = "processing";
    this.emit("trim:processing", { jobId: job.id });

    this.executeFfmpeg(job)
      .then(() => {
        job.status = "complete";
        job.completedAt = new Date();
        logger.info(`[TrimWorker] Job ${job.id} complete: ${path.basename(job.outputPath)}`);
        this.emit("trim:complete", { jobId: job.id, outputPath: job.outputPath });
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        logger.error(`[TrimWorker] Job ${job.id} failed: ${job.error}`);
        this.emit("trim:failed", { jobId: job.id, error: job.error });
      })
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });
  }

  private executeFfmpeg(job: TrimJob): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(job.inputPath)) {
        return reject(new Error(`Input file not found: ${job.inputPath}`));
      }

      const dir = path.dirname(job.outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const isWebm = job.inputPath.toLowerCase().endsWith(".webm");
      const args = [
        "-ss", String(job.startTime),
        "-to", String(job.endTime),
        "-i", job.inputPath,
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        ...(isWebm ? [] : ["-movflags", "+faststart"]),
        "-y",
        job.outputPath,
      ];

      logger.debug(`[TrimWorker] ffmpeg ${args.join(" ")}`);
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn ffmpeg: ${err.message}. Is ffmpeg installed?`));
      });
    });
  }
}
