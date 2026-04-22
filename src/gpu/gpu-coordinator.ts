/**
 * GPU coordinator — mutual exclusion between heavy GPU workloads.
 *
 * Issue #917 (Epic #888). Why this exists: vLLM TP=2 wants both consumer
 * GPUs, and FLUX with `IMAGE_GEN_POOLING_MODE=manual-flux` also wants both
 * GPUs. Running them simultaneously on the same physical cards causes:
 *   1. CUDA OOM in the middle of a request (allocator fragmentation under
 *      both AWQ kernels and Diffusers' lazy weight load).
 *   2. NCCL hangs on collective ops (vLLM all-reduce blocks while FLUX is
 *      page-faulting weights).
 *   3. Silent slowdowns from PCIe contention.
 *
 * The coordinator records GPU claims in SQLite and refuses to register a
 * new claim that conflicts with an existing exclusive workload. State is
 * persisted across backend restarts so a hard-stopped process doesn't leave
 * a lingering claim — stale claims (>24h) auto-evict on the next read.
 */

import type { Database } from "better-sqlite3";

export type Workload =
  | "vllm"
  | "flux"
  | "sdxl"
  | "ltx"
  | "lipsync"
  | "sadtalker";

/** Workloads that demand exclusive use of every GPU they claim. */
const EXCLUSIVE_WORKLOADS: ReadonlySet<Workload> = new Set(["vllm", "flux"]);

export interface GpuClaim {
  workload: Workload;
  gpus: number[];
  startedAt: number;
}

export interface RegisterSuccess {
  ok: true;
}

export interface RegisterConflict {
  ok: false;
  conflictWith: Workload;
  conflictGpus: number[];
}

export type RegisterResult = RegisterSuccess | RegisterConflict;

export interface GpuCoordinatorOptions {
  /** Inject a SQLite handle. Tests pass an in-memory database. */
  db: Database;
  /** Override clock for tests. Returns ms since epoch. */
  now?: () => number;
  /** Stale-claim TTL in ms. Defaults to 24h. */
  staleAfterMs?: number;
  /** Optional logger for stale-claim eviction warnings. */
  warn?: (msg: string, details?: Record<string, unknown>) => void;
}

const STALE_DEFAULT_MS = 24 * 60 * 60 * 1000;

export class GpuCoordinator {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly warn: (msg: string, details?: Record<string, unknown>) => void;

  constructor(opts: GpuCoordinatorOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => Date.now());
    this.staleAfterMs = opts.staleAfterMs ?? STALE_DEFAULT_MS;
    this.warn = opts.warn ?? (() => undefined);
    this.migrate();
  }

  private migrate(): void {
    // Runtime ALTER-TABLE migration per repo convention.
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS gpu_claims (
            workload   TEXT PRIMARY KEY,
            gpus_json  TEXT NOT NULL,
            started_at INTEGER NOT NULL
         )`,
      )
      .run();
  }

  /** Evict entries older than `staleAfterMs`. Returns the number evicted. */
  private evictStale(): number {
    const cutoff = this.now() - this.staleAfterMs;
    const stale = this.db
      .prepare("SELECT workload, started_at FROM gpu_claims WHERE started_at < ?")
      .all(cutoff) as Array<{ workload: string; started_at: number }>;
    if (stale.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM gpu_claims WHERE workload = ?");
    for (const row of stale) {
      del.run(row.workload);
      this.warn("gpu-coordinator: evicted stale claim", {
        workload: row.workload,
        ageMs: this.now() - row.started_at,
      });
    }
    return stale.length;
  }

  private rowsToClaims(): GpuClaim[] {
    const rows = this.db
      .prepare("SELECT workload, gpus_json, started_at FROM gpu_claims")
      .all() as Array<{
      workload: string;
      gpus_json: string;
      started_at: number;
    }>;
    return rows.map((r) => ({
      workload: r.workload as Workload,
      gpus: JSON.parse(r.gpus_json) as number[],
      startedAt: r.started_at,
    }));
  }

  currentClaims(): GpuClaim[] {
    this.evictStale();
    return this.rowsToClaims();
  }

  /**
   * Attempt to claim a set of GPUs for a workload.
   *
   * Conflict rule: a new claim is rejected when any requested GPU index is
   * already claimed AND either the existing OR the new workload is in the
   * exclusive set (`vllm`, `flux`). Two non-exclusive workloads claiming the
   * same GPU share by default to preserve the pre-coordinator behaviour
   * (multiple sidecars happily co-locate on one card today).
   */
  register(workload: Workload, gpus: number[]): RegisterResult {
    if (gpus.length === 0) {
      return { ok: true };
    }
    this.evictStale();
    const claims = this.rowsToClaims();
    const newIsExclusive = EXCLUSIVE_WORKLOADS.has(workload);

    for (const claim of claims) {
      if (claim.workload === workload) continue; // updates handled below
      const overlap = claim.gpus.filter((g) => gpus.includes(g));
      if (overlap.length === 0) continue;
      const existingIsExclusive = EXCLUSIVE_WORKLOADS.has(claim.workload);
      if (newIsExclusive || existingIsExclusive) {
        return {
          ok: false,
          conflictWith: claim.workload,
          conflictGpus: overlap,
        };
      }
    }

    // Upsert.
    this.db
      .prepare(
        `INSERT INTO gpu_claims (workload, gpus_json, started_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workload) DO UPDATE SET
           gpus_json = excluded.gpus_json,
           started_at = excluded.started_at`,
      )
      .run(workload, JSON.stringify(gpus), this.now());
    return { ok: true };
  }

  unregister(workload: Workload): boolean {
    const res = this.db
      .prepare("DELETE FROM gpu_claims WHERE workload = ?")
      .run(workload);
    return res.changes > 0;
  }

  /** Reset the coordinator (test helper). */
  clear(): void {
    this.db.prepare("DELETE FROM gpu_claims").run();
  }
}

/** Compute serving_mode + claims summary for /api/system/gpu. */
export function summariseClaims(claims: GpuClaim[]): {
  serving_mode: "diffusion" | "vllm-tp2" | "mixed" | "idle";
  conflicts: string[];
} {
  if (claims.length === 0) {
    return { serving_mode: "idle", conflicts: [] };
  }
  const hasVllm = claims.some((c) => c.workload === "vllm");
  const hasDiffusion = claims.some((c) =>
    (["flux", "sdxl", "ltx", "lipsync", "sadtalker"] as Workload[]).includes(
      c.workload,
    ),
  );
  let serving_mode: "diffusion" | "vllm-tp2" | "mixed" | "idle";
  if (hasVllm && hasDiffusion) serving_mode = "mixed";
  else if (hasVllm) serving_mode = "vllm-tp2";
  else serving_mode = "diffusion";

  // Conflict detection — a workload appearing twice with overlapping GPUs is
  // impossible (the coordinator rejects it), but we still surface the case
  // where an exclusive workload coexists with another exclusive workload on
  // disjoint GPUs (legitimate on a 4-GPU host but worth flagging in the UI).
  const conflicts: string[] = [];
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i];
      const b = claims[j];
      const overlap = a.gpus.filter((g) => b.gpus.includes(g));
      if (
        overlap.length > 0 &&
        (EXCLUSIVE_WORKLOADS.has(a.workload) ||
          EXCLUSIVE_WORKLOADS.has(b.workload))
      ) {
        conflicts.push(`${a.workload}↔${b.workload} on GPU ${overlap.join(",")}`);
      }
    }
  }
  return { serving_mode, conflicts };
}
