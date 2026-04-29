/**
 * Sidecar auto-start \u2014 sub-issue #1010.
 *
 * On server boot, if `media.autoStartSidecars` is true, ping the FluxQ
 * health endpoint. If it is unreachable (connect refused / fetch
 * rejection), spawn the platform-appropriate `scripts/media-ctl.{ps1,sh}`
 * start command, detached + ignored stdio + unref()'d so it survives the
 * parent's lifecycle, then poll the health endpoint until it answers
 * `200 OK` or the timeout elapses.
 *
 * This module is intentionally pure and side-effect free at import time.
 * The `spawn`/`fetch` callables are injected via options to keep the
 * unit tests deterministic and offline.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { platform as osPlatform } from "node:os";

export type EnsureSidecarsResult = {
  /** true if the health endpoint answered 200 within the timeout. */
  ready: boolean;
  /** true if we actually spawned the start script (i.e. it wasn't already up). */
  started: boolean;
  /** Total wall-clock time spent in `ensureSidecarsRunning`, ms. */
  durationMs: number;
  /** Last error message, if `ready === false`. */
  error?: string;
};

/** Minimal subset of `node:child_process` we depend on \u2014 simplifies tests. */
type SpawnLike = typeof nodeSpawn;

export interface EnsureSidecarsOptions {
  /** Health endpoint to probe (e.g. `http://127.0.0.1:5005/health`). */
  healthUrl: string;
  /** Hard deadline for readiness, including spawn + polling. Defaults to 60 s. */
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
  /** Health-poll interval, ms. Defaults to 1500. */
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1500;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Probe the health endpoint with a tight 2 s timeout. Returns `true` if
 * the endpoint answers any 2xx, `false` for any other outcome.
 */
async function probeHealth(
  healthUrl: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(healthUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
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
 * answers, returns immediately with `started: false`. Otherwise spawns
 * the start script and polls until ready or timeout.
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
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const started = clock();

  // Fast path: already reachable, no spawn needed.
  if (await probeHealth(opts.healthUrl, fetchFn)) {
    return {
      ready: true,
      started: false,
      durationMs: clock() - started,
    };
  }

  // Resolve and spawn the platform-appropriate start script.
  const cmd = resolveStartCommand(platform, opts.repoRoot);
  if (!cmd) {
    return {
      ready: false,
      started: false,
      durationMs: clock() - started,
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
      durationMs: clock() - started,
      error: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Poll until ready or timeout. The first probe runs after one
  // pollIntervalMs to give the script a chance to bind the port.
  const deadline = started + timeoutMs;
  while (clock() < deadline) {
    await sleep(pollIntervalMs);
    if (await probeHealth(opts.healthUrl, fetchFn)) {
      return {
        ready: true,
        started: true,
        durationMs: clock() - started,
      };
    }
  }

  return {
    ready: false,
    started: true,
    durationMs: clock() - started,
    error: `health endpoint did not respond within ${timeoutMs}ms`,
  };
}
