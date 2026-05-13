/**
 * GPU dispatcher — data-parallel job queue with per-GPU pinning.
 *
 * Issue #1056 (Epic #1053). The OLD model spawned one workload that tried to
 * use both physical GPUs at once (tensor parallelism). That works for LLM
 * inference with NVLink, but openzigs runs FLUX / LTX / Wan diffusion U-Nets
 * where TP is a non-starter — and even for vLLM, PCIe Gen 4 only delivers
 * ~1.4–1.5× scaling vs NVLink's 1.84×.
 *
 * The NEW model is a per-GPU job queue. Each job is pinned to exactly one
 * GPU via `CUDA_VISIBLE_DEVICES`. Multiple jobs can run concurrently if they
 * target different GPUs. Mutual exclusion is enforced — an LLM workload
 * cannot start on a GPU that is currently rendering image/video output and
 * vice-versa.
 *
 * The {@link GpuCoordinator} (issue #917) already handles persistent
 * exclusive-claim mutex between vLLM and FLUX across restarts — this
 * dispatcher layers an in-memory queue on top so callers can `await
 * dispatcher.enqueue(job)` rather than retry-polling the coordinator.
 *
 * Workloads currently understood:
 *   - `llm`   — local LLM inference (Ollama / vLLM)
 *   - `image` — Diffusers FLUX / SDXL
 *   - `video` — LTX / Wan
 *
 * The dispatcher is **passive**: it does not spawn child processes itself.
 * Callers wrap their existing run logic in `enqueue({ run })` and the
 * dispatcher serializes assignment + emits state events. Cancellation is
 * cooperative — the `run` function receives an `AbortSignal` and is
 * expected to honour it.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type WorkloadType = "llm" | "image" | "video";
export type GpuLaneState = "idle" | "busy" | "error";

/** What the dispatcher knows about a single physical GPU at any moment. */
export interface GpuLaneSnapshot {
  index: number;
  state: GpuLaneState;
  /** Currently executing job, when `state === "busy"`. */
  currentJob?: {
    id: string;
    workloadType: WorkloadType;
    startedAt: number;
  };
  /** Last error message when `state === "error"`. */
  lastError?: string;
  /** Number of jobs queued behind the current one. */
  queueDepth: number;
  /**
   * When the lane is idle but mutex prevents the next queued job from
   * starting, this names the workload type that is blocking it. Used by the
   * admin UI to render a "blocked by" indicator.
   */
  mutexBlockedBy?: WorkloadType;
}

/** Per-job submission shape. `run` receives the assigned GPU index and an
 *  abort signal; it must honour the signal for cancellation to work. */
export interface DispatcherJob<T = unknown> {
  /** Optional id; auto-generated when omitted. */
  id?: string;
  workloadType: WorkloadType;
  /** When `true`, the dispatcher may route the job to any non-pinned GPU
   *  if the pinned ones are busy. Default `false` (strict pinning). */
  allowFallback?: boolean;
  /** The actual workload. Receives the chosen GPU index — typically used
   *  to set `CUDA_VISIBLE_DEVICES` before spawning a child process or
   *  configuring an HTTP request. */
  run: (gpuIndex: number, signal: AbortSignal) => Promise<T>;
}

export type DispatcherPinning = Partial<Record<WorkloadType, number[]>>;

export interface GpuDispatcherOptions {
  /** Number of physical GPUs to manage. `0` is treated as "no-GPU host" and
   *  every job runs immediately on synthetic lane `-1` with no mutex. */
  gpuCount: number;
  /** Workload → GPU index list. When a workload is omitted, every GPU is a
   *  candidate. Defaults: `llm: [0]`, `image: [last]`, `video: [last]` on
   *  multi-GPU; everything on `0` for single-GPU. */
  pinning?: DispatcherPinning;
  /** When `true` (default), an `llm` job will not start on a GPU while any
   *  `image|video` job is running on ANY GPU, and vice-versa. Diffusion +
   *  LLM kernels share allocator + PCIe bandwidth and contend badly. */
  mutualExclusion?: boolean;
  /** Default `allowFallback` for jobs that don't override it. */
  defaultAllowFallback?: boolean;
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /** Audit log sink. Receives one event per assignment / state change. */
  audit?: (event: string, details: Record<string, unknown>) => void;
}

interface QueueEntry {
  id: string;
  workloadType: WorkloadType;
  allowFallback: boolean;
  run: (gpuIndex: number, signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface InternalLane {
  index: number;
  state: GpuLaneState;
  currentJob?: {
    id: string;
    workloadType: WorkloadType;
    startedAt: number;
    abort: AbortController;
  };
  lastError?: string;
  queue: QueueEntry[];
  mutexBlockedBy?: WorkloadType;
}

const DIFFUSION_TYPES: ReadonlySet<WorkloadType> = new Set(["image", "video"]);

/** Compute pinning defaults that match the issue: LLM on GPU 0, image/video
 *  on the last GPU. Single-GPU systems collapse everything onto GPU 0. */
export function defaultDispatcherPinning(gpuCount: number): DispatcherPinning {
  if (gpuCount <= 1) {
    return { llm: [0], image: [0], video: [0] };
  }
  const last = gpuCount - 1;
  return { llm: [0], image: [last], video: [last] };
}

function isMutexConflict(a: WorkloadType, b: WorkloadType): boolean {
  if (a === b) return false;
  return (
    (a === "llm" && DIFFUSION_TYPES.has(b)) ||
    (b === "llm" && DIFFUSION_TYPES.has(a))
  );
}

/**
 * Per-GPU job queue with mutex enforcement. Emits:
 *   - `job:started`   `{ jobId, gpuIndex, workloadType }`
 *   - `job:completed` `{ jobId, gpuIndex, workloadType, durationMs }`
 *   - `job:failed`    `{ jobId, gpuIndex, workloadType, error }`
 *   - `gpu:state-changed` `{ gpuIndex, state, currentJob?, queueDepth, ... }`
 */
export class GpuDispatcher extends EventEmitter {
  private readonly lanes: Map<number, InternalLane> = new Map();
  private readonly pinning: DispatcherPinning;
  private readonly mutualExclusion: boolean;
  private readonly defaultAllowFallback: boolean;
  private readonly now: () => number;
  private readonly audit: (
    event: string,
    details: Record<string, unknown>,
  ) => void;
  private readonly noGpu: boolean;

  constructor(opts: GpuDispatcherOptions) {
    super();
    this.now = opts.now ?? (() => Date.now());
    this.audit = opts.audit ?? (() => undefined);
    this.mutualExclusion = opts.mutualExclusion ?? true;
    this.defaultAllowFallback = opts.defaultAllowFallback ?? false;
    this.noGpu = opts.gpuCount <= 0;

    const count = Math.max(opts.gpuCount, this.noGpu ? 1 : opts.gpuCount);
    this.pinning = opts.pinning ?? defaultDispatcherPinning(count);

    // No-GPU hosts get a single synthetic lane (index -1) so callers receive
    // a sane gpuIndex argument without special-casing every site.
    if (this.noGpu) {
      this.lanes.set(-1, {
        index: -1,
        state: "idle",
        queue: [],
      });
    } else {
      for (let i = 0; i < opts.gpuCount; i += 1) {
        this.lanes.set(i, { index: i, state: "idle", queue: [] });
      }
    }
  }

  /** Snapshot every lane in stable index order. */
  state(): GpuLaneSnapshot[] {
    return Array.from(this.lanes.values())
      .sort((a, b) => a.index - b.index)
      .map((lane) => this.snapshot(lane));
  }

  /** Snapshot a single lane. */
  laneState(gpuIndex: number): GpuLaneSnapshot | undefined {
    const lane = this.lanes.get(gpuIndex);
    return lane ? this.snapshot(lane) : undefined;
  }

  private snapshot(lane: InternalLane): GpuLaneSnapshot {
    return {
      index: lane.index,
      state: lane.state,
      currentJob: lane.currentJob
        ? {
            id: lane.currentJob.id,
            workloadType: lane.currentJob.workloadType,
            startedAt: lane.currentJob.startedAt,
          }
        : undefined,
      lastError: lane.lastError,
      queueDepth: lane.queue.length,
      mutexBlockedBy: lane.mutexBlockedBy,
    };
  }

  /**
   * Submit a job. Returns a promise that resolves with `run`'s return value
   * once the job completes, or rejects when `run` throws or the job is
   * cancelled via {@link cancel}.
   */
  enqueue<T>(job: DispatcherJob<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = job.id ?? randomUUID();
      const allowFallback = job.allowFallback ?? this.defaultAllowFallback;

      // No-GPU host: synthetic lane, no mutex.
      if (this.noGpu) {
        const entry: QueueEntry = {
          id,
          workloadType: job.workloadType,
          allowFallback,
          run: job.run as QueueEntry["run"],
          resolve: resolve as (v: unknown) => void,
          reject,
        };
        this.lanes.get(-1)!.queue.push(entry);
        this.tryRun(-1);
        return;
      }

      const targetIndex = this.pickLane(job.workloadType, allowFallback);
      if (targetIndex === null) {
        const err = new Error(
          `gpu-dispatcher: no GPU lane available for workload "${job.workloadType}"`,
        );
        this.audit("gpu.dispatch_rejected", {
          jobId: id,
          workloadType: job.workloadType,
          reason: "no_lane",
        });
        reject(err);
        return;
      }

      const entry: QueueEntry = {
        id,
        workloadType: job.workloadType,
        allowFallback,
        run: job.run as QueueEntry["run"],
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      const lane = this.lanes.get(targetIndex)!;
      lane.queue.push(entry);
      this.audit("gpu.dispatch_queued", {
        jobId: id,
        workloadType: job.workloadType,
        gpuIndex: targetIndex,
        queueDepth: lane.queue.length,
      });
      this.emitLaneState(lane);
      this.tryRun(targetIndex);
    });
  }

  /**
   * Choose a lane for a workload. Strategy:
   *   1. Pinned candidates (default per workload type, or all when no pin).
   *   2. Prefer an idle, non-error lane.
   *   3. If all candidates busy, pick the shortest queue.
   *   4. If every candidate is in `error` and `allowFallback`, fall back to
   *      ANY non-error lane; otherwise return null.
   */
  private pickLane(
    workloadType: WorkloadType,
    allowFallback: boolean,
  ): number | null {
    const pinned = this.pinning[workloadType];
    const allLanes = Array.from(this.lanes.values());
    const candidates =
      pinned && pinned.length > 0
        ? allLanes.filter((l) => pinned.includes(l.index))
        : allLanes;

    const healthy = candidates.filter((l) => l.state !== "error");
    const pool =
      healthy.length > 0
        ? healthy
        : allowFallback
          ? allLanes.filter((l) => l.state !== "error")
          : [];

    if (pool.length === 0) return null;

    const idle = pool.find((l) => l.state === "idle" && l.queue.length === 0);
    if (idle) return idle.index;

    pool.sort((a, b) => a.queue.length - b.queue.length);
    return pool[0].index;
  }

  /** True if any OTHER lane is currently running a workload that conflicts
   *  with `workloadType` (LLM ↔ diffusion). */
  private hasMutexConflict(
    workloadType: WorkloadType,
    excludeIndex: number,
  ): WorkloadType | null {
    if (!this.mutualExclusion) return null;
    for (const lane of this.lanes.values()) {
      if (lane.index === excludeIndex) continue;
      if (lane.state !== "busy" || !lane.currentJob) continue;
      if (isMutexConflict(workloadType, lane.currentJob.workloadType)) {
        return lane.currentJob.workloadType;
      }
    }
    return null;
  }

  private tryRun(gpuIndex: number): void {
    const lane = this.lanes.get(gpuIndex);
    if (!lane) return;
    if (lane.state === "busy" || lane.state === "error") return;
    const next = lane.queue[0];
    if (!next) {
      if (lane.mutexBlockedBy) {
        lane.mutexBlockedBy = undefined;
        this.emitLaneState(lane);
      }
      return;
    }

    const conflict = this.hasMutexConflict(next.workloadType, gpuIndex);
    if (conflict) {
      if (lane.mutexBlockedBy !== conflict) {
        lane.mutexBlockedBy = conflict;
        this.audit("gpu.mutex_blocked", {
          jobId: next.id,
          workloadType: next.workloadType,
          gpuIndex,
          blockedBy: conflict,
        });
        this.emitLaneState(lane);
      }
      return;
    }

    if (lane.mutexBlockedBy) {
      lane.mutexBlockedBy = undefined;
    }

    lane.queue.shift();
    const abort = new AbortController();
    lane.state = "busy";
    lane.currentJob = {
      id: next.id,
      workloadType: next.workloadType,
      startedAt: this.now(),
      abort,
    };
    this.audit("gpu.job_dispatched", {
      jobId: next.id,
      workloadType: next.workloadType,
      gpuIndex,
    });
    this.emit("job:started", {
      jobId: next.id,
      gpuIndex,
      workloadType: next.workloadType,
    });
    this.emitLaneState(lane);

    Promise.resolve()
      .then(() => next.run(gpuIndex, abort.signal))
      .then(
        (result) => {
          const startedAt = lane.currentJob?.startedAt ?? this.now();
          lane.currentJob = undefined;
          lane.state = "idle";
          this.audit("gpu.job_completed", {
            jobId: next.id,
            workloadType: next.workloadType,
            gpuIndex,
            durationMs: this.now() - startedAt,
          });
          this.emit("job:completed", {
            jobId: next.id,
            gpuIndex,
            workloadType: next.workloadType,
            durationMs: this.now() - startedAt,
          });
          this.emitLaneState(lane);
          next.resolve(result);
          // Wake up every lane that may have been mutex-blocked by us.
          this.wakeAll();
        },
        (err: unknown) => {
          lane.currentJob = undefined;
          // A user-initiated cancel surfaces as AbortError but the LANE is
          // still healthy — treat it as a normal completion-with-rejection
          // rather than poisoning the lane.
          const isAbort =
            err instanceof Error &&
            (err.name === "AbortError" || abort.signal.aborted);
          if (isAbort) {
            lane.state = "idle";
            this.audit("gpu.job_cancelled", {
              jobId: next.id,
              workloadType: next.workloadType,
              gpuIndex,
            });
            this.emit("job:failed", {
              jobId: next.id,
              gpuIndex,
              workloadType: next.workloadType,
              error: "cancelled",
              cancelled: true,
            });
          } else {
            lane.state = "error";
            lane.lastError = err instanceof Error ? err.message : String(err);
            this.audit("gpu.state_changed", {
              gpuIndex,
              state: "error",
              error: lane.lastError,
              jobId: next.id,
            });
            this.emit("job:failed", {
              jobId: next.id,
              gpuIndex,
              workloadType: next.workloadType,
              error: lane.lastError,
            });
          }
          this.emitLaneState(lane);
          next.reject(err);
          this.wakeAll();
        },
      );
  }

  private emitLaneState(lane: InternalLane): void {
    this.emit("gpu:state-changed", this.snapshot(lane));
  }

  private wakeAll(): void {
    for (const idx of this.lanes.keys()) {
      this.tryRun(idx);
    }
  }

  /**
   * Cancel the currently running job on `gpuIndex`. Returns `true` if a job
   * was actually aborted. The job's `run` function MUST honour the abort
   * signal for cancellation to take effect — the dispatcher only signals
   * intent and trusts the caller's cleanup.
   *
   * Queued jobs on the lane are left in place; the next `tryRun` after the
   * cancelled job rejects will pick them up.
   */
  cancel(gpuIndex: number): boolean {
    const lane = this.lanes.get(gpuIndex);
    if (!lane || !lane.currentJob) return false;
    this.audit("gpu.cancel_requested", {
      gpuIndex,
      jobId: lane.currentJob.id,
      workloadType: lane.currentJob.workloadType,
    });
    lane.currentJob.abort.abort();
    return true;
  }

  /** Manually clear an `error` state on a lane (e.g. UI "Retry" button). */
  clearError(gpuIndex: number): boolean {
    const lane = this.lanes.get(gpuIndex);
    if (!lane || lane.state !== "error") return false;
    lane.state = "idle";
    lane.lastError = undefined;
    this.audit("gpu.state_changed", {
      gpuIndex,
      state: "idle",
      source: "manual",
    });
    this.emitLaneState(lane);
    this.tryRun(gpuIndex);
    return true;
  }

  /** Total queued jobs across every lane. Useful for capacity warnings. */
  totalQueueDepth(): number {
    let total = 0;
    for (const lane of this.lanes.values()) total += lane.queue.length;
    return total;
  }
}

// ── Module-level singleton (mirrors the `_adminIo` pattern in admin.ts) ────
// Wiring an instance through every service constructor would be a sprawling
// surface change; instead we expose an opt-in singleton so existing callers
// can `withGpuLane(...)` from anywhere without taking a dispatcher dep.

let _activeDispatcher: GpuDispatcher | null = null;

export function setActiveGpuDispatcher(d: GpuDispatcher | null): void {
  _activeDispatcher = d;
}

export function getActiveGpuDispatcher(): GpuDispatcher | null {
  return _activeDispatcher;
}

/**
 * Convenience: enqueue work on the active dispatcher if one is registered;
 * otherwise run inline. Lets services adopt dispatcher coordination without
 * forcing every test/headless boot path to wire one up.
 */
export async function withGpuLane<T>(
  workloadType: WorkloadType,
  run: (gpuIndex: number, signal: AbortSignal) => Promise<T>,
  opts: { allowFallback?: boolean } = {},
): Promise<T> {
  const dispatcher = getActiveGpuDispatcher();
  if (!dispatcher) {
    // No coordination — historical single-GPU behaviour. Use AbortController
    // that never fires so the run signature stays uniform.
    return run(0, new AbortController().signal);
  }
  return dispatcher.enqueue<T>({
    workloadType,
    allowFallback: opts.allowFallback,
    run,
  });
}
