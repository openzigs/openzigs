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
  "job:progress": [
    jobId: string,
    progress: { stage?: string; progress?: number; message?: string },
  ];
  "project:complete": [projectId: string, total: number];
}

/** Aggregated status of all worker nodes. */
export interface NodeStatus {
  node: TargetNode | "music" | "music-studio";
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
  /** Independent status tracking for the music sidecar (separate service from video). */
  private musicStatus: WorkerStatus = { is_busy: false, loaded_model: null };
  /** Independent status tracking for the music-studio voice2voice sidecar. */
  private musicStudioStatus: WorkerStatus = {
    is_busy: false,
    loaded_model: null,
  };
  /** Counter to rate-limit repeated sidecar-unreachable warnings. */
  private musicStudioUnreachableCount = 0;

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

  // ── Node Status ───────────────────────────────────────────

  /**
   * Get the live status of all worker nodes.
   * Polls each sidecar's /status (or /health for FluxQ) endpoint.
   */
  async getNodeStatuses(): Promise<NodeStatus[]> {
    const [macMini, m2Pro, music] = await Promise.allSettled([
      this.pollNodeStatus("mac-mini"),
      this.pollNodeStatus("m2-pro"),
      this.pollMusicNodeStatus(),
    ]);

    return [
      macMini.status === "fulfilled"
        ? macMini.value
        : {
            node: "mac-mini" as TargetNode,
            reachable: false,
            is_busy: false,
            loaded_model: null,
            url: this.config.macMini.url,
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
    ];
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

    // FluxQ (mac-mini) is single-threaded Python — it cannot respond to /health
    // while blocking on inference. If we know it's busy AND there are dispatched
    // jobs, return the cached status rather than hammering it with health checks.
    // If there are no dispatched jobs, the flag is stale — fall through and re-poll.
    if (node === "mac-mini" && this.macMiniStatus.is_busy) {
      const dispatched = this.repo.listJobs({ status: "dispatched" });
      if (dispatched.some((j) => j.targetNode === "mac-mini")) {
        return {
          node,
          reachable: true,
          ...this.macMiniStatus,
          url: nodeConfig.url,
        };
      }
      logger.info(
        "[QueueMaster] Mac-mini busy flag stale in pollNodeStatus — re-polling worker",
      );
      this.macMiniStatus = { ...this.macMiniStatus, is_busy: false };
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
      if (node === "mac-mini") this.macMiniStatus = status;
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
    if (targetNode === "mac-mini") {
      // About to dispatch image job — ensure video worker has unloaded
      if (this.m2ProStatus.loaded_model) {
        logger.info(
          `[QueueMaster] VRAM coordination: unloading ${this.m2ProStatus.loaded_model} from m2-pro before image dispatch`,
        );
        await this.unloadNode("m2-pro");
      }
    } else {
      // About to dispatch video job — ensure image worker has unloaded
      if (this.macMiniStatus.loaded_model) {
        logger.info(
          `[QueueMaster] VRAM coordination: unloading ${this.macMiniStatus.loaded_model} from mac-mini before video dispatch`,
        );
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
                : this.config.macMini.token,
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
    return node === "mac-mini" ? this.config.macMini : this.config.m2Pro;
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
      if (node === "mac-mini")
        this.macMiniStatus = { is_busy: false, loaded_model: null };
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
   * @param targetNode - Which node domain to activate ("mac-mini" for images, "m2-pro" for video)
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
      targetNode === "mac-mini" ? "m2-pro" : "mac-mini";
    let unloaded: { node: TargetNode; previous_model: string | null } | null =
      null;

    const competingStatus =
      competingNode === "mac-mini" ? this.macMiniStatus : this.m2ProStatus;
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
    if (model && targetNode === "mac-mini") {
      // FluxQ: POST /model { model: "flux-schnell" }
      try {
        const nodeConfig = await this.getLiveNodeConfig("mac-mini");
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
          this.macMiniStatus = { is_busy: false, loaded_model: model };
          loaded = { node: targetNode, model };
          logger.info(`[QueueMaster] Preloaded ${model} on mac-mini`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[QueueMaster] Failed to preload ${model} on mac-mini: ${msg}`,
        );
      }
    }
    // M2 Pro video worker lazily loads on first job, no preload endpoint

    return { unloaded, loaded };
  }

  // ── Main Loop ─────────────────────────────────────────────

  async tick(): Promise<void> {
    try {
      this.recoverStuckJobs();
      await this.pollForStaleResults();
      await this.processNode("mac-mini");
      await this.processNode("m2-pro");
      await this.processMusicJobs();
      await this.processMusicStudioJobs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueMaster] Tick error: ${msg}`);
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
        if (job.targetNode === "mac-mini") {
          this.macMiniStatus = { ...this.macMiniStatus, is_busy: false };
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
      await this.processMacMini();
    }
  }

  // ── Mac Mini (Image jobs) ─────────────────────────────────

  private async processMacMini(): Promise<void> {
    // FluxQ is synchronous — one job at a time. If we're already dispatching,
    // bail out to avoid double-dispatch and false "offline" health check failures.
    // Guard against stale busy flag: if no dispatched jobs exist for mac-mini,
    // the flag was set by a race between health-check and callback — clear it.
    if (this.macMiniStatus.is_busy) {
      const dispatched = this.repo.listJobs({ status: "dispatched" });
      const hasMacMiniDispatch = dispatched.some(
        (j) => j.targetNode === "mac-mini",
      );
      if (hasMacMiniDispatch) {
        logger.debug("[QueueMaster] Mac-mini busy (generating), skipping tick");
        return;
      }
      logger.info(
        "[QueueMaster] Mac-mini busy flag stale (no dispatched jobs) — clearing",
      );
      this.macMiniStatus = { ...this.macMiniStatus, is_busy: false };
    }

    // Audio/music jobs (including remix) are handled by processMusicJobs() / processMusicStudioJobs() — exclude them here.
    const pending = this.repo
      .getPendingJobs("mac-mini", 5)
      .filter((j) => !AUDIO_JOB_TYPES.has(j.type));
    if (pending.length === 0) return;

    // Poll FluxQ status to check if it's healthy (only when not already busy)
    try {
      this.macMiniStatus = await this.getWorkerStatus(
        await this.getLiveNodeConfig("mac-mini"),
        "mac-mini",
      );
    } catch {
      logger.debug("[QueueMaster] FluxQ unreachable, skipping image jobs");
      return;
    }

    // Recheck after health poll — FluxQ now reports is_busy while async generation is running
    if (this.macMiniStatus.is_busy) {
      logger.debug(
        "[QueueMaster] Mac-mini busy (generating), skipping after health check",
      );
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
      logger.info(
        `[QueueMaster] Dispatching ${job.type} job ${job.id} → mac-mini (async, awaiting callback)`,
      );

      await this.dispatchImageJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[QueueMaster] Failed to dispatch ${job.id} to mac-mini: ${msg}`,
      );
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
        .filter((j) => !AUDIO_JOB_TYPES.has(j.type));
    }

    // If no jobs match loaded model, get any pending non-audio job
    if (pending.length === 0) {
      pending = this.repo
        .getPendingJobs("m2-pro", 5)
        .filter((j) => !AUDIO_JOB_TYPES.has(j.type));
    }

    if (pending.length === 0) return;

    const job = pending[0];
    try {
      // VRAM coordination: ensure image worker has freed memory
      await this.ensureVramAvailable("m2-pro");

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
    const endpoint = node === "mac-mini" ? "/health" : "/status";
    const res = await fetch(`${nodeConfig.url}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;

    if (node === "mac-mini") {
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

  private async dispatchImageJob(job: MediaJob): Promise<void> {
    const { url, token } = await this.getLiveNodeConfig("mac-mini");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
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
      audio: job.payload.audio ?? false,
      tiling: job.payload.tiling ?? "aggressive",
      enhance_prompt: job.payload.enhance_prompt ?? false,
    };

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

    // When music sidecar runs on localhost, use localhost callback URL
    // so it can reach back without relying on the LAN IP.
    let callbackUrl = this.config.callbackUrl;
    const sidecarHost = new URL(nodeConfig.url).hostname;
    if (sidecarHost === "localhost" || sidecarHost === "127.0.0.1") {
      const parsed = new URL(this.config.callbackUrl);
      parsed.hostname = "localhost";
      callbackUrl = parsed.toString();
    }

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

  private async dispatchMusicStudioJob(job: MediaJob): Promise<void> {
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
    // Without this, macMiniStatus.is_busy stays true forever after the health-check
    // cache sets it, because processMacMini() early-returns without re-polling.
    if (job.targetNode === "mac-mini") {
      this.macMiniStatus = { ...this.macMiniStatus, is_busy: false };
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

    let resultUrl = (result.metadata?.result_url as string | undefined) ?? "";
    let galleryAssetId: string | undefined = result.metadata
      ?.gallery_asset_id as string | undefined;

    // When media bytes are delivered directly (image jobs from mac-mini), write to disk and
    // create the gallery asset record here. Video jobs do this in the /complete webhook before
    // calling handleJobCompletion with media_base64 = undefined.
    if (result.media_base64 && result.media_type) {
      const galleryDir =
        this.config.galleryDir ??
        path.join(os.homedir(), ".openzigs", "gallery");
      await fs.mkdir(galleryDir, { recursive: true });

      const ext =
        result.media_type === "image/png"
          ? ".png"
          : result.media_type === "image/jpeg"
            ? ".jpg"
            : result.media_type === "image/webp"
              ? ".webp"
              : ".bin";
      const safeJobId = String(jobId).replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${safeJobId}${ext}`;
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
      logger.info(
        `[QueueMaster] Asset saved: ${galleryAssetId} (${filename}, ${buffer.length} bytes)`,
      );
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
        logger.info(
          `[QueueMaster] Project ${job.projectId} complete (${status.total} jobs)`,
        );
      }
    }

    // Immediately try to dispatch the next pending job rather than waiting
    // for the next poll interval (which can be several seconds).
    void this.tick();
  }
}
