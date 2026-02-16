/**
 * Director Mode — Render Orchestrator
 * Issue #235: Manages render jobs, spawns Worker Threads, emits progress events.
 *
 * The orchestrator is the public API for the rendering subsystem.
 * Components (Task Engine, Socket.IO, Admin API) interact with renders
 * exclusively through this class.
 */

import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import { validateManifest } from "./manifest/manifest-validator.js";
import type { RenderJob, RenderProgress, RenderRequest, RenderResult, WorkerMessage } from "./render-types.js";

/** Resolve ~ to home directory. */
function resolvePath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export interface RenderOrchestratorOptions {
  /** Base directory for render outputs (default: ~/.openzigs/renders) */
  rendersDir?: string;
  /** Maximum concurrent render jobs (default: 1) */
  maxConcurrent?: number;
}

export class RenderOrchestrator extends EventEmitter {
  private readonly rendersDir: string;
  private readonly maxConcurrent: number;
  private readonly jobs = new Map<string, RenderJob>();
  private readonly activeWorkers = new Map<string, Worker>();
  private readonly queue: string[] = [];
  private concurrentCount = 0;

  constructor(options: RenderOrchestratorOptions = {}) {
    super();
    this.rendersDir = resolvePath(options.rendersDir ?? "~/.openzigs/renders");
    this.maxConcurrent = options.maxConcurrent ?? 1;
  }

  /**
   * Submit a render job. Returns the job ID immediately.
   * The render runs asynchronously in a Worker Thread.
   */
  async submit(request: RenderRequest): Promise<string> {
    // Validate the manifest first
    const validation = validateManifest(request.manifest);
    if (!validation.valid) {
      throw new Error(`Invalid manifest: ${validation.errors.join("; ")}`);
    }

    const jobId = nanoid(12);
    const now = new Date();

    const job: RenderJob = {
      id: jobId,
      manifest: request.manifest,
      status: "queued",
      progress: 0,
      outputPath: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      durationSec: null,
      fileSizeBytes: null,
    };

    this.jobs.set(jobId, job);
    this.queue.push(jobId);

    logger.info(`[RenderOrchestrator] Job ${jobId} queued — "${request.manifest.projectTitle}"`);
    this.emit("render:queued", { jobId, manifest: request.manifest });

    // Try to start immediately if under concurrency limit
    this.processQueue();

    return jobId;
  }

  /**
   * Abort a running or queued render job.
   */
  abort(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    // Remove from queue if still queued
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      job.status = "aborted";
      job.updatedAt = new Date();
      this.emit("render:aborted", { jobId });
      return true;
    }

    // Terminate the worker if rendering
    const worker = this.activeWorkers.get(jobId);
    if (worker) {
      worker.postMessage({ type: "abort", jobId } satisfies WorkerMessage);
      worker.terminate();
      this.activeWorkers.delete(jobId);
      this.concurrentCount--;
      job.status = "aborted";
      job.updatedAt = new Date();
      this.emit("render:aborted", { jobId });
      this.processQueue();
      return true;
    }

    return false;
  }

  /**
   * Get the current state of a render job.
   */
  getJob(jobId: string): RenderJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * List all render jobs (most recent first).
   */
  listJobs(): RenderJob[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Wait for a specific job to complete. Returns the final RenderResult.
   */
  waitForCompletion(jobId: string): Promise<RenderResult> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) {
        reject(new Error(`Unknown job: ${jobId}`));
        return;
      }

      if (job.status === "complete") {
        resolve({
          jobId,
          success: true,
          outputPath: job.outputPath,
          error: null,
          durationSec: job.durationSec,
          fileSizeBytes: job.fileSizeBytes,
        });
        return;
      }

      if (job.status === "failed" || job.status === "aborted") {
        resolve({
          jobId,
          success: false,
          outputPath: null,
          error: job.error ?? job.status,
          durationSec: null,
          fileSizeBytes: null,
        });
        return;
      }

      const onComplete = (event: RenderResult) => {
        if (event.jobId === jobId) {
          this.removeListener("render:complete", onComplete);
          this.removeListener("render:failed", onFailed);
          resolve(event);
        }
      };

      const onFailed = (event: { jobId: string; error: string }) => {
        if (event.jobId === jobId) {
          this.removeListener("render:complete", onComplete);
          this.removeListener("render:failed", onFailed);
          resolve({
            jobId,
            success: false,
            outputPath: null,
            error: event.error,
            durationSec: null,
            fileSizeBytes: null,
          });
        }
      };

      this.on("render:complete", onComplete);
      this.on("render:failed", onFailed);
    });
  }

  /**
   * Shutdown the orchestrator — abort all running jobs and clear the queue.
   */
  async shutdown(): Promise<void> {
    this.queue.length = 0;
    for (const [jobId, worker] of this.activeWorkers) {
      worker.terminate();
      const job = this.jobs.get(jobId);
      if (job) {
        job.status = "aborted";
        job.updatedAt = new Date();
      }
    }
    this.activeWorkers.clear();
    this.concurrentCount = 0;
    logger.info("[RenderOrchestrator] Shut down — all jobs aborted");
  }

  // ── Private ─────────────────────────────────────────────────

  private processQueue(): void {
    while (this.concurrentCount < this.maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      this.startWorker(jobId);
    }
  }

  private startWorker(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.concurrentCount++;
    job.status = "rendering";
    job.updatedAt = new Date();

    const outputDir = path.join(this.rendersDir, jobId);

    // Resolve the worker script path relative to this file's location.
    // In dev mode (.ts source) Worker Threads can't load TypeScript directly,
    // so we use a thin .mjs bootstrap that registers tsx before importing the
    // real worker module.  In production (compiled .js) no loader is needed.
    const baseDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
    const isDevMode = import.meta.url.endsWith(".ts");
    const workerPath = path.join(
      baseDir,
      isDevMode ? "render-worker-loader.mjs" : "render-worker.js",
    );

    const worker = new Worker(workerPath, { stderr: true });

    this.activeWorkers.set(jobId, worker);

    // Capture worker stderr for debugging (worker exit code 1 needs diagnosis)
    let stderrChunks: string[] = [];
    if (worker.stderr) {
      worker.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        logger.error(`[RenderWorker:${jobId}] ${text.trimEnd()}`);
      });
    }

    worker.on("message", (msg: WorkerMessage) => {
      this.handleWorkerMessage(msg);
    });

    worker.on("error", (error) => {
      this.handleWorkerError(jobId, error);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        const job = this.jobs.get(jobId);
        if (job && job.status !== "complete" && job.status !== "aborted" && job.status !== "failed") {
          const stderr = stderrChunks.join("").trim();
          const errorMsg = stderr
            ? `Worker exited with code ${code}: ${stderr.slice(-500)}`
            : `Worker exited with code ${code}`;
          this.handleWorkerError(jobId, new Error(errorMsg));
        }
      }
    });

    // Send the render command to the worker
    worker.postMessage({
      type: "start",
      jobId,
      manifest: job.manifest,
      outputDir,
    } satisfies WorkerMessage);

    logger.info(`[RenderOrchestrator] Job ${jobId} started worker`);
  }

  private handleWorkerMessage(msg: WorkerMessage): void {
    const job = this.jobs.get(msg.jobId);
    if (!job) return;

    switch (msg.type) {
      case "progress": {
        job.progress = msg.progress;
        // Map progress ranges to Remotion SSR phases
        if (msg.progress < 0.20) {
          job.status = "bundling";
        } else if (msg.progress < 0.30) {
          job.status = "rendering";
        } else if (msg.progress < 0.95) {
          job.status = "encoding";
        } else {
          job.status = "encoding";
        }
        job.updatedAt = new Date();

        const progressEvent: RenderProgress = {
          jobId: msg.jobId,
          status: job.status,
          progress: msg.progress,
          framesRendered: msg.framesRendered,
          totalFrames: msg.totalFrames,
        };

        this.emit("render:progress", progressEvent);
        break;
      }

      case "complete": {
        job.status = "complete";
        job.progress = 1.0;
        job.outputPath = msg.outputPath;
        job.durationSec = msg.durationSec;
        job.fileSizeBytes = msg.fileSizeBytes;
        job.updatedAt = new Date();

        this.cleanupWorker(msg.jobId);

        const result: RenderResult = {
          jobId: msg.jobId,
          success: true,
          outputPath: msg.outputPath,
          error: null,
          durationSec: msg.durationSec,
          fileSizeBytes: msg.fileSizeBytes,
        };

        logger.info(`[RenderOrchestrator] Job ${msg.jobId} complete → ${msg.outputPath}`);
        this.emit("render:complete", result);
        break;
      }

      case "error": {
        this.handleWorkerError(msg.jobId, new Error(msg.error));
        break;
      }
    }
  }

  private handleWorkerError(jobId: string, error: Error): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = error.message;
      job.updatedAt = new Date();
    }

    this.cleanupWorker(jobId);

    logger.error(`[RenderOrchestrator] Job ${jobId} failed: ${error.message}`);
    this.emit("render:failed", { jobId, error: error.message });
  }

  private cleanupWorker(jobId: string): void {
    const worker = this.activeWorkers.get(jobId);
    if (worker) {
      worker.terminate();
      this.activeWorkers.delete(jobId);
    }
    this.concurrentCount--;
    this.processQueue();
  }
}
