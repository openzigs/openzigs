/**
 * Media Queue — Push-Based Queue Master
 * Issue #326: Actively pushes jobs to hardware worker nodes.
 * VRAM-aware routing for M2 Pro to prevent model thrashing.
 */

import { EventEmitter } from "node:events";
import { logger } from "../logging/logger.js";
import type { MediaQueueRepository } from "./media-queue-repository.js";
import type {
  MediaJob,
  QueueConfig,
  TargetNode,
  WorkerStatus,
} from "./types.js";

export interface QueueMasterEvents {
  "job:dispatched": [job: MediaJob, node: TargetNode];
  "job:complete": [job: MediaJob];
  "job:failed": [job: MediaJob, error: string];
  "project:complete": [projectId: string, total: number];
}

export class QueueMaster extends EventEmitter {
  private repo: MediaQueueRepository;
  private config: QueueConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Cache of last-known worker status to reduce /status polling. */
  private m2ProStatus: WorkerStatus = { is_busy: false, loaded_model: null };

  constructor(repo: MediaQueueRepository, config: QueueConfig) {
    super();
    this.repo = repo;
    this.config = config;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(`[QueueMaster] Starting push loop (interval=${this.config.pollIntervalMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    // Run immediately on start
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("[QueueMaster] Stopped");
  }

  // ── Main Loop ─────────────────────────────────────────────

  async tick(): Promise<void> {
    try {
      await this.processNode("mac-mini");
      await this.processNode("m2-pro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueMaster] Tick error: ${msg}`);
    }
  }

  private async processNode(node: TargetNode): Promise<void> {
    if (node === "m2-pro") {
      await this.processM2Pro();
    } else {
      await this.processMacMini();
    }
  }

  // ── Mac Mini (Image jobs) ─────────────────────────────────

  private async processMacMini(): Promise<void> {
    const pending = this.repo.getPendingJobs("mac-mini", 3);
    for (const job of pending) {
      try {
        await this.dispatchImageJob(job);
        this.repo.markDispatched(job.id);
        this.emit("job:dispatched", job, "mac-mini" as TargetNode);
        logger.info(`[QueueMaster] Dispatched ${job.type} job ${job.id} → mac-mini`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[QueueMaster] Failed to dispatch ${job.id} to mac-mini: ${msg}`);
        this.repo.markFailed(job.id, msg);
      }
    }
  }

  // ── M2 Pro (Video/Audio jobs) — VRAM-aware ────────────────

  private async processM2Pro(): Promise<void> {
    // Check worker status first
    try {
      this.m2ProStatus = await this.getWorkerStatus(this.config.m2Pro);
    } catch {
      logger.debug("[QueueMaster] M2 Pro unreachable, skipping video jobs");
      return;
    }

    if (this.m2ProStatus.is_busy) {
      logger.debug("[QueueMaster] M2 Pro busy, skipping");
      return;
    }

    // VRAM-aware: prioritize jobs matching currently loaded model
    let pending: MediaJob[] = [];
    if (this.m2ProStatus.loaded_model) {
      pending = this.repo.getPendingJobsForModel("m2-pro", this.m2ProStatus.loaded_model, 1);
    }

    // If no jobs match loaded model, get any pending job
    if (pending.length === 0) {
      pending = this.repo.getPendingJobs("m2-pro", 1);
    }

    if (pending.length === 0) return;

    const job = pending[0];
    try {
      await this.dispatchVideoJob(job);
      this.repo.markDispatched(job.id);
      this.emit("job:dispatched", job, "m2-pro" as TargetNode);
      logger.info(`[QueueMaster] Dispatched ${job.type} job ${job.id} → m2-pro (model=${job.requiredModel})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueMaster] Failed to dispatch ${job.id} to m2-pro: ${msg}`);
      this.repo.markFailed(job.id, msg);
    }
  }

  // ── Worker Communication ──────────────────────────────────

  private async getWorkerStatus(node: { url: string; token?: string }): Promise<WorkerStatus> {
    const headers: Record<string, string> = {};
    if (node.token) headers["Authorization"] = `Bearer ${node.token}`;

    const res = await fetch(`${node.url}/status`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
    return (await res.json()) as WorkerStatus;
  }

  private async dispatchImageJob(job: MediaJob): Promise<void> {
    const { url, token } = this.config.macMini;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const endpoint = job.type === "img2img" ? "/img2img" : "/generate";
    const body: Record<string, unknown> = {
      prompt: job.payload.prompt,
      width: job.payload.width ?? 1024,
      height: job.payload.height ?? 576,
      steps: job.payload.steps,
      guidance_scale: job.payload.guidance_scale,
      seed: job.payload.seed,
      model: job.requiredModel === "flux-schnell" ? "flux-schnell" : job.requiredModel,
    };

    if (job.type === "img2img" && job.payload.init_image) {
      body.image = job.payload.init_image;
      body.strength = job.payload.strength ?? 0.8;
    }

    const res = await fetch(`${url}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Mac Mini ${endpoint} returned ${res.status}: ${text}`);
    }

    // Mac Mini returns PNG bytes synchronously — convert to base64 and complete
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    this.handleJobCompletion(job.id, {
      media_base64: base64,
      media_type: "image/png",
      metadata: {
        model: res.headers.get("x-model") ?? job.requiredModel,
        generation_time: res.headers.get("x-generation-time"),
        seed: res.headers.get("x-seed"),
      },
    });
  }

  private async dispatchVideoJob(job: MediaJob): Promise<void> {
    const { url, token } = this.config.m2Pro;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const body: Record<string, unknown> = {
      job_id: job.id,
      type: job.type,
      prompt: job.payload.prompt,
      width: job.payload.width ?? 768,
      height: job.payload.height ?? 512,
      num_frames: job.payload.num_frames ?? 97,
      fps: job.payload.fps ?? 24,
      model: job.requiredModel,
      callback_url: this.config.callbackUrl,
    };

    if (job.payload.init_image) {
      body.init_image = job.payload.init_image;
    }

    const res = await fetch(`${url}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    // Expect 202 Accepted — worker processes asynchronously
    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`M2 Pro /generate returned ${res.status}: ${text}`);
    }
  }

  // ── Job Completion (called by webhook) ────────────────────

  handleJobCompletion(
    jobId: string,
    result: { media_base64?: string; media_type?: string; metadata?: Record<string, unknown>; error?: string },
  ): void {
    const job = this.repo.getJob(jobId);
    if (!job) {
      logger.warn(`[QueueMaster] Completion for unknown job: ${jobId}`);
      return;
    }

    if (result.error) {
      this.repo.markFailed(jobId, result.error);
      this.emit("job:failed", job, result.error);
      logger.info(`[QueueMaster] Job ${jobId} failed: ${result.error}`);
      return;
    }

    // Save media asset — emitter will handle gallery storage
    this.repo.markComplete(jobId, "", result.metadata);

    const updatedJob = this.repo.getJob(jobId)!;
    this.emit("job:complete", updatedJob);
    logger.info(`[QueueMaster] Job ${jobId} complete (type=${job.type})`);

    // Check if entire project is done
    if (job.projectId) {
      const status = this.repo.isProjectComplete(job.projectId);
      if (status.complete) {
        this.emit("project:complete", job.projectId, status.total);
        logger.info(`[QueueMaster] Project ${job.projectId} complete (${status.total} jobs)`);
      }
    }
  }
}
