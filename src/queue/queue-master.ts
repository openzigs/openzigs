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
import { AUDIO_JOB_TYPES } from "./types.js";
import { dispatchV2aJob } from "./v2a-client.js";
import type {
  MediaJob,
  QueueConfig,
  TargetNode,
  WorkerStatus,
  WorkerNodeConfig,
} from "./types.js";
import {
  isSegmentJob,
  handleSegmentCompletion,
  stitchSegments,
  registerSegmentJob,
  formatSegmentProgress,
  decomposeMultiSegmentJob,
} from "./multi-segment.js";
import {
  handleStageCompletion,
  handleStageFailure,
  markLipsyncSkipped,
  getPipelineState,
  setAudioDuration,
  computeWavDuration,
  estimateSpeechDuration,
} from "./talking-head-pipeline.js";

export interface QueueMasterEvents {
  "job:dispatched": [job: MediaJob, node: TargetNode];
  "job:complete": [job: MediaJob];
  "job:failed": [job: MediaJob, error: string];
  "job:progress": [
    jobId: string,
    progress: { stage?: string; progress?: number; message?: string },
  ];
  "project:complete": [projectId: string, total: number];
}

/** Aggregated status of all worker nodes. */
export interface NodeStatus {
  node: TargetNode | "music" | "music-studio" | "lipsync";
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
  private imageGenStatus: WorkerStatus = { is_busy: false, loaded_model: null };
  private m2ProStatus: WorkerStatus = { is_busy: false, loaded_model: null };
  /** Independent status tracking for the music sidecar (separate service from video). */
  private musicStatus: WorkerStatus = { is_busy: false, loaded_model: null };
  /** Independent status tracking for the music-studio voice2voice sidecar. */
  private musicStudioStatus: WorkerStatus = {
    is_busy: false,
    loaded_model: null,
  };
  /** Independent status tracking for the lip-sync sidecar (LatentSync). */
  private lipSyncStatus: WorkerStatus = {
    is_busy: false,
    loaded_model: null,
  };
  /** Counter to rate-limit repeated sidecar-unreachable warnings. */
  private musicStudioUnreachableCount = 0;
  private lipSyncUnreachableCount = 0;
  private sadTalkerUnreachableCount = 0;
  /** Independent status tracking for the SadTalker sidecar. */
  private sadTalkerStatus: WorkerStatus = {
    is_busy: false,
    loaded_model: null,
  };
  /** Prevents concurrent LTX ↔ LatentSync memory transitions on the shared M2 Pro. */
  private memoryTransitionActive = false;
  /** Prevents overlapping ticks when dispatch takes longer than pollIntervalMs. */
  private tickRunning = false;

  constructor(repo: MediaQueueRepository, config: QueueConfig) {
    super();
    this.repo = repo;
    this.config = config;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(
      `[QueueMaster] Starting push loop (interval=${this.config.pollIntervalMs}ms)`,
    );
    this.timer = setInterval(
      () => void this.tick(),
      this.config.pollIntervalMs,
    );
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

  /** Dynamically update the callback URL (e.g. when a Cloudflare Tunnel connects). */
  setCallbackUrl(url: string): void {
    const prev = this.config.callbackUrl;
    this.config.callbackUrl = url;
    logger.info(`[QueueMaster] Callback URL changed: ${prev} → ${url}`);
  }

  // ── Node Status ───────────────────────────────────────────

  /**
   * Get the live status of all worker nodes.
   * Polls each sidecar's /status (or /health for FluxQ) endpoint.
   */
  async getNodeStatuses(): Promise<NodeStatus[]> {
    const [imageGen, m2Pro, music, lipsync] = await Promise.allSettled([
      this.pollNodeStatus("image-gen"),
      this.pollNodeStatus("m2-pro"),
      this.pollMusicNodeStatus(),
      this.pollLipSyncNodeStatus(),
    ]);

    return [
      imageGen.status === "fulfilled"
        ? imageGen.value
        : {
            node: "image-gen" as TargetNode,
            reachable: false,
            is_busy: false,
            loaded_model: null,
            url: this.config.imageGen.url,
          },
      m2Pro.status === "fulfilled"
        ? m2Pro.value
        : {
            node: "m2-pro" as TargetNode,
            reachable: false,
            is_busy: false,
            loaded_model: null,
            url: this.config.m2Pro.url,
          },
      music.status === "fulfilled"
        ? music.value
        : {
            node: "music" as const,
            reachable: false,
            is_busy: false,
            loaded_model: null,
            url: "http://localhost:5009",
          },
      lipsync.status === "fulfilled"
        ? lipsync.value
        : {
            node: "lipsync" as const,
            reachable: false,
            is_busy: false,
            loaded_model: null,
            url: "http://localhost:5010",
          },
    ];
  }

  /** Poll the lip-sync sidecar's /health endpoint independently. */
  private async pollLipSyncNodeStatus(): Promise<NodeStatus> {
    const nodeConfig = await this.getLipSyncNodeConfig();
    try {
      const headers: Record<string, string> = {};
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/health`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

      const data = (await res.json()) as Record<string, unknown>;
      this.lipSyncStatus = {
        is_busy: !!(data.busy as boolean),
        loaded_model: (data.loaded_model as string) ?? null,
      };
      return {
        node: "lipsync" as const,
        reachable: true,
        ...this.lipSyncStatus,
        url: nodeConfig.url,
      };
    } catch {
      return {
        node: "lipsync" as const,
        reachable: false,
        is_busy: false,
        loaded_model: null,
        url: nodeConfig.url,
      };
    }
  }

  /** Poll the music sidecar's /status endpoint independently from other nodes. */
  private async pollMusicNodeStatus(): Promise<NodeStatus> {
    const nodeConfig = await this.getMusicNodeConfig();
    try {
      const headers: Record<string, string> = {};
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/status`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

      const data = (await res.json()) as Record<string, unknown>;
      this.musicStatus = {
        is_busy: !!(data.is_busy as boolean),
        loaded_model: (data.loaded_model as string) ?? null,
      };
      return {
        node: "music" as const,
        reachable: true,
        ...this.musicStatus,
        url: nodeConfig.url,
      };
    } catch {
      return {
        node: "music" as const,
        reachable: false,
        is_busy: false,
        loaded_model: null,
        url: nodeConfig.url,
      };
    }
  }

  private async pollNodeStatus(node: TargetNode): Promise<NodeStatus> {
    const nodeConfig = await this.getLiveNodeConfig(node);

    // FluxQ (image-gen) is single-threaded Python — it cannot respond to /health
    // while blocking on inference. If we know it's busy AND there are dispatched
    // jobs, return the cached status rather than hammering it with health checks.
    // If there are no dispatched jobs, the flag is stale — fall through and re-poll.
    if (node === "image-gen" && this.imageGenStatus.is_busy) {
      const dispatched = this.repo.listJobs({ status: "dispatched" });
      if (dispatched.some((j) => j.targetNode === "image-gen")) {
        return {
          node,
          reachable: true,
          ...this.imageGenStatus,
          url: nodeConfig.url,
        };
      }
      logger.info(
        "[QueueMaster] Image-gen busy flag stale in pollNodeStatus — re-polling worker",
      );
      this.imageGenStatus = { ...this.imageGenStatus, is_busy: false };
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
        if (
          dispatched.some(
            (j) =>
              j.targetNode === node &&
              j.dispatchedAt &&
              j.dispatchedAt.getTime() > recentCutoffMs,
          )
        ) {
          status.is_busy = true;
        }
      }
      if (node === "image-gen") this.imageGenStatus = status;
      else this.m2ProStatus = status;
      return { node, reachable: true, ...status, url: nodeConfig.url };
    } catch {
      return {
        node,
        reachable: false,
        is_busy: false,
        loaded_model: null,
        url: nodeConfig.url,
      };
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
    if (targetNode === "image-gen") {
      // About to dispatch image job — ensure video worker has unloaded
      if (this.m2ProStatus.loaded_model) {
        logger.info(
          `[QueueMaster] VRAM coordination: unloading ${this.m2ProStatus.loaded_model} from m2-pro before image dispatch`,
        );
        await this.unloadNode("m2-pro");
      }
    } else {
      // About to dispatch video job — ensure image worker has unloaded
      if (this.imageGenStatus.loaded_model) {
        logger.info(
          `[QueueMaster] VRAM coordination: unloading ${this.imageGenStatus.loaded_model} from image-gen before video dispatch`,
        );
        await this.unloadNode("image-gen");
      }
    }
  }

  /**
   * Memory coordination for LTX ↔ LatentSync on shared M2 Pro (32 GB).
   * Both models cannot coexist (~20 GB LTX + ~18 GB LatentSync > 32 GB).
   * Unloads the competing sidecar with retries before dispatching.
   *
   * @param target - Which sidecar we're about to dispatch to
   */
  async ensureSidecarMemory(target: "ltx" | "lipsync"): Promise<void> {
    if (this.memoryTransitionActive) {
      throw new Error("Memory transition already in progress");
    }
    this.memoryTransitionActive = true;
    try {
      if (target === "lipsync" && this.m2ProStatus.loaded_model) {
        // Best-effort: unload LTX before loading LatentSync (separate GPU processes)
        logger.info(
          `[QueueMaster] Memory coordination: unloading LTX (${this.m2ProStatus.loaded_model}) before lipsync dispatch`,
        );
        try {
          await this.unloadWithRetry("m2-pro", 3, 2_000);
        } catch (err) {
          logger.warn(
            `[QueueMaster] Memory coordination: LTX unload failed (${err instanceof Error ? err.message : err}) — proceeding with lipsync dispatch anyway`,
          );
        }
      } else if (target === "ltx" && this.lipSyncStatus.loaded_model) {
        // Best-effort: unload LatentSync before loading LTX
        logger.info(
          `[QueueMaster] Memory coordination: unloading LatentSync (${this.lipSyncStatus.loaded_model}) before video dispatch`,
        );
        try {
          await this.unloadLipSyncSidecar();
        } catch (err) {
          logger.warn(
            `[QueueMaster] Memory coordination: LatentSync unload failed (${err instanceof Error ? err.message : err}) — proceeding with video dispatch anyway`,
          );
        }
      }
    } finally {
      this.memoryTransitionActive = false;
    }
  }

  /**
   * Unload with retries. Used for memory coordination between competing sidecars.
   */
  private async unloadWithRetry(
    node: TargetNode,
    maxAttempts: number,
    backoffMs: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.unloadNode(node);
      if (result.ok) return;
      if (attempt < maxAttempts) {
        logger.warn(
          `[QueueMaster] Unload ${node} attempt ${attempt}/${maxAttempts} failed — retrying in ${backoffMs}ms`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw new Error(
      `Failed to unload ${node} after ${maxAttempts} attempts — memory may not be available`,
    );
  }

  /**
   * Unload the LatentSync lip-sync sidecar model.
   */
  private async unloadLipSyncSidecar(): Promise<void> {
    try {
      const nodeConfig = await this.getLipSyncNodeConfig();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/unload-model`, {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.warn(
          `[QueueMaster] LatentSync unload failed: ${res.status}`,
        );
        return;
      }

      this.lipSyncStatus = { is_busy: false, loaded_model: null };
      logger.info("[QueueMaster] LatentSync model unloaded for memory coordination");
    } catch (err) {
      // If LatentSync sidecar is unreachable, skip gracefully
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(
        `[QueueMaster] LatentSync sidecar unreachable during unload: ${msg}`,
      );
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
      if (node === "image-gen") {
        const ig = cfg.imageGen as Record<string, unknown> | undefined;
        if (
          ig?.mode === "network" &&
          typeof ig.networkNodeUrl === "string" &&
          ig.networkNodeUrl
        ) {
          return {
            url: ig.networkNodeUrl,
            token:
              typeof ig.networkNodeToken === "string"
                ? ig.networkNodeToken
                : this.config.imageGen.token,
          };
        }
      } else {
        const vg = cfg.videoGen as Record<string, unknown> | undefined;
        if (typeof vg?.networkNodeUrl === "string" && vg.networkNodeUrl) {
          return {
            url: vg.networkNodeUrl,
            token:
              typeof vg.networkNodeToken === "string"
                ? vg.networkNodeToken
                : this.config.m2Pro.token,
          };
        }
      }
    } catch {
      // config unreadable — fall through to startup config
    }
    return node === "image-gen" ? this.config.imageGen : this.config.m2Pro;
  }

  /**
   * Tell a specific node to unload its current model and free VRAM.
   * FluxQ uses POST /unload, M2 Pro worker uses POST /unload.
   */
  async unloadNode(
    node: TargetNode,
  ): Promise<{ ok: boolean; previous_model: string | null }> {
    const nodeConfig = await this.getLiveNodeConfig(node);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    try {
      const res = await fetch(`${nodeConfig.url}/unload`, {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn(
          `[QueueMaster] Unload ${node} failed: ${res.status} ${text}`,
        );
        return { ok: false, previous_model: null };
      }

      const result = (await res.json()) as {
        status?: string;
        model?: string;
        previous_model?: string;
      };
      const previousModel = result.previous_model ?? result.model ?? null;

      // Update cached status
      if (node === "image-gen")
        this.imageGenStatus = { is_busy: false, loaded_model: null };
      else this.m2ProStatus = { is_busy: false, loaded_model: null };

      logger.info(
        `[QueueMaster] Unloaded ${previousModel ?? "model"} from ${node}`,
      );
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
   * @param targetNode - Which node domain to activate ("image-gen" for images, "m2-pro" for video)
   * @param model - Optional model to preload (e.g. "flux-schnell", "ltx-2")
   */
  async switchActiveNode(
    targetNode: TargetNode,
    model?: string,
  ): Promise<{
    unloaded: { node: TargetNode; previous_model: string | null } | null;
    loaded: { node: TargetNode; model: string } | null;
  }> {
    // Unload the competing node
    const competingNode: TargetNode =
      targetNode === "image-gen" ? "m2-pro" : "image-gen";
    let unloaded: { node: TargetNode; previous_model: string | null } | null =
      null;

    const competingStatus =
      competingNode === "image-gen" ? this.imageGenStatus : this.m2ProStatus;
    if (competingStatus.loaded_model) {
      const result = await this.unloadNode(competingNode);
      if (result.ok) {
        unloaded = {
          node: competingNode,
          previous_model: result.previous_model,
        };
      }
    }

    // Preload model on target if requested
    let loaded: { node: TargetNode; model: string } | null = null;
    if (model && targetNode === "image-gen") {
      // FluxQ: POST /model { model: "flux-schnell" }
      try {
        const nodeConfig = await this.getLiveNodeConfig("image-gen");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (nodeConfig.token)
          headers["Authorization"] = `Bearer ${nodeConfig.token}`;

        const res = await fetch(`${nodeConfig.url}/model`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(120_000), // Model loads can take 30-60s
        });

        if (res.ok) {
          this.imageGenStatus = { is_busy: false, loaded_model: model };
          loaded = { node: targetNode, model };
          logger.info(`[QueueMaster] Preloaded ${model} on image-gen`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[QueueMaster] Failed to preload ${model} on image-gen: ${msg}`,
        );
      }
    }
    // M2 Pro video worker lazily loads on first job, no preload endpoint

    return { unloaded, loaded };
  }

  // ── Main Loop ─────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      this.recoverStuckJobs();
      await this.pollForStaleResults();
      await this.processNode("image-gen");
      await this.processNode("m2-pro");
      await this.processTtsJobs();
      await this.processMusicJobs();
      await this.processMusicStudioJobs();
      await this.processLipSyncJobs();
      await this.processSadTalkerJobs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueMaster] Tick error: ${msg}`);
    } finally {
      this.tickRunning = false;
    }
  }

  // ── Result Polling Fallback ───────────────────────────────

  /**
   * Poll workers for results of dispatched jobs that have been running longer
   * than expected.  This recovers results when the callback POST fails
   * (e.g. "No route to host" due to network asymmetry).
   *
   * FluxQ exposes GET /job-result/{id} which returns (and deletes) the stored
   * result payload.  We only poll after a grace period (3 min for images) to
   * avoid hammering the worker during normal generation.
   */
  private async pollForStaleResults(): Promise<void> {
    const graceMs = 3 * 60 * 1000; // 3 minutes — images take ~25-100s + callback retries
    const dispatched = this.repo.listJobs({ status: "dispatched", limit: 20 });
    const cutoff = Date.now() - graceMs;

    for (const job of dispatched) {
      if (!job.dispatchedAt || job.dispatchedAt.getTime() > cutoff) continue;

      const node = job.targetNode as TargetNode;
      try {
        // Music jobs use a separate sidecar — resolve the correct node config
        const nodeConfig =
          job.type === "txt2music"
            ? await this.getMusicNodeConfig()
            : await this.getLiveNodeConfig(node);
        const headers: Record<string, string> = {};
        if (nodeConfig.token)
          headers["Authorization"] = `Bearer ${nodeConfig.token}`;

        const res = await fetch(`${nodeConfig.url}/job-result/${job.id}`, {
          headers,
          signal: AbortSignal.timeout(5_000),
        });

        if (res.status === 404) continue; // still in progress or unknown
        if (!res.ok) continue;

        const result = (await res.json()) as {
          job_id?: string;
          status?: string;
          media_base64?: string;
          media_type?: string;
          metadata?: Record<string, unknown>;
          error?: string;
        };

        logger.info(
          `[QueueMaster] Poll recovered result for job ${job.id} from ${node}`,
        );
        await this.handleJobCompletion(job.id, result);
      } catch {
        // Worker unreachable — skip, will retry next tick
      }
    }
  }

  /**
   * Watchdog: find jobs stuck in 'dispatched' state longer than dispatchTimeoutMs
   * and fail them (which resets to 'pending' if retries remain). This recovers
   * jobs lost when a worker restarts mid-generation.
   */
  private recoverStuckJobs(): void {
    const timeoutMs = this.config.dispatchTimeoutMs ?? 45 * 60 * 1000; // 45 min default
    // Local sidecar jobs (remix/voice2voice) shouldn't be stuck more than 15 min —
    // Demucs stem separation of a full track takes ~2-5 min in the worst case.
    const localTimeoutMs = Math.min(timeoutMs, 15 * 60 * 1000);
    const dispatched = this.repo.listJobs({ status: "dispatched", limit: 50 });
    const now = Date.now();

    for (const job of dispatched) {
      if (!job.dispatchedAt) continue;
      const isLocal = job.targetNode === "local";
      const cutoff = now - (isLocal ? localTimeoutMs : timeoutMs);
      if (job.dispatchedAt.getTime() < cutoff) {
        const ageMin = Math.round((now - job.dispatchedAt.getTime()) / 60_000);
        logger.warn(
          `[QueueMaster] Job ${job.id} stuck in dispatched for ${ageMin}min — resetting for retry`,
        );
        this.repo.markFailed(
          job.id,
          `Dispatch timeout after ${ageMin}min (worker may have restarted)`,
        );
        // Clear the in-memory busy flag for the relevant node/sidecar
        if (job.targetNode === "image-gen") {
          this.imageGenStatus = { ...this.imageGenStatus, is_busy: false };
        } else if (job.targetNode === "local") {
          // "local" covers remix_* and voice2voice — all handled by music-studio sidecar
          this.musicStudioStatus = {
            ...this.musicStudioStatus,
            is_busy: false,
          };
        } else {
          this.m2ProStatus = { ...this.m2ProStatus, is_busy: false };
        }
        if (job.type === "txt2music") {
          this.musicStatus = { ...this.musicStatus, is_busy: false };
        }
        this.emit("job:failed", job, `Dispatch timeout after ${ageMin}min`);
      }
    }
  }

  private async processNode(node: TargetNode): Promise<void> {
    if (node === "m2-pro") {
      await this.processM2Pro();
    } else {
      await this.processImageGen();
    }
  }

  // ── Image Gen (Image jobs) ─────────────────────────────────

  private async processImageGen(): Promise<void> {
    // FluxQ is synchronous — one job at a time. If we're already dispatching,
    // bail out to avoid double-dispatch and false "offline" health check failures.
    // Guard against stale busy flag: if no dispatched jobs exist for image-gen,
    // the flag was set by a race between health-check and callback — clear it.
    if (this.imageGenStatus.is_busy) {
      const dispatched = this.repo.listJobs({ status: "dispatched" });
      const hasImageGenDispatch = dispatched.some(
        (j) => j.targetNode === "image-gen",
      );
      if (hasImageGenDispatch) {
        logger.debug("[QueueMaster] Image-gen busy (generating), skipping tick");
        return;
      }
      logger.info(
        "[QueueMaster] Image-gen busy flag stale (no dispatched jobs) — clearing",
      );
      this.imageGenStatus = { ...this.imageGenStatus, is_busy: false };
    }

    // Audio/music jobs (including remix) are handled by processMusicJobs() / processMusicStudioJobs() — exclude them here.
    const pending = this.repo
      .getPendingJobs("image-gen", 5)
      .filter((j) => !AUDIO_JOB_TYPES.has(j.type));
    if (pending.length === 0) return;

    // Poll FluxQ status to check if it's healthy (only when not already busy)
    try {
      this.imageGenStatus = await this.getWorkerStatus(
        await this.getLiveNodeConfig("image-gen"),
        "image-gen",
      );
    } catch {
      logger.debug("[QueueMaster] FluxQ unreachable, skipping image jobs");
      return;
    }

    // Recheck after health poll — FluxQ now reports is_busy while async generation is running
    if (this.imageGenStatus.is_busy) {
      logger.debug(
        "[QueueMaster] Image-gen busy (generating), skipping after health check",
      );
      return;
    }

    const job = pending[0];
    try {
      // VRAM coordination: ensure video worker has freed memory
      await this.ensureVramAvailable("image-gen");

      // Mark dispatched before sending so job transitions: pending → dispatched → complete
      this.repo.markDispatched(job.id);
      this.imageGenStatus = { ...this.imageGenStatus, is_busy: true };
      this.emit("job:dispatched", job, "image-gen" as TargetNode);
      logger.info(
        `[QueueMaster] Dispatching ${job.type} job ${job.id} → image-gen (async, awaiting callback)`,
      );

      await this.dispatchImageJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[QueueMaster] Failed to dispatch ${job.id} to image-gen: ${msg}`,
      );
      this.repo.markFailed(job.id, msg);
    } finally {
      // Always clear busy flag whether the dispatch succeeded or failed
      this.imageGenStatus = { ...this.imageGenStatus, is_busy: false };
    }
  }

  // ── M2 Pro (Video/Audio jobs) — VRAM-aware ────────────────

  private async processM2Pro(): Promise<void> {
    // Check worker status first
    try {
      this.m2ProStatus = await this.getWorkerStatus(
        await this.getLiveNodeConfig("m2-pro"),
        "m2-pro",
      );
    } catch {
      logger.debug("[QueueMaster] M2 Pro unreachable, skipping video jobs");
      return;
    }

    if (this.m2ProStatus.is_busy) {
      logger.debug("[QueueMaster] M2 Pro busy, skipping");
      return;
    }

    // VRAM-aware: prioritize jobs matching currently loaded model
    // Audio/music jobs are handled by processMusicJobs() / processMusicStudioJobs() — exclude them here.
    let pending: MediaJob[] = [];
    if (this.m2ProStatus.loaded_model) {
      pending = this.repo
        .getPendingJobsForModel("m2-pro", this.m2ProStatus.loaded_model, 5)
        .filter((j) => !AUDIO_JOB_TYPES.has(j.type) && j.type !== "lipsync" && j.type !== "sadtalker");
    }

    // If no jobs match loaded model, get any pending non-audio job
    if (pending.length === 0) {
      pending = this.repo
        .getPendingJobs("m2-pro", 5)
        .filter((j) => !AUDIO_JOB_TYPES.has(j.type) && j.type !== "lipsync" && j.type !== "sadtalker");
    }

    if (pending.length === 0) return;

    const job = pending[0];
    try {
      // VRAM coordination: ensure image worker has freed memory
      await this.ensureVramAvailable("m2-pro");
      // Memory coordination: ensure LatentSync has freed memory
      await this.ensureSidecarMemory("ltx");

      await this.dispatchVideoJob(job);
      this.repo.markDispatched(job.id);
      this.emit("job:dispatched", job, "m2-pro" as TargetNode);
      logger.info(
        `[QueueMaster] Dispatched ${job.type} job ${job.id} → m2-pro (model=${job.requiredModel})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[QueueMaster] Failed to dispatch ${job.id} to m2-pro: ${msg}`,
      );
      this.repo.markFailed(job.id, msg);
    }
  }

  // ── Music Sidecar (independent from M2 Pro video) ────────

  private async processMusicJobs(): Promise<void> {
    // Early exit if we already know the sidecar is busy
    if (this.musicStatus.is_busy) {
      logger.debug("[QueueMaster] Music sidecar busy, skipping");
      return;
    }

    // Poll music sidecar status directly (separate service from video worker)
    try {
      const nodeConfig = await this.getMusicNodeConfig();
      const headers: Record<string, string> = {};
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/status`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

      const data = (await res.json()) as Record<string, unknown>;
      this.musicStatus = {
        is_busy: !!(data.is_busy as boolean),
        loaded_model: (data.loaded_model as string) ?? null,
      };
    } catch {
      logger.debug(
        "[QueueMaster] Music sidecar unreachable, skipping music jobs",
      );
      return;
    }

    if (this.musicStatus.is_busy) {
      logger.debug("[QueueMaster] Music sidecar busy, skipping");
      return;
    }

    // Get pending txt2music jobs
    const pending = this.repo.getPendingJobsForModel("m2-pro", "ace-step", 1);
    if (pending.length === 0) return;

    const job = pending[0];
    try {
      this.repo.markDispatched(job.id);
      this.musicStatus = { ...this.musicStatus, is_busy: true };
      this.emit("job:dispatched", job, "m2-pro" as TargetNode);
      logger.info(
        `[QueueMaster] Dispatching txt2music job ${job.id} → music sidecar (async, awaiting callback)`,
      );

      await this.dispatchMusicJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[QueueMaster] Failed to dispatch music job ${job.id}: ${msg}`,
      );
      this.repo.markFailed(job.id, msg);
    } finally {
      // Clear in-memory flag — actual busy state is re-checked via /status poll on next tick
      this.musicStatus = { ...this.musicStatus, is_busy: false };
    }
  }

  // ── Audio Sidecar (TTS jobs) ──────────────────────────────

  private async processTtsJobs(): Promise<void> {
    // Get pending TTS jobs (target m2-pro but dispatched to audio sidecar)
    const pending = this.repo.getPendingJobsForModel("m2-pro", "f5-tts", 1);
    if (pending.length === 0) return;

    // Poll audio sidecar health
    try {
      const nodeConfig = await this.getAudioNodeConfig();
      const headers: Record<string, string> = {};
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/health`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
    } catch {
      logger.debug(
        "[QueueMaster] Audio sidecar unreachable, skipping TTS jobs",
      );
      return;
    }

    const job = pending[0];
    try {
      this.repo.markDispatched(job.id);
      this.emit("job:dispatched", job, "m2-pro" as TargetNode);
      logger.info(
        `[QueueMaster] Dispatching TTS job ${job.id} → audio sidecar`,
      );

      await this.dispatchTtsJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof Error && (err as Error & { retryable?: boolean }).retryable;
      if (retryable) {
        // Reset to pending so the next tick can retry
        this.repo.resetToPending(job.id);
        logger.debug(`[QueueMaster] TTS job ${job.id} deferred (sidecar busy)`);
      } else {
        logger.warn(
          `[QueueMaster] Failed to dispatch TTS job ${job.id}: ${msg}`,
        );
        this.repo.markFailed(job.id, msg);
      }
    }
  }

  // ── Music Studio Sidecar (voice2voice pipeline) ──────────

  private async processMusicStudioJobs(): Promise<void> {
    if (this.musicStudioStatus.is_busy) {
      logger.debug("[QueueMaster] Music-studio sidecar busy, skipping");
      return;
    }

    // Poll sidecar health
    try {
      const nodeConfig = await this.getMusicStudioNodeConfig();
      const headers: Record<string, string> = {};
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/health`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

      const data = (await res.json()) as Record<string, unknown>;
      this.musicStudioStatus = {
        is_busy: !!(data.is_busy as boolean),
        loaded_model: (data.loaded_model as string) ?? null,
      };
      this.musicStudioUnreachableCount = 0;
    } catch {
      this.musicStudioUnreachableCount++;
      // Only log every 10th attempt (~30s) to avoid spamming the log
      if (
        this.musicStudioUnreachableCount === 1 ||
        this.musicStudioUnreachableCount % 10 === 0
      ) {
        logger.warn(
          `[QueueMaster] Music-studio sidecar unreachable (port 5010) — skipping remix/voice2voice jobs. Start with: cd sidecars/music-studio && .venv/bin/python server.py --port 5010`,
        );
      }
      return;
    }

    if (this.musicStudioStatus.is_busy) {
      logger.debug("[QueueMaster] Music-studio sidecar busy, skipping");
      return;
    }

    // Get pending voice2voice jobs
    const pending = this.repo.getPendingJobsForModel("local", "seed-vc", 1);

    // Also check pending remix jobs (routed to local since the sidecar runs locally)
    const remixModels = ["htdemucs_6s", "basic-pitch", "matchering"] as const;
    let remixPending: MediaJob[] = [];
    if (pending.length === 0) {
      for (const model of remixModels) {
        remixPending = this.repo.getPendingJobsForModel("local", model, 1);
        if (remixPending.length > 0) break;
      }
    }

    const allPending = pending.length > 0 ? pending : remixPending;
    if (allPending.length === 0) return;

    const job = allPending[0];
    const isRemix = job.type.startsWith("remix_");
    try {
      this.repo.markDispatched(job.id);
      this.musicStudioStatus = { ...this.musicStudioStatus, is_busy: true };
      this.emit("job:dispatched", job, "local" as TargetNode);
      logger.info(
        `[QueueMaster] Dispatching ${job.type} job ${job.id} → music-studio sidecar`,
      );

      if (isRemix) {
        await this.dispatchRemixJob(job);
      } else {
        await this.dispatchMusicStudioJob(job);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[QueueMaster] Failed to dispatch music-studio job ${job.id}: ${msg}`,
      );
      this.repo.markFailed(job.id, msg);
    } finally {
      this.musicStudioStatus = { ...this.musicStudioStatus, is_busy: false };
    }
  }

  // ── Worker Communication ──────────────────────────────────

  private async getWorkerStatus(
    nodeConfig: WorkerNodeConfig,
    node: TargetNode,
  ): Promise<WorkerStatus> {
    const headers: Record<string, string> = {};
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    // FluxQ uses /health (returns { model, model_loaded, ... }), M2 Pro uses /status
    const endpoint = node === "image-gen" ? "/health" : "/status";
    const res = await fetch(`${nodeConfig.url}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;

    if (node === "image-gen") {
      // FluxQ /health returns { model, model_loaded, is_busy, ... }
      return {
        is_busy: !!(data.is_busy as boolean),
        loaded_model: data.model_loaded ? (data.model as string) : null,
      };
    }

    return {
      is_busy: data.is_busy as boolean,
      loaded_model: (data.loaded_model as string) ?? null,
    };
  }

  /**
   * When a worker sidecar runs on localhost (e.g. WSL), rewrite the
   * callback URL so the sidecar can reach back to the server.
   * WSL2 workers can't use `localhost` (points to WSL loopback) or the
   * LAN IP (often firewalled). Instead, use the Windows host IP on the
   * WSL virtual NIC (172.x.x.1) which is always reachable from WSL.
   */
  private resolveCallbackUrl(workerUrl: string): string {
    const host = new URL(workerUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      const wslHostIp = this.getWslHostIp();
      if (wslHostIp) {
        const parsed = new URL(this.config.callbackUrl);
        parsed.hostname = wslHostIp;
        return parsed.toString();
      }
    }
    return this.config.callbackUrl;
  }

  /** Find the Windows host IP on the WSL virtual NIC. */
  private getWslHostIp(): string | null {
    const interfaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs || !name.toLowerCase().includes("wsl")) continue;
      const v4 = addrs.find((a) => a.family === "IPv4" && !a.internal);
      if (v4) return v4.address;
    }
    return null;
  }

  private async dispatchImageJob(job: MediaJob): Promise<void> {
    const { url, token } = await this.getLiveNodeConfig("image-gen");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let endpoint: string;
    if (job.type === "img2img") {
      // Always use /img2img-async for img2img jobs — the sidecar handles
      // model selection internally.  /kontext-async only exists on dedicated
      // Flux Kontext servers (e.g. server.py) but not on server_cuda.py.
      endpoint = "/img2img-async";
    } else if (job.requiredModel === "flux-kontext") {
      endpoint = "/kontext-async";
    } else {
      endpoint = "/generate-async";
    }

    const isKontext =
      job.requiredModel === "flux-kontext" && job.type !== "img2img";

    // img2img jobs use /img2img-async on server_cuda.py which only knows
    // flux-schnell, flux-dev, and sdxl-base.  "flux-kontext" is the logical
    // default for img2img in the queue but is not in the CUDA registry, so
    // omit the model field and let the sidecar use its current/default model.
    const effectiveModel =
      job.type === "img2img" && job.requiredModel === "flux-kontext"
        ? undefined
        : job.requiredModel;

    // Kontext only accepts: prompt, image, seed, aspect_ratio.
    // Other models accept the full parameter set.
    const body: Record<string, unknown> = {
      job_id: job.id,
      callback_url: this.resolveCallbackUrl(url),
      prompt: job.payload.prompt,
      seed: job.payload.seed,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(!isKontext
        ? {
            width: job.payload.width ?? 1024,
            height: job.payload.height ?? 576,
            steps: job.payload.steps,
            guidance_scale: job.payload.guidance_scale,
          }
        : {}),
    };

    if (job.type === "img2img" && job.payload.init_image) {
      body.image = job.payload.init_image;
      if (!isKontext) {
        body.strength = job.payload.strength ?? 0.8;
        if (job.payload.mask) {
          body.mask = job.payload.mask;
        }
      }
    }

    if (job.payload.lora_paths?.length) {
      body.lora_paths = job.payload.lora_paths;
      if (job.payload.lora_scales?.length) {
        body.lora_scales = job.payload.lora_scales;
      }
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

    logger.info(
      `[QueueMaster] Image job ${job.id} accepted by FluxQ (202) — awaiting callback to ${this.config.callbackUrl}`,
    );
  }

  private async dispatchVideoJob(job: MediaJob): Promise<void> {
    const { url, token } = await this.getLiveNodeConfig("m2-pro");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const callbackUrl = this.resolveCallbackUrl(url);
    const body: Record<string, unknown> = {
      job_id: job.id,
      type: job.type,
      prompt: job.payload.prompt,
      width: job.payload.width ?? 768,
      height: job.payload.height ?? 512,
      num_frames: job.payload.num_frames ?? 97,
      fps: job.payload.fps ?? 24,
      model: job.requiredModel,
      callback_url: callbackUrl,
      pipeline: job.payload.pipeline ?? "distilled",
      negative_prompt: job.payload.negative_prompt,
      cfg_scale: job.payload.cfg_scale,
      num_inference_steps: job.payload.num_inference_steps,
      audio: job.payload.audio ?? false,
      tiling: job.payload.tiling ?? "auto",
      enhance_prompt: job.payload.enhance_prompt ?? false,
    };

    // Derive progress_url from callback_url for real-time progress streaming (#762)
    const progressUrl = callbackUrl.replace(
      /\/complete$/,
      "/progress",
    );
    if (progressUrl !== callbackUrl) {
      body.progress_url = progressUrl;
    }

    if (job.payload.model_repo) {
      body.model_repo = job.payload.model_repo;
    }

    if (job.payload.image_strength !== undefined) {
      body.image_strength = job.payload.image_strength;
    }

    if (job.payload.seed !== undefined) {
      body.seed = job.payload.seed;
    }

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

  private async dispatchMusicJob(job: MediaJob): Promise<void> {
    const nodeConfig = await this.getMusicNodeConfig();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    const callbackUrl = this.resolveCallbackUrl(nodeConfig.url);

    const body: Record<string, unknown> = {
      job_id: job.id,
      prompt: job.payload.prompt,
      duration_seconds: job.payload.duration_seconds ?? 30,
      lyrics: job.payload.lyrics,
      instrumental: job.payload.instrumental ?? false,
      steps: job.payload.steps ?? 20,
      model: job.requiredModel,
      seed: job.payload.seed,
      callback_url: callbackUrl,
    };

    const res = await fetch(`${nodeConfig.url}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Music sidecar /generate returned ${res.status}: ${text}`,
      );
    }
  }

  /**
   * Returns the WorkerNodeConfig for the music generation sidecar
   * by reading musicGen from ~/.openzigs/config.json. Falls back to m2Pro config.
   */
  private async getMusicNodeConfig(): Promise<WorkerNodeConfig> {
    try {
      const cfgPath = path.join(os.homedir(), ".openzigs", "config.json");
      const raw = await fs.readFile(cfgPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const mg = cfg.musicGen as Record<string, unknown> | undefined;
      if (typeof mg?.networkNodeUrl === "string" && mg.networkNodeUrl) {
        return {
          url: mg.networkNodeUrl,
          token:
            typeof mg.networkNodeToken === "string"
              ? mg.networkNodeToken
              : undefined,
        };
      }
    } catch {
      // config unreadable — fall through
    }
    // Default: music sidecar on localhost:5009
    return { url: "http://localhost:5009" };
  }

  /**
   * Dispatch a TTS job to the audio sidecar (/tts endpoint).
   * The audio sidecar returns WAV audio synchronously — we convert the
   * response to base64 and feed it into handleJobCompletion to advance
   * the talking-head pipeline.
   */
  private async dispatchTtsJob(job: MediaJob): Promise<void> {
    const nodeConfig = await this.getAudioNodeConfig();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    // F5-TTS voice cloning: dispatch to /f5tts with pre-resolved clips
    // Pipeline stores clips as { emotion, ref_audio_path, ref_text } (DB rows).
    // The sidecar expects { ref_audio (base64), ref_text, gen_text, emotion }.
    if (job.payload.f5tts_clips && job.payload.f5tts_clips.length > 0) {
      const resolvedClips = await Promise.all(
        (job.payload.f5tts_clips as Array<{ emotion?: string; ref_audio_path: string; ref_text: string; ref_audio?: string; gen_text?: string }>).map(async (clip) => {
          let refAudioB64 = clip.ref_audio ?? "";
          if (!refAudioB64 && clip.ref_audio_path) {
            const audioBytes = await fs.readFile(clip.ref_audio_path);
            refAudioB64 = audioBytes.toString("base64");
          }
          return {
            ref_audio: refAudioB64,
            ref_text: clip.ref_text,
            gen_text: clip.gen_text ?? job.payload.prompt ?? "",
            emotion: clip.emotion ?? "Regular",
            remove_silence: true,
          };
        }),
      );

      const f5body = {
        text: job.payload.prompt,
        clips: resolvedClips,
        speed: 1.0,
      };

      const res = await fetch(`${nodeConfig.url}/f5tts`, {
        method: "POST",
        headers,
        body: JSON.stringify(f5body),
        signal: AbortSignal.timeout(180_000), // F5-TTS can take ~60s on first run
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 409) {
          // Sidecar busy — don't fail the job, let it retry on next tick
          throw Object.assign(new Error(`Audio sidecar /f5tts busy (409)`), { retryable: true });
        }
        throw new Error(`Audio sidecar /f5tts returned ${res.status}: ${text}`);
      }

      const audioArrayBuffer = await res.arrayBuffer();
      const audioBase64 = Buffer.from(audioArrayBuffer).toString("base64");

      await this.handleJobCompletion(job.id, {
        media_base64: audioBase64,
        media_type: "audio/wav",
      });
      return;
    }

    const body: Record<string, unknown> = {
      text: job.payload.prompt,
      voice: job.payload.voice ?? "af_heart",
    };

    // Handle reference audio: decode base64 to a temp file and pass the path
    if (job.payload.reference_audio) {
      const tmpDir = path.join(os.homedir(), ".openzigs", "tmp");
      await fs.mkdir(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `ref-audio-${job.id}.wav`);
      const audioBuffer = Buffer.from(job.payload.reference_audio, "base64");
      await fs.writeFile(tmpFile, audioBuffer, { mode: 0o600 });
      body.ref_audio_path = tmpFile;
    }

    const res = await fetch(`${nodeConfig.url}/tts`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // TTS can take up to 2 minutes for long text
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Audio sidecar /tts returned ${res.status}: ${text}`);
    }

    // /tts returns audio/wav directly — convert to base64 for pipeline
    const audioArrayBuffer = await res.arrayBuffer();
    const audioBase64 = Buffer.from(audioArrayBuffer).toString("base64");

    await this.handleJobCompletion(job.id, {
      media_base64: audioBase64,
      media_type: "audio/wav",
    });
  }

  /**
   * Returns the WorkerNodeConfig for the audio sidecar (TTS/STT)
   * by reading audioSidecar from ~/.openzigs/config.json. Falls back to localhost:5006.
   */
  private async getAudioNodeConfig(): Promise<WorkerNodeConfig> {
    if (this.config.audioSidecar?.url) {
      return this.config.audioSidecar;
    }
    try {
      const cfgPath = path.join(os.homedir(), ".openzigs", "config.json");
      const raw = await fs.readFile(cfgPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const audio = cfg.audioSidecar as Record<string, unknown> | undefined;
      if (typeof audio?.networkNodeUrl === "string" && audio.networkNodeUrl) {
        return {
          url: audio.networkNodeUrl,
          token:
            typeof audio.networkNodeToken === "string"
              ? audio.networkNodeToken
              : undefined,
        };
      }
    } catch {
      // config unreadable — fall through
    }
    // Default: audio sidecar on localhost:5006
    return { url: "http://localhost:5006" };
  }

  private async dispatchMusicStudioJob(job: MediaJob): Promise<void> {
    const nodeConfig = await this.getMusicStudioNodeConfig();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    const callbackUrl = this.resolveCallbackUrl(nodeConfig.url);

    // Build progress_url by replacing /complete with /progress in the callback URL
    const progressUrl = callbackUrl.replace(/\/complete\/?$/, "/progress");

    // Resolve actual file path from media_assets so the sidecar doesn't have to
    // guess the filename from the UUID (asset filenames are not always UUID-based).
    let sourcePath: string | undefined;
    if (job.payload.source_asset_id) {
      const asset = this.repo.getAsset(job.payload.source_asset_id as string);
      if (typeof asset?.file_path === "string") {
        sourcePath = asset.file_path;
      }
    }

    const body: Record<string, unknown> = {
      job_id: job.id,
      source_asset_id: job.payload.source_asset_id,
      ...(sourcePath && { source_path: sourcePath }),
      voice_reference_id: job.payload.voice_reference_id,
      diffusion_steps: job.payload.diffusion_steps ?? 25,
      f0_condition: job.payload.f0_condition ?? false,
      pitch_shift: job.payload.pitch_shift ?? 0,
      vocal_volume: job.payload.vocal_volume ?? 1.0,
      instrumental_volume: job.payload.instrumental_volume ?? 1.0,
      output_format: job.payload.output_format ?? "wav",
      callback_url: callbackUrl,
      progress_url: progressUrl,
    };

    const res = await fetch(`${nodeConfig.url}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Music-studio sidecar /generate returned ${res.status}: ${text}`,
      );
    }
  }

  /** Dispatch a remix job (analyze / replace / master) to the music-studio sidecar. */
  private async dispatchRemixJob(job: MediaJob): Promise<void> {
    const nodeConfig = await this.getMusicStudioNodeConfig();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    let callbackUrl = this.config.callbackUrl;
    const sidecarHost = new URL(nodeConfig.url).hostname;
    if (sidecarHost === "localhost" || sidecarHost === "127.0.0.1") {
      const parsed = new URL(this.config.callbackUrl);
      parsed.hostname = "localhost";
      callbackUrl = parsed.toString();
    }
    const progressUrl = callbackUrl.replace(/\/complete\/?$/, "/progress");

    // Map job type to sidecar endpoint
    const endpointMap: Record<string, string> = {
      remix_analyze: "/remix/analyze",
      remix_replace: "/remix/replace-stem",
      remix_master: "/remix/master",
    };
    const endpoint = endpointMap[job.type];
    if (!endpoint) throw new Error(`Unknown remix job type: ${job.type}`);

    const body: Record<string, unknown> = {
      job_id: job.id,
      callback_url: callbackUrl,
      progress_url: progressUrl,
    };

    // Add type-specific fields from payload
    if (job.type === "remix_analyze") {
      body.source_asset_id = job.payload.source_asset_id;
      body.device = job.payload.device ?? "cpu";
      // Resolve the actual file path from the asset record so the sidecar
      // doesn't have to guess the filename from the UUID.
      if (job.payload.source_asset_id) {
        const asset = this.repo.getAsset(job.payload.source_asset_id as string);
        if (asset?.file_path) {
          body.source_path = asset.file_path;
        }
      }
    } else if (job.type === "remix_replace") {
      body.source_stem_url = job.payload.source_stem_url;
      body.target_instrument_id = job.payload.target_instrument_id;
      body.original_bpm = job.payload.original_bpm;
      body.original_key = job.payload.original_key;
    } else if (job.type === "remix_master") {
      body.stem_paths = job.payload.stem_paths;
      body.volumes = job.payload.volumes;
      body.muted = job.payload.muted;
      body.vibe = job.payload.vibe ?? "raw";
      if (job.payload.skip_mastering) {
        body.skip_mastering = true;
      }
    }

    const res = await fetch(`${nodeConfig.url}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Music-studio sidecar ${endpoint} returned ${res.status}: ${text}`,
      );
    }
  }

  /**
   * Returns the WorkerNodeConfig for the music-studio voice2voice sidecar
   * by reading musicStudio from ~/.openzigs/config.json.
   */
  private async getMusicStudioNodeConfig(): Promise<WorkerNodeConfig> {
    // Check QueueConfig first (may be set from default.json)
    if (this.config.musicStudio?.url) {
      return this.config.musicStudio;
    }
    try {
      const cfgPath = path.join(os.homedir(), ".openzigs", "config.json");
      const raw = await fs.readFile(cfgPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const ms = cfg.musicStudio as Record<string, unknown> | undefined;
      if (typeof ms?.networkNodeUrl === "string" && ms.networkNodeUrl) {
        return {
          url: ms.networkNodeUrl,
          token:
            typeof ms.networkNodeToken === "string"
              ? ms.networkNodeToken
              : undefined,
        };
      }
    } catch {
      // config unreadable — fall through
    }
    // Default: music-studio sidecar on localhost:5010
    return { url: "http://localhost:5010" };
  }

  // ── Lip Sync Sidecar (LatentSync) ─────────────────────────

  private async processLipSyncJobs(): Promise<void> {
    if (this.lipSyncStatus.is_busy) {
      logger.debug("[QueueMaster] Lip-sync sidecar busy, skipping");
      return;
    }

    // Poll sidecar health
    try {
      const nodeConfig = await this.getLipSyncNodeConfig();
      const headers: Record<string, string> = {};
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/health`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

      const data = (await res.json()) as Record<string, unknown>;
      this.lipSyncStatus = {
        is_busy: !!(data.busy as boolean),
        loaded_model: (data.loaded_model as string) ?? null,
      };
      this.lipSyncUnreachableCount = 0;
    } catch {
      this.lipSyncUnreachableCount++;
      if (
        this.lipSyncUnreachableCount === 1 ||
        this.lipSyncUnreachableCount % 10 === 0
      ) {
        logger.warn(
          `[QueueMaster] Lip-sync sidecar unreachable — skipping lipsync jobs. Start with: cd sidecars/lipsync && .venv/bin/python server.py --port 5008`,
        );
      }
      return;
    }

    if (this.lipSyncStatus.is_busy) {
      logger.debug("[QueueMaster] Lip-sync sidecar busy, skipping");
      return;
    }

    // Get pending lipsync jobs
    const pending = this.repo.listJobs({
      status: "pending",
      type: "lipsync",
      limit: 1,
    });
    if (pending.length === 0) return;

    const job = pending[0];
    try {
      // Memory coordination: unload LTX if loaded before dispatching to LatentSync
      await this.ensureSidecarMemory("lipsync");

      this.repo.markDispatched(job.id);
      this.lipSyncStatus = { ...this.lipSyncStatus, is_busy: true };
      this.emit("job:dispatched", job, "m2-pro" as TargetNode);
      logger.info(
        `[QueueMaster] Dispatching lipsync job ${job.id} → lip-sync sidecar`,
      );

      await this.dispatchLipSyncJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[QueueMaster] Failed to dispatch lipsync job ${job.id}: ${msg}`,
      );
      this.repo.markFailed(job.id, msg);
    } finally {
      this.lipSyncStatus = { ...this.lipSyncStatus, is_busy: false };
    }
  }

  private async dispatchLipSyncJob(job: MediaJob): Promise<void> {
    const nodeConfig = await this.getLipSyncNodeConfig();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    const callbackUrl = this.resolveCallbackUrl(nodeConfig.url);
    const progressUrl = callbackUrl.replace(/\/complete$/, "/progress");

    // Resolve video/audio data: prefer base64 payload, fall back to reading local files
    let videoData = job.payload.video_data;
    let audioData = job.payload.audio_data;

    if (!videoData && job.payload.video_path) {
      try {
        const buf = await fs.readFile(job.payload.video_path);
        videoData = buf.toString("base64");
      } catch (err) {
        logger.warn(`[QueueMaster] Failed to read video_path ${job.payload.video_path}: ${err}`);
      }
    }

    if (!audioData && job.payload.audio_path) {
      try {
        const buf = await fs.readFile(job.payload.audio_path);
        audioData = buf.toString("base64");
      } catch (err) {
        logger.warn(`[QueueMaster] Failed to read audio_path ${job.payload.audio_path}: ${err}`);
      }
    }

    const body: Record<string, unknown> = {
      job_id: job.id,
      callback_url: callbackUrl,
      progress_url: progressUrl,
      video_path: job.payload.video_path,
      audio_path: job.payload.audio_path,
      video_data: videoData,
      audio_data: audioData,
      inference_steps: job.payload.inference_steps ?? 20,
      guidance_scale: job.payload.guidance_scale_lipsync ?? 1.5,
      enable_deepcache: job.payload.enable_deepcache ?? true,
      model_version: job.payload.model_version ?? "v1.5",
    };

    const res = await fetch(`${nodeConfig.url}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Lip-sync sidecar /generate returned ${res.status}: ${text}`,
      );
    }
  }

  private async getLipSyncNodeConfig(): Promise<WorkerNodeConfig> {
    if (this.config.lipSync?.url) {
      return this.config.lipSync;
    }
    try {
      const cfgPath = path.join(os.homedir(), ".openzigs", "config.json");
      const raw = await fs.readFile(cfgPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const ls = cfg.lipSync as Record<string, unknown> | undefined;
      if (typeof ls?.networkNodeUrl === "string" && ls.networkNodeUrl) {
        return {
          url: ls.networkNodeUrl,
          token:
            typeof ls.networkNodeToken === "string"
              ? ls.networkNodeToken
              : undefined,
        };
      }
    } catch {
      // config unreadable — fall through
    }
    // Default: lip-sync sidecar on localhost:5010 (CUDA) or 5008 (MPS)
    return { url: "http://localhost:5010" };
  }

  // ── SadTalker Dispatch ────────────────────────────────────

  private async processSadTalkerJobs(): Promise<void> {
    // Poll sidecar health (always poll — local is_busy may be stale if sidecar restarted)
    try {
      const nodeConfig = await this.getSadTalkerNodeConfig();
      const headers: Record<string, string> = {};
      if (nodeConfig.token)
        headers["Authorization"] = `Bearer ${nodeConfig.token}`;

      const res = await fetch(`${nodeConfig.url}/health`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

      const data = (await res.json()) as Record<string, unknown>;
      this.sadTalkerStatus = {
        is_busy: !!(data.is_busy as boolean),
        loaded_model: (data.models_loaded as boolean) ? "sadtalker" : null,
      };
      this.sadTalkerUnreachableCount = 0;
    } catch {
      this.sadTalkerUnreachableCount++;
      if (
        this.sadTalkerUnreachableCount === 1 ||
        this.sadTalkerUnreachableCount % 10 === 0
      ) {
        logger.warn(
          `[QueueMaster] SadTalker sidecar unreachable — skipping sadtalker jobs. Start with: cd sidecars/sadtalker && python server_cuda.py --port 5011`,
        );
      }
      return;
    }

    if (this.sadTalkerStatus.is_busy) {
      logger.debug("[QueueMaster] SadTalker sidecar busy, skipping");
      return;
    }

    const pending = this.repo.listJobs({
      status: "pending",
      type: "sadtalker",
      limit: 1,
    });
    if (pending.length === 0) return;

    const job = pending[0];
    try {
      this.repo.markDispatched(job.id);
      this.sadTalkerStatus = { ...this.sadTalkerStatus, is_busy: true };
      this.emit("job:dispatched", job, "m2-pro" as TargetNode);
      logger.info(
        `[QueueMaster] Dispatching sadtalker job ${job.id} → SadTalker sidecar`,
      );

      await this.dispatchSadTalkerJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[QueueMaster] Failed to dispatch sadtalker job ${job.id}: ${msg}`,
      );
      this.repo.markFailed(job.id, msg);
    } finally {
      this.sadTalkerStatus = { ...this.sadTalkerStatus, is_busy: false };
    }
  }

  private async dispatchSadTalkerJob(job: MediaJob): Promise<void> {
    const nodeConfig = await this.getSadTalkerNodeConfig();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (nodeConfig.token)
      headers["Authorization"] = `Bearer ${nodeConfig.token}`;

    const callbackUrl = this.resolveCallbackUrl(nodeConfig.url);
    const progressUrl = callbackUrl.replace(/\/complete$/, "/progress");

    // Resolve audio data
    let audioData = job.payload.audio_data;
    if (!audioData && job.payload.audio_path) {
      try {
        const buf = await fs.readFile(job.payload.audio_path);
        audioData = buf.toString("base64");
      } catch (err) {
        logger.warn(`[QueueMaster] Failed to read audio_path ${job.payload.audio_path}: ${err}`);
      }
    }

    const body: Record<string, unknown> = {
      job_id: job.id,
      callback_url: callbackUrl,
      progress_url: progressUrl,
      image_data: job.payload.init_image,
      audio_data: audioData,
      audio_path: job.payload.audio_path,
      size: job.payload.sadtalker_size ?? 512,
      preprocess: job.payload.sadtalker_preprocess ?? "crop",
      enhancer: job.payload.sadtalker_enhancer ?? "gfpgan",
      still_mode: job.payload.sadtalker_still ?? true,
      expression_scale: job.payload.sadtalker_expression_scale ?? 1.0,
      pose_style: job.payload.sadtalker_pose_style ?? 0,
    };

    const res = await fetch(`${nodeConfig.url}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `SadTalker sidecar /generate returned ${res.status}: ${text}`,
      );
    }
  }

  private async getSadTalkerNodeConfig(): Promise<WorkerNodeConfig> {
    if (this.config.sadTalker?.url) {
      return this.config.sadTalker;
    }
    try {
      const cfgPath = path.join(os.homedir(), ".openzigs", "config.json");
      const raw = await fs.readFile(cfgPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const st = cfg.sadTalker as Record<string, unknown> | undefined;
      if (typeof st?.networkNodeUrl === "string" && st.networkNodeUrl) {
        return {
          url: st.networkNodeUrl,
          token:
            typeof st.networkNodeToken === "string"
              ? st.networkNodeToken
              : undefined,
        };
      }
    } catch {
      // config unreadable — fall through
    }
    return { url: "http://localhost:5011" };
  }

  // ── Progress Reporting ────────────────────────────────────

  reportProgress(
    jobId: string,
    progress: { stage?: string; progress?: number; message?: string },
  ): void {
    this.emit("job:progress", jobId, progress);
    logger.debug(
      `[QueueMaster] Job ${jobId} progress: stage=${progress.stage} ${progress.progress ?? ""}% ${progress.message ?? ""}`,
    );
  }

  // ── Job Completion (called by webhook or directly) ───────

  async handleJobCompletion(
    jobId: string,
    result: {
      media_base64?: string;
      media_type?: string;
      metadata?: Record<string, unknown>;
      error?: string;
    },
  ): Promise<void> {
    const job = this.repo.getJob(jobId);
    if (!job) {
      logger.warn(`[QueueMaster] Completion for unknown job: ${jobId}`);
      return;
    }

    // Clear the in-memory busy flag so the tick loop can dispatch the next job.
    // Without this, imageGenStatus.is_busy stays true forever after the health-check
    // cache sets it, because processImageGen() early-returns without re-polling.
    if (job.targetNode === "image-gen") {
      this.imageGenStatus = { ...this.imageGenStatus, is_busy: false };
    } else if (job.targetNode === "m2-pro") {
      this.m2ProStatus = { ...this.m2ProStatus, is_busy: false };
    }
    if (job.type === "txt2music") {
      this.musicStatus = { ...this.musicStatus, is_busy: false };
    }
    if (job.type === "voice2voice" || job.type.startsWith("remix_")) {
      this.musicStudioStatus = { ...this.musicStudioStatus, is_busy: false };
    }

    if (result.error) {
      this.repo.markFailed(jobId, result.error);
      this.emit("job:failed", job, result.error);
      logger.info(`[QueueMaster] Job ${jobId} failed: ${result.error}`);
      return;
    }

    // ── Talking-Head Pipeline Routing ─────────────────────────
    // Check pipeline BEFORE multi-segment — pipeline segment sub-jobs have both
    // segmentIndex and pipeline_id, and should be handled by the pipeline handler
    // which manages segment ↔ stage coordination.
    if (job.payload.pipeline_id && job.payload.pipeline_type === "talking-head") {
      try {
        await this.handleTalkingHeadPipelineStage(job, result);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[QueueMaster] Talking-head pipeline failed for job ${jobId}: ${msg}`,
        );
        handleStageFailure(job.payload.pipeline_id, msg);
        // Fall through to normal completion
      }
    }

    // ── Multi-Segment Routing ────────────────────────────────
    // If this is a segment sub-job (non-pipeline), route to multi-segment handler
    if (isSegmentJob(job) && result.media_base64) {
      try {
        const videoBytes = Buffer.from(result.media_base64, "base64");
        const segResult = await handleSegmentCompletion(job, videoBytes, () =>
          this.getLiveNodeConfig("m2-pro"),
        );

        // Mark this segment job as complete
        this.repo.markComplete(jobId, "", result.metadata);

        if (segResult.done) {
          // All segments done — stitch and complete the parent
          logger.info(
            `[QueueMaster] All segments complete for parent ${segResult.parentJobId} — stitching`,
          );
          const stitchedVideo = await stitchSegments(segResult.parentJobId);
          const stitchedBase64 = stitchedVideo.toString("base64");

          // Complete the parent job with stitched video
          await this.handleJobCompletion(segResult.parentJobId, {
            media_base64: stitchedBase64,
            media_type: "video/mp4",
            metadata: {
              ...((result.metadata as Record<string, unknown>) ?? {}),
              multi_segment: true,
              total_segments: job.payload.totalSegments,
            },
          });
        } else {
          // Create next segment job
          const nextSeg = segResult.nextSegment;
          const nextJob = this.repo.createJob({
            type: nextSeg.type,
            payload: nextSeg.payload,
            model: job.requiredModel,
            priority: job.priority,
          });
          registerSegmentJob(
            segResult.parentJobId,
            nextSeg.payload.segmentIndex!,
            nextJob.id,
          );

          // Report aggregate progress
          this.reportProgress(segResult.parentJobId, {
            stage: "generating",
            message: formatSegmentProgress(
              nextSeg.payload.segmentIndex!,
              nextSeg.payload.totalSegments!,
            ),
          });

          logger.info(
            `[QueueMaster] Created segment ${nextSeg.payload.segmentIndex! + 1}/${nextSeg.payload.totalSegments} job ${nextJob.id} for parent ${segResult.parentJobId}`,
          );
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[QueueMaster] Multi-segment handling failed for job ${jobId}: ${msg}`,
        );
        // Mark the parent job as failed if we have a parentJobId
        if (job.payload.parentJobId) {
          const parentJob = this.repo.getJob(job.payload.parentJobId);
          if (parentJob) {
            this.repo.markFailed(
              job.payload.parentJobId,
              `Segment ${job.payload.segmentIndex} failed: ${msg}`,
            );
            this.emit(
              "job:failed",
              parentJob,
              `Segment ${job.payload.segmentIndex} failed: ${msg}`,
            );
          }
        }
        return;
      }
    }

    let resultUrl = (result.metadata?.result_url as string | undefined) ?? "";
    let galleryAssetId: string | undefined = result.metadata
      ?.gallery_asset_id as string | undefined;

    // When media bytes are delivered directly (image jobs from image-gen), write to disk and
    // create the gallery asset record here. Video jobs do this in the /complete webhook before
    // calling handleJobCompletion with media_base64 = undefined.
    if (result.media_base64 && result.media_type) {
      const galleryDir =
        this.config.galleryDir ??
        path.join(os.homedir(), ".openzigs", "gallery");
      await fs.mkdir(galleryDir, { recursive: true });

      const extMap: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "audio/wav": ".wav",
        "audio/mp3": ".mp3",
      };
      const ext = extMap[result.media_type] ?? ".bin";
      const assetType: "image" | "video" | "audio" =
        result.media_type.startsWith("video/")
          ? "video"
          : result.media_type.startsWith("audio/")
            ? "audio"
            : "image";
      const safeJobId = String(jobId).replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${safeJobId}${ext}`;
      const filePath = path.join(galleryDir, filename);
      const buffer = Buffer.from(result.media_base64, "base64");
      await fs.writeFile(filePath, buffer);

      galleryAssetId = this.repo.createAsset({
        type: assetType,
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
      logger.info(
        `[QueueMaster] Asset saved: ${galleryAssetId} (${filename}, ${buffer.length} bytes)`,
      );
    }

    this.repo.markComplete(jobId, resultUrl, result.metadata, galleryAssetId);

    const updatedJob = this.repo.getJob(jobId)!;
    this.emit("job:complete", updatedJob);
    logger.info(`[QueueMaster] Job ${jobId} complete (type=${job.type})`);

    // WS1-A (#925): post-process video jobs with audio_mode='auto' through
    // the v2a (MMAudio) sidecar. Fire-and-forget; failures are logged but
    // never block the original video job's completion semantics.
    try {
      const audioMode = (job.payload as { audio_mode?: string }).audio_mode;
      const isVideoJob =
        job.type === "txt2video" || job.type === "img2video";
      if (isVideoJob && audioMode === "auto" && result.media_type?.startsWith("video/")) {
        const videoPath = (result.metadata?.video_path as string | undefined) ?? undefined;
        const fps = (job.payload.fps as number | undefined) ?? 24;
        const numFrames = (job.payload.num_frames as number | undefined) ?? 121;
        const durationSec = Math.max(1, Math.round(numFrames / fps));
        const audioPrompt = (job.payload as { audio_prompt?: string }).audio_prompt;
        if (videoPath) {
          void dispatchV2aJob({
            jobId: `${jobId}__v2a`,
            videoPath,
            durationSec,
            prompt: audioPrompt,
            seed: job.payload.seed,
          }).catch((err) => {
            logger.warn(
              `[QueueMaster] v2a dispatch for ${jobId} threw: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        } else {
          logger.debug(
            `[QueueMaster] v2a skipped for ${jobId}: no video_path in result metadata`,
          );
        }
      }
    } catch (err) {
      logger.warn(
        `[QueueMaster] v2a post-processing hook errored for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check if entire project is done
    if (job.projectId) {
      const status = this.repo.isProjectComplete(job.projectId);
      if (status.complete) {
        this.emit("project:complete", job.projectId, status.total);
        logger.info(
          `[QueueMaster] Project ${job.projectId} complete (${status.total} jobs)`,
        );
      }
    }

    // Immediately try to dispatch the next pending job rather than waiting
    // for the next poll interval (which can be several seconds).
    void this.tick();
  }

  // ── Talking-Head Pipeline ──────────────────────────────────

  /**
   * Handle a talking-head pipeline stage completion. Chains TTS → Video → LipSync
   * with memory coordination between LTX and LatentSync.
   *
   * Multi-segment aware: when the video stage requires > 4s, decomposes into
   * chained 4s segments, stitches via ffmpeg xfade, then advances to lipsync
   * on the final stitched video.
   */
  private async handleTalkingHeadPipelineStage(
    job: MediaJob,
    result: {
      media_base64?: string;
      media_type?: string;
      metadata?: Record<string, unknown>;
      error?: string;
    },
  ): Promise<void> {
    const pipelineId = job.payload.pipeline_id!;
    const stageName = job.payload.pipeline_stage ?? "unknown";

    if (result.error) {
      handleStageFailure(pipelineId, result.error);
      this.repo.markFailed(job.id, `Pipeline stage "${stageName}" failed: ${result.error}`);
      this.emit("job:failed", job, result.error);
      return;
    }

    // ── Multi-Segment Sub-Job Within Pipeline ────────────────
    // If this is a segment sub-job chained within the pipeline video stage,
    // handle segment tracking and chain to next segment or stitch.
    if (isSegmentJob(job) && result.media_base64) {
      try {
        const videoBytes = Buffer.from(result.media_base64, "base64");
        const segResult = await handleSegmentCompletion(job, videoBytes, () =>
          this.getLiveNodeConfig("m2-pro"),
        );

        // Mark this segment job as complete
        this.repo.markComplete(job.id, "", result.metadata);

        if (segResult.done) {
          // All segments done — stitch
          logger.info(
            `[QueueMaster] Pipeline ${pipelineId}: all video segments complete — stitching`,
          );
          this.reportProgress(job.id, {
            stage: "video",
            message: "Stitching video segments...",
          });

          const stitchedVideo = await stitchSegments(segResult.parentJobId);
          const stitchedBase64 = stitchedVideo.toString("base64");

          // Store stitched result in pipeline state as the video stage result
          const { nextJob: lipsyncJob, done } = handleStageCompletion(
            pipelineId,
            segResult.parentJobId, // use the parent video job ID as the completed stage
            {
              media_base64: stitchedBase64,
              media_type: "video/mp4",
            },
          );

          if (done) {
            logger.info(
              `[QueueMaster] Talking-head pipeline ${pipelineId} complete after stitching`,
            );
            return;
          }

          if (!lipsyncJob) return;

          // Advance to lipsync — memory coordination
          if (lipsyncJob.payload.pipeline_stage === "lipsync") {
            try {
              await this.ensureSidecarMemory("lipsync");
            } catch {
              try {
                const nodeConfig = await this.getLipSyncNodeConfig();
                const headers: Record<string, string> = {};
                if (nodeConfig.token)
                  headers["Authorization"] = `Bearer ${nodeConfig.token}`;
                await fetch(`${nodeConfig.url}/health`, {
                  headers,
                  signal: AbortSignal.timeout(5_000),
                });
              } catch {
                markLipsyncSkipped(pipelineId);
                logger.info(
                  `[QueueMaster] LipSync sidecar unavailable — pipeline ${pipelineId} degrading to TTS + Video only`,
                );
                return;
              }
            }
          }

          // Enqueue the lipsync job
          const nextMediaJob = this.repo.createJob({
            type: lipsyncJob.type,
            payload: lipsyncJob.payload,
            model: lipsyncJob.model,
            projectId: getPipelineState(pipelineId)?.config.projectId,
            priority: job.priority,
          });

          logger.info(
            `[QueueMaster] Pipeline ${pipelineId}: enqueued stage "${lipsyncJob.payload.pipeline_stage}" → job ${nextMediaJob.id}`,
          );
          this.reportProgress(nextMediaJob.id, {
            stage: lipsyncJob.payload.pipeline_stage,
            message: `Starting stage "${lipsyncJob.payload.pipeline_stage}"...`,
          });
          void this.tick();
        } else {
          // Create next segment job — keep pipeline metadata
          const nextSeg = segResult.nextSegment;
          const nextJob = this.repo.createJob({
            type: nextSeg.type,
            payload: {
              ...nextSeg.payload,
              pipeline_id: pipelineId,
              pipeline_type: "talking-head",
              pipeline_stage: "video",
            },
            model: job.requiredModel,
            priority: job.priority,
          });
          registerSegmentJob(
            segResult.parentJobId,
            nextSeg.payload.segmentIndex!,
            nextJob.id,
          );

          this.reportProgress(pipelineId, {
            stage: "video",
            message: formatSegmentProgress(
              nextSeg.payload.segmentIndex!,
              nextSeg.payload.totalSegments!,
            ),
          });

          logger.info(
            `[QueueMaster] Pipeline ${pipelineId}: segment ${nextSeg.payload.segmentIndex! + 1}/${nextSeg.payload.totalSegments} → job ${nextJob.id}`,
          );
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[QueueMaster] Pipeline ${pipelineId} multi-segment failed: ${msg}`,
        );
        handleStageFailure(pipelineId, `Multi-segment stitching failed: ${msg}`);
        this.repo.markFailed(job.id, msg);
        this.emit("job:failed", job, msg);
        return;
      }
    }

    // ── Normal Stage Completion ──────────────────────────────

    // Mark current job complete
    const resultUrl = (result.metadata?.result_url as string | undefined) ?? "";
    this.repo.markComplete(job.id, resultUrl, result.metadata);
    this.emit("job:complete", this.repo.getJob(job.id)!);

    // Report pipeline progress
    this.reportProgress(job.id, {
      stage: stageName,
      message: `Pipeline stage "${stageName}" complete ✓`,
    });

    // After TTS (speech) completes, compute audio duration and store in pipeline state
    if (stageName === "speech" && result.media_base64) {
      const wavDuration = computeWavDuration(result.media_base64);
      if (wavDuration !== undefined && wavDuration > 0) {
        setAudioDuration(pipelineId, wavDuration);
        logger.info(
          `[QueueMaster] Pipeline ${pipelineId}: TTS audio duration = ${wavDuration.toFixed(1)}s`,
        );
      } else {
        // Fallback: estimate from speech text
        const state = getPipelineState(pipelineId);
        if (state?.config.text) {
          const est = estimateSpeechDuration(state.config.text);
          setAudioDuration(pipelineId, est);
          logger.info(
            `[QueueMaster] Pipeline ${pipelineId}: estimated audio duration = ${est.toFixed(1)}s (WAV parse failed)`,
          );
        }
      }
    }

    // Advance pipeline to next stage
    const { nextJob, done } = handleStageCompletion(
      pipelineId,
      job.id,
      {
        media_base64: result.media_base64,
        media_type: result.media_type,
        file_path: result.metadata?.file_path as string | undefined,
      },
    );

    if (done) {
      logger.info(
        `[QueueMaster] Talking-head pipeline ${pipelineId} complete`,
      );
      return;
    }

    if (!nextJob) return;

    // If next stage is sadtalker, check sidecar availability
    if (nextJob.payload.pipeline_stage === "sadtalker") {
      try {
        const nodeConfig = await this.getSadTalkerNodeConfig();
        const headers: Record<string, string> = {};
        if (nodeConfig.token)
          headers["Authorization"] = `Bearer ${nodeConfig.token}`;
        await fetch(`${nodeConfig.url}/health`, {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        logger.warn(
          `[QueueMaster] SadTalker sidecar unavailable — pipeline ${pipelineId} cannot proceed`,
        );
        return;
      }
    }

    // If next stage is lipsync, do memory coordination first
    if (nextJob.payload.pipeline_stage === "lipsync") {
      try {
        await this.ensureSidecarMemory("lipsync");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[QueueMaster] Memory coordination failed for pipeline ${pipelineId}: ${msg}`,
        );
        // Check if lipsync sidecar is reachable
        try {
          const nodeConfig = await this.getLipSyncNodeConfig();
          const headers: Record<string, string> = {};
          if (nodeConfig.token)
            headers["Authorization"] = `Bearer ${nodeConfig.token}`;
          await fetch(`${nodeConfig.url}/health`, {
            headers,
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          // Sidecar unreachable — skip lipsync gracefully
          markLipsyncSkipped(pipelineId);
          logger.info(
            `[QueueMaster] LipSync sidecar unavailable — pipeline ${pipelineId} degrading to TTS + Video only`,
          );
          return;
        }
      }
    }

    // If next stage is video (LTX), ensure lipsync is unloaded
    if (nextJob.payload.pipeline_stage === "video") {
      try {
        await this.ensureSidecarMemory("ltx");
      } catch {
        // Non-fatal — LTX may work even if lipsync unload fails
      }
    }

    // ── Multi-Segment Decomposition for Video Stage ──────────
    // If the video stage requires > 4s, decompose into chained segments
    if (
      nextJob.payload.pipeline_stage === "video" &&
      nextJob.payload.video_duration &&
      nextJob.payload.video_duration > 4
    ) {
      logger.info(
        `[QueueMaster] Pipeline ${pipelineId}: video stage requires ${nextJob.payload.video_duration}s — decomposing into multi-segment`,
      );

      // Create a temporary "parent" job to anchor the segment tracker
      const parentVideoJob = this.repo.createJob({
        type: nextJob.type,
        payload: nextJob.payload,
        model: nextJob.model,
        projectId: getPipelineState(pipelineId)?.config.projectId,
        priority: job.priority,
      });

      // Decompose into segments
      const decomposed = decomposeMultiSegmentJob(parentVideoJob);
      if (decomposed) {
        // Mark parent as "dispatched" so the tick doesn't pick it up as a pending job
        this.repo.markDispatched(parentVideoJob.id);
        // Create first segment
        const firstSegJob = this.repo.createJob({
          type: decomposed.type,
          payload: {
            ...decomposed.payload,
            pipeline_id: pipelineId,
            pipeline_type: "talking-head",
            pipeline_stage: "video",
          },
          model: nextJob.model,
          projectId: getPipelineState(pipelineId)?.config.projectId,
          priority: job.priority,
        });
        registerSegmentJob(parentVideoJob.id, 0, firstSegJob.id);

        this.reportProgress(pipelineId, {
          stage: "video",
          message: formatSegmentProgress(0, decomposed.totalSegments),
        });

        logger.info(
          `[QueueMaster] Pipeline ${pipelineId}: created ${decomposed.totalSegments} segment plan, first segment → job ${firstSegJob.id}`,
        );
        void this.tick();
        return;
      }
    }

    // Enqueue next stage job (single segment or non-video)
    const nextMediaJob = this.repo.createJob({
      type: nextJob.type,
      payload: nextJob.payload,
      model: nextJob.model,
      projectId: getPipelineState(pipelineId)?.config.projectId,
      priority: job.priority,
    });

    logger.info(
      `[QueueMaster] Pipeline ${pipelineId}: enqueued stage "${nextJob.payload.pipeline_stage}" → job ${nextMediaJob.id}`,
    );

    // Report progress for the new stage
    this.reportProgress(nextMediaJob.id, {
      stage: nextJob.payload.pipeline_stage,
      message: `Starting stage "${nextJob.payload.pipeline_stage}"...`,
    });

    // Trigger immediate dispatch
    void this.tick();
  }
}
