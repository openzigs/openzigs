/**
 * Media Queue — Push-Based Queue Master
 * Issue #326: Actively pushes jobs to hardware worker nodes.
 * VRAM-aware routing with cross-sidecar coordination — both sidecars share
 * the same M2 Pro unified memory, so only one model domain (image OR video)
 * can be loaded at a time.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { logger } from "../logging/logger.js";
import type { MediaQueueRepository } from "./media-queue-repository.js";
import type {
  MediaJob,
  QueueConfig,
  TargetNode,
  WorkerStatus,
  WorkerNodeConfig,
} from "./types.js";

export interface QueueMasterEvents {
  "job:dispatched": [job: MediaJob, node: TargetNode];
  "job:complete": [job: MediaJob];
  "job:failed": [job: MediaJob, error: string];
  "project:complete": [projectId: string, total: number];
}

/** Aggregated status of all worker nodes. */
export interface NodeStatus {
  node: TargetNode;
  reachable: boolean;
  is_busy: boolean;
  loaded_model: string | null;
  url: string;
}

export class QueueMaster extends EventEmitter {
  private repo: MediaQueueRepository;
  private config: QueueConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Cache of last-known worker status to reduce /status polling. */
  private macMiniStatus: WorkerStatus = { is_busy: false, loaded_model: null };
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

  // ── Node Status ───────────────────────────────────────────

  /**
   * Get the live status of all worker nodes.
   * Polls each sidecar's /status (or /health for FluxQ) endpoint.
   */
  async getNodeStatuses(): Promise<NodeStatus[]> {
    const [macMini, m2Pro] = await Promise.allSettled([
      this.pollNodeStatus("mac-mini"),
      this.pollNodeStatus("m2-pro"),
    ]);

    return [
      macMini.status === "fulfilled"
        ? macMini.value
        : { node: "mac-mini" as TargetNode, reachable: false, is_busy: false, loaded_model: null, url: this.config.macMini.url },
      m2Pro.status === "fulfilled"
        ? m2Pro.value
        : { node: "m2-pro" as TargetNode, reachable: false, is_busy: false, loaded_model: null, url: this.config.m2Pro.url },
    ];
  }

  private async pollNodeStatus(node: TargetNode): Promise<NodeStatus> {
    const nodeConfig = await this.getLiveNodeConfig(node);

    // FluxQ (mac-mini) is single-threaded Python — it cannot respond to /health
    // while blocking on inference. If we know it's busy, return the cached status
    // as reachable rather than hammering it with health checks that will time out.
    if (node === "mac-mini" && this.macMiniStatus.is_busy) {
      return { node, reachable: true, ...this.macMiniStatus, url: nodeConfig.url };
    }

    try {
      const status = await this.getWorkerStatus(nodeConfig, node);
      // If the worker reports idle but there are RECENT dispatched jobs, it may
      // still be loading the model (LTX-2 can take 10+ min to load). Override
      // is_busy during that window so the UI shows "Busy" rather than the
      // misleading "No model loaded". Only consider jobs dispatched within the
      // last 15 minutes — stale dispatched jobs (orphans from crashed sessions)
      // should not permanently gate the status on an idle worker.
      if (!status.is_busy) {
        const recentCutoffMs = Date.now() - 15 * 60 * 1000; // 15 min
        const dispatched = this.repo.listJobs({ status: "dispatched" });
        if (dispatched.some((j) => j.targetNode === node && j.dispatchedAt && j.dispatchedAt.getTime() > recentCutoffMs)) {
          status.is_busy = true;
        }
      }
      if (node === "mac-mini") this.macMiniStatus = status;
      else this.m2ProStatus = status;
      return { node, reachable: true, ...status, url: nodeConfig.url };
    } catch {
      return { node, reachable: false, is_busy: false, loaded_model: null, url: nodeConfig.url };
    }
  }

  // ── VRAM Coordination ─────────────────────────────────────

  /**
   * Ensure the competing sidecar has unloaded its model before we
   * dispatch to the target node. Both sidecars share M2 Pro unified memory.
   *
   * Before image job → unload LTX-2 from video worker
   * Before video job → unload FLUX from image worker
   */
  private async ensureVramAvailable(targetNode: TargetNode): Promise<void> {
    if (targetNode === "mac-mini") {
      // About to dispatch image job — ensure video worker has unloaded
      if (this.m2ProStatus.loaded_model) {
        logger.info(`[QueueMaster] VRAM coordination: unloading ${this.m2ProStatus.loaded_model} from m2-pro before image dispatch`);
        await this.unloadNode("m2-pro");
      }
    } else {
      // About to dispatch video job — ensure image worker has unloaded
      if (this.macMiniStatus.loaded_model) {
        logger.info(`[QueueMaster] VRAM coordination: unloading ${this.macMiniStatus.loaded_model} from mac-mini before video dispatch`);
        await this.unloadNode("mac-mini");
      }
    }
  }

  /**
   * Returns a fresh WorkerNodeConfig for the given node by re-reading
   * ~/.openzigs/config.json. Falls back to the baked-in startup config.
   * Ensures token/URL changes saved via the admin UI take effect without
   * requiring a server restart.
   */
  private async getLiveNodeConfig(node: TargetNode): Promise<WorkerNodeConfig> {
    try {
      const cfgPath = path.join(os.homedir(), ".openzigs", "config.json");
      const raw = await fs.readFile(cfgPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      if (node === "mac-mini") {
        const ig = cfg.imageGen as Record<string, unknown> | undefined;
        if (ig?.mode === "network" && typeof ig.networkNodeUrl === "string" && ig.networkNodeUrl) {
          return {
            url: ig.networkNodeUrl,
            token: typeof ig.networkNodeToken === "string" ? ig.networkNodeToken : this.config.macMini.token,
          };
        }
      } else {
        const vg = cfg.videoGen as Record<string, unknown> | undefined;
        if (typeof vg?.networkNodeUrl === "string" && vg.networkNodeUrl) {
          return {
            url: vg.networkNodeUrl,
            token: typeof vg.networkNodeToken === "string" ? vg.networkNodeToken : this.config.m2Pro.token,
          };
        }
      }
    } catch {
      // config unreadable — fall through to startup config
    }
    return node === "mac-mini" ? this.config.macMini : this.config.m2Pro;
  }

  /**
   * Tell a specific node to unload its current model and free VRAM.
   * FluxQ uses POST /unload, M2 Pro worker uses POST /unload.
   */
  async unloadNode(node: TargetNode): Promise<{ ok: boolean; previous_model: string | null }> {
    const nodeConfig = await this.getLiveNodeConfig(node);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (nodeConfig.token) headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    try {
      const res = await fetch(`${nodeConfig.url}/unload`, {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn(`[QueueMaster] Unload ${node} failed: ${res.status} ${text}`);
        return { ok: false, previous_model: null };
      }

      const result = (await res.json()) as { status?: string; model?: string; previous_model?: string };
      const previousModel = result.previous_model ?? result.model ?? null;

      // Update cached status
      if (node === "mac-mini") this.macMiniStatus = { is_busy: false, loaded_model: null };
      else this.m2ProStatus = { is_busy: false, loaded_model: null };

      logger.info(`[QueueMaster] Unloaded ${previousModel ?? "model"} from ${node}`);
      return { ok: true, previous_model: previousModel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueMaster] Unload ${node} error: ${msg}`);
      return { ok: false, previous_model: null };
    }
  }

  /**
   * Switch the active model domain. Unloads the competing node and optionally
   * preloads a model on the target node.
   *
   * @param targetNode - Which node domain to activate ("mac-mini" for images, "m2-pro" for video)
   * @param model - Optional model to preload (e.g. "flux-schnell", "ltx-2")
   */
  async switchActiveNode(targetNode: TargetNode, model?: string): Promise<{
    unloaded: { node: TargetNode; previous_model: string | null } | null;
    loaded: { node: TargetNode; model: string } | null;
  }> {
    // Unload the competing node
    const competingNode: TargetNode = targetNode === "mac-mini" ? "m2-pro" : "mac-mini";
    let unloaded: { node: TargetNode; previous_model: string | null } | null = null;

    const competingStatus = competingNode === "mac-mini" ? this.macMiniStatus : this.m2ProStatus;
    if (competingStatus.loaded_model) {
      const result = await this.unloadNode(competingNode);
      if (result.ok) {
        unloaded = { node: competingNode, previous_model: result.previous_model };
      }
    }

    // Preload model on target if requested
    let loaded: { node: TargetNode; model: string } | null = null;
    if (model && targetNode === "mac-mini") {
      // FluxQ: POST /model { model: "flux-schnell" }
      try {
        const nodeConfig = await this.getLiveNodeConfig("mac-mini");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (nodeConfig.token) headers["Authorization"] = `Bearer ${nodeConfig.token}`;

        const res = await fetch(`${nodeConfig.url}/model`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(120_000), // Model loads can take 30-60s
        });

        if (res.ok) {
          this.macMiniStatus = { is_busy: false, loaded_model: model };
          loaded = { node: targetNode, model };
          logger.info(`[QueueMaster] Preloaded ${model} on mac-mini`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[QueueMaster] Failed to preload ${model} on mac-mini: ${msg}`);
      }
    }
    // M2 Pro video worker lazily loads on first job, no preload endpoint

    return { unloaded, loaded };
  }

  // ── Main Loop ─────────────────────────────────────────────

  async tick(): Promise<void> {
    try {
      this.recoverStuckJobs();
      await this.processNode("mac-mini");
      await this.processNode("m2-pro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueMaster] Tick error: ${msg}`);
    }
  }

  /**
   * Watchdog: find jobs stuck in 'dispatched' state longer than dispatchTimeoutMs
   * and fail them (which resets to 'pending' if retries remain). This recovers
   * jobs lost when a worker restarts mid-generation.
   */
  private recoverStuckJobs(): void {
    const timeoutMs = this.config.dispatchTimeoutMs ?? 45 * 60 * 1000; // 45 min default
    const dispatched = this.repo.listJobs({ status: "dispatched", limit: 50 });
    const cutoff = Date.now() - timeoutMs;

    for (const job of dispatched) {
      if (job.dispatchedAt && job.dispatchedAt.getTime() < cutoff) {
        const ageMin = Math.round((Date.now() - job.dispatchedAt.getTime()) / 60_000);
        logger.warn(
          `[QueueMaster] Job ${job.id} stuck in dispatched for ${ageMin}min — resetting for retry`,
        );
        this.repo.markFailed(job.id, `Dispatch timeout after ${ageMin}min (worker may have restarted)`);
        // Clear the in-memory busy flag for the relevant node
        if (job.targetNode === "mac-mini") {
          this.macMiniStatus = { ...this.macMiniStatus, is_busy: false };
        } else {
          this.m2ProStatus = { ...this.m2ProStatus, is_busy: false };
        }
        this.emit("job:failed", job, `Dispatch timeout after ${ageMin}min`);
      }
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
    // FluxQ is synchronous — one job at a time. If we're already dispatching,
    // bail out to avoid double-dispatch and false "offline" health check failures.
    if (this.macMiniStatus.is_busy) {
      logger.debug("[QueueMaster] Mac-mini busy (generating), skipping tick");
      return;
    }

    const pending = this.repo.getPendingJobs("mac-mini", 1);
    if (pending.length === 0) return;

    // Poll FluxQ status to check if it's healthy (only when not already busy)
    try {
      this.macMiniStatus = await this.getWorkerStatus(await this.getLiveNodeConfig("mac-mini"), "mac-mini");
    } catch {
      logger.debug("[QueueMaster] FluxQ unreachable, skipping image jobs");
      return;
    }

    // Recheck after health poll — FluxQ now reports is_busy while async generation is running
    if (this.macMiniStatus.is_busy) {
      logger.debug("[QueueMaster] Mac-mini busy (generating), skipping after health check");
      return;
    }

    const job = pending[0];
    try {
      // VRAM coordination: ensure video worker has freed memory
      await this.ensureVramAvailable("mac-mini");

      // Mark dispatched before sending so job transitions: pending → dispatched → complete
      this.repo.markDispatched(job.id);
      this.macMiniStatus = { ...this.macMiniStatus, is_busy: true };
      this.emit("job:dispatched", job, "mac-mini" as TargetNode);
      logger.info(`[QueueMaster] Dispatching ${job.type} job ${job.id} → mac-mini (async, awaiting callback)`);

      await this.dispatchImageJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueMaster] Failed to dispatch ${job.id} to mac-mini: ${msg}`);
      this.repo.markFailed(job.id, msg);
    } finally {
      // Always clear busy flag whether the dispatch succeeded or failed
      this.macMiniStatus = { ...this.macMiniStatus, is_busy: false };
    }
  }

  // ── M2 Pro (Video/Audio jobs) — VRAM-aware ────────────────

  private async processM2Pro(): Promise<void> {
    // Check worker status first
    try {
      this.m2ProStatus = await this.getWorkerStatus(await this.getLiveNodeConfig("m2-pro"), "m2-pro");
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
      // VRAM coordination: ensure image worker has freed memory
      await this.ensureVramAvailable("m2-pro");

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

  private async getWorkerStatus(nodeConfig: WorkerNodeConfig, node: TargetNode): Promise<WorkerStatus> {
    const headers: Record<string, string> = {};
    if (nodeConfig.token) headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    // FluxQ uses /health (returns { model, model_loaded, ... }), M2 Pro uses /status
    const endpoint = node === "mac-mini" ? "/health" : "/status";
    const res = await fetch(`${nodeConfig.url}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

    const data = await res.json() as Record<string, unknown>;

    if (node === "mac-mini") {
      // FluxQ /health returns { model, model_loaded, is_busy, ... }
      return {
        is_busy: !!(data.is_busy as boolean),
        loaded_model: data.model_loaded ? (data.model as string) : null,
      };
    }

    return { is_busy: data.is_busy as boolean, loaded_model: (data.loaded_model as string) ?? null };
  }

  private async dispatchImageJob(job: MediaJob): Promise<void> {
    const { url, token } = await this.getLiveNodeConfig("mac-mini");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let endpoint: string;
    if (job.requiredModel === "flux-kontext") {
      endpoint = "/kontext-async";
    } else if (job.type === "img2img") {
      endpoint = "/img2img-async";
    } else {
      endpoint = "/generate-async";
    }

    const body: Record<string, unknown> = {
      job_id: job.id,
      callback_url: this.config.callbackUrl,
      prompt: job.payload.prompt,
      width: job.payload.width ?? 1024,
      height: job.payload.height ?? 576,
      steps: job.payload.steps,
      guidance_scale: job.payload.guidance_scale,
      seed: job.payload.seed,
      model: job.requiredModel,
    };

    if (job.type === "img2img" && job.payload.init_image) {
      body.image = job.payload.init_image;
      body.strength = job.payload.strength ?? 0.8;
    }

    // Async dispatch — FluxQ accepts immediately (202) and POSTs result to callback_url
    const res = await fetch(`${url}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`FluxQ ${endpoint} returned ${res.status}: ${text}`);
    }

    logger.info(`[QueueMaster] Image job ${job.id} accepted by FluxQ (202) — awaiting callback to ${this.config.callbackUrl}`);
  }

  private async dispatchVideoJob(job: MediaJob): Promise<void> {
    const { url, token } = await this.getLiveNodeConfig("m2-pro");
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
      pipeline: job.payload.pipeline ?? "distilled",
      negative_prompt: job.payload.negative_prompt,
      cfg_scale: job.payload.cfg_scale,
      num_inference_steps: job.payload.num_inference_steps,
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

  // ── Job Completion (called by webhook or directly) ───────

  async handleJobCompletion(
    jobId: string,
    result: { media_base64?: string; media_type?: string; metadata?: Record<string, unknown>; error?: string },
  ): Promise<void> {
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

    let resultUrl = (result.metadata?.result_url as string | undefined) ?? "";
    let galleryAssetId: string | undefined = result.metadata?.gallery_asset_id as string | undefined;

    // When media bytes are delivered directly (image jobs from mac-mini), write to disk and
    // create the gallery asset record here. Video jobs do this in the /complete webhook before
    // calling handleJobCompletion with media_base64 = undefined.
    if (result.media_base64 && result.media_type) {
      const galleryDir = this.config.galleryDir ?? path.join(os.homedir(), ".openzigs", "gallery");
      await fs.mkdir(galleryDir, { recursive: true });

      const ext = result.media_type === "image/png" ? ".png"
        : result.media_type === "image/jpeg" ? ".jpg"
        : result.media_type === "image/webp" ? ".webp"
        : ".bin";
      const filename = `${jobId}${ext}`;
      const filePath = path.join(galleryDir, filename);
      const buffer = Buffer.from(result.media_base64, "base64");
      await fs.writeFile(filePath, buffer);

      galleryAssetId = this.repo.createAsset({
        type: "image",
        filename,
        filePath,
        mimeType: result.media_type,
        fileSizeBytes: buffer.length,
        width: result.metadata?.width as number | undefined,
        height: result.metadata?.height as number | undefined,
        prompt: job.payload.prompt,
        model: (result.metadata?.model as string) ?? job.requiredModel,
        generationParams: result.metadata,
        source: "generated",
        jobId,
        projectId: job.projectId ?? undefined,
      });
      resultUrl = `/api/queue/assets/file/${filename}`;
      logger.info(`[QueueMaster] Asset saved: ${galleryAssetId} (${filename}, ${buffer.length} bytes)`);
    }

    this.repo.markComplete(jobId, resultUrl, result.metadata, galleryAssetId);

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
