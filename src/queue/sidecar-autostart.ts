/**
 * Sidecar auto-start — sub-issue #1010 + polish #1014.
 *
 * On server boot, if `media.autoStartSidecars` is true, ping the FluxQ
 * health endpoint. If it is unreachable (connect refused / fetch
 * rejection), spawn the platform-appropriate `scripts/media-ctl.{ps1,sh}`
 * start command, detached + ignored stdio + unref()'d so it survives the
 * parent's lifecycle, then poll the health endpoint until it answers
 * `200 OK` or the timeout elapses.
 *
 * Polish (#1014):
 *   - Exponential backoff schedule (250 → 500 → 1s → 2s → 4s → 5s cap)
 *     replaces the previous fixed 1.5 s interval. CUDA cold-starts on
 *     Windows + WSL2 routinely take 30–60 s and the old fixed interval
 *     wasted probes during the long warm-up tail.
 *   - DEBUG-level structured log line per probe so operators can see
 *     exactly when readiness flipped without enabling INFO floods.
 *   - Default timeout extended 60 s → 120 s for cold-start scenarios
 *     (model checkpoint load, first-time CUDA kernel compile).
 *
 * This module is intentionally pure and side-effect free at import time.
 * The `spawn`/`fetch` callables are injected via options to keep the
 * unit tests deterministic and offline.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { platform as osPlatform } from "node:os";

import { logger } from "../logging/logger.js";

export type EnsureSidecarsResult = {
  /** true if the health endpoint answered 200 within the timeout. */
  ready: boolean;
  /** true if we actually spawned the start script (i.e. it wasn't already up). */
  started: boolean;
  /** Total wall-clock time spent in `ensureSidecarsRunning`, ms. */
  durationMs: number;
  /** Last error message, if `ready === false`. */
  error?: string;
  /** Number of health probes performed (including the fast-path probe). */
  attempts: number;
};

/** Minimal subset of `node:child_process` we depend on — simplifies tests. */
type SpawnLike = typeof nodeSpawn;

export interface EnsureSidecarsOptions {
  /** Health endpoint to probe (e.g. `http://127.0.0.1:5005/health`). */
  healthUrl: string;
  /** Hard deadline for readiness, including spawn + polling. Defaults to 120 s. */
  timeoutMs?: number;
  /** Repository root (used to resolve `scripts/media-ctl.*`). */
  repoRoot: string;
  /**
   * Override the OS platform string for tests. Falls back to
   * `os.platform()`. The shape is identical to Node's `NodeJS.Platform`.
   */
  platformOverride?: NodeJS.Platform;
  /** Override the spawn function (tests inject a mock). */
  spawnFn?: SpawnLike;
  /** Override fetch (tests inject a mock). */
  fetchFn?: typeof fetch;
  /** Override the wall clock (tests inject a deterministic source). */
  clock?: () => number;
  /** Sleep helper override (tests resolve immediately). */
  sleep?: (ms: number) => Promise<void>;
}

/** Default 120 s — covers CUDA cold-start tail (model load + kernel compile). */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Exponential backoff schedule for health polling, in milliseconds.
 *
 * Index N is the delay BEFORE the (N+1)-th polling probe (the 0-th probe
 * is the fast-path one with no preceding sleep). Once the schedule is
 * exhausted the last value (5 s) is reused as a cap so we keep pinging
 * at a steady cadence during the long tail without burning attempts.
 */
const BACKOFF_SCHEDULE_MS = [250, 500, 1_000, 2_000, 4_000, 5_000] as const;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Index N → backoff delay (caps at the last entry). */
function backoffDelayMs(attemptIndex: number): number {
  const last = BACKOFF_SCHEDULE_MS.length - 1;
  const idx = attemptIndex < 0 ? 0 : attemptIndex > last ? last : attemptIndex;
  return BACKOFF_SCHEDULE_MS[idx]!;
}

/**
 * Probe the health endpoint with a tight 2 s timeout. Returns `"ok"` if
 * the endpoint answered any 2xx, `"err"` if it threw before timing out,
 * `"timeout"` if the AbortSignal fired. The discriminated return type
 * powers the structured DEBUG log line and is otherwise collapsed to a
 * boolean by the caller.
 */
async function probeHealth(
  healthUrl: string,
  fetchFn: typeof fetch,
): Promise<"ok" | "err" | "timeout"> {
  try {
    const res = await fetchFn(healthUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok ? "ok" : "err";
  } catch (err) {
    // AbortSignal.timeout fires a DOMException with name "TimeoutError".
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    return "err";
  }
}

/**
 * Resolve the platform-specific start command. Returns `null` if the
 * platform is not supported (in which case auto-start is a no-op and we
 * report the failure upstream).
 */
function resolveStartCommand(
  platform: NodeJS.Platform,
  repoRoot: string,
): { command: string; args: string[] } | null {
  if (platform === "win32") {
    // Use PowerShell with bypass policy so corp-locked-down machines can
    // still launch the script. The script itself accepts a positional
    // service name; "flux" starts the FluxQ image-gen sidecar.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        `${repoRoot}\\scripts\\media-ctl.ps1`,
        "flux",
        "start",
      ],
    };
  }
  if (platform === "darwin" || platform === "linux") {
    return {
      command: "bash",
      args: [`${repoRoot}/scripts/media-ctl.sh`, "flux", "start"],
    };
  }
  return null;
}

/**
 * Ensure the FluxQ sidecar is reachable. If the health endpoint already
 * answers, returns immediately with `started: false` (no-op fast path).
 * Otherwise spawns the start script and polls until ready or timeout
 * using the exponential backoff schedule defined above.
 */
export async function ensureSidecarsRunning(
  opts: EnsureSidecarsOptions,
): Promise<EnsureSidecarsResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const platform = opts.platformOverride ?? osPlatform();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startedAt = clock();
  let attempts = 0;

  // Fast path: already reachable, no spawn needed.
  attempts += 1;
  const fastStatus = await probeHealth(opts.healthUrl, fetchFn);
  logger.debug(
    `[Sidecars] attempt ${attempts}, elapsed ${clock() - startedAt}ms, status ${fastStatus}`,
  );
  if (fastStatus === "ok") {
    return {
      ready: true,
      started: false,
      durationMs: clock() - startedAt,
      attempts,
    };
  }

  // Resolve and spawn the platform-appropriate start script.
  const cmd = resolveStartCommand(platform, opts.repoRoot);
  if (!cmd) {
    return {
      ready: false,
      started: false,
      durationMs: clock() - startedAt,
      attempts,
      error: `unsupported platform: ${platform}`,
    };
  }

  try {
    const child = spawnFn(cmd.command, cmd.args, {
      detached: true,
      stdio: "ignore",
      // Spawn from the repo root so any relative paths in the script
      // resolve against the expected directory.
      cwd: opts.repoRoot,
      // Suppress the conhost flash window on Windows when launching
      // powershell.exe detached. No-op on POSIX.
      windowsHide: true,
    });
    // Detach so the child keeps running after the parent exits.
    child.unref();
  } catch (err) {
    return {
      ready: false,
      started: false,
      durationMs: clock() - startedAt,
      attempts,
      error: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Poll with exponential backoff (250 → 500 → 1s → 2s → 4s → 5s cap)
  // until ready or `timeoutMs` elapses. Each sleep is clipped to the
  // remaining budget so we never overshoot the deadline.
  const deadline = startedAt + timeoutMs;
  let pollIndex = 0;
  while (clock() < deadline) {
    const remaining = deadline - clock();
    const delay = Math.min(backoffDelayMs(pollIndex), Math.max(0, remaining));
    if (delay <= 0) break;
    await sleep(delay);
    if (clock() >= deadline) break;

    attempts += 1;
    const status = await probeHealth(opts.healthUrl, fetchFn);
    logger.debug(
      `[Sidecars] attempt ${attempts}, elapsed ${clock() - startedAt}ms, status ${status}`,
    );
    if (status === "ok") {
      return {
        ready: true,
        started: true,
        durationMs: clock() - startedAt,
        attempts,
      };
    }
    pollIndex += 1;
  }

  return {
    ready: false,
    started: true,
    durationMs: clock() - startedAt,
    attempts,
    error: `health endpoint did not respond within ${timeoutMs}ms`,
  };
}

/** Test-only export — exposed so the unit test can assert the schedule. */
export const __test = {
  BACKOFF_SCHEDULE_MS,
  DEFAULT_TIMEOUT_MS,
  backoffDelayMs,
};
