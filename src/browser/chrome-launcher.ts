import { spawn, exec, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { platform, homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { logger } from "../logging/logger.js";

const execAsync = promisify(exec);

export type ChromeLauncherOptions = {
  host?: string;
  port?: number;
  /** Extra Chrome flags (e.g. --headless=new) */
  extraFlags?: string[];
  /** Skip launch if Chrome is already reachable on the debug port */
  reuseExisting?: boolean;
};

const DEFAULT_PORT = 9222;

/** Well-known Chrome / Chromium binary paths per platform */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium"
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`
  ]
};

const findChromeBinary = (): string | undefined => {
  const paths = CHROME_PATHS[platform()] ?? [];
  return paths.find((p) => existsSync(p));
};

/**
 * Returns a dedicated Chrome user-data directory for OpenZigs automation.
 * Using a separate profile ensures we can launch a new Chrome instance
 * with --remote-debugging-port even when the user's regular Chrome is open.
 *
 * Persistent profile at ~/.openzigs/chrome-profile preserves cookies,
 * localStorage, and session state across server restarts.
 */
const getAutomationProfileDir = (): string => {
  const dir = path.join(homedir(), ".openzigs", "chrome-profile");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
};

/**
 * Force-kills any Chrome processes running with the OpenZigs profile directory.
 * This handles "zombie" processes left over from ungraceful shutdowns.
 */
export const killZombieChromes = async (): Promise<void> => {
  const profileDir = getAutomationProfileDir();
  // On macOS/Linux, pkill -f matches against the full command line.
  // We match the profile directory path to avoid killing the user's personal Chrome.
  if (platform() === "win32") {
    // Windows implementation (skip for now)
    return;
  }

  try {
    // -f matches full argument list
    // We purposely ignore the exit code (1 means no processes found)
    await execAsync(`pkill -f "${profileDir}"`);
    logger.info("Cleaned up zombie Chrome processes from previous runs");
  } catch {
    // No matching processes or error, ignore
  }
};

/**
 * Probe whether Chrome is already listening with remote debugging on the
 * given host:port.  Returns true if reachable, false otherwise.
 */
const isDebugPortReachable = async (
  host: string,
  port: number
): Promise<boolean> => {
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
};

let childProcess: ChildProcess | null = null;

/**
 * Launch Chrome with `--remote-debugging-port`.
 *
 * - If `reuseExisting` is true (default) and Chrome is already reachable on
 *   the debug port, the launch is skipped.
 * - Returns `true` if Chrome was launched or is already running on the port.
 * - Returns `false` if no Chrome binary was found.
 */
export const launchChrome = async (
  options: ChromeLauncherOptions = {}
): Promise<boolean> => {
  const host = options.host ?? "localhost";
  const port = options.port ?? DEFAULT_PORT;
  const reuseExisting = options.reuseExisting ?? true;
  const extraFlags = options.extraFlags ?? [];

  // Remember options for ensureChromeRunning() relaunch
  lastLaunchOptions = options;

  // If Chrome is already running with debugging, reuse it
  if (reuseExisting) {
    const reachable = await isDebugPortReachable(host, port);
    if (reachable) {
      logger.info(
        `Chrome already reachable on ${host}:${port} — skipping launch`
      );
      return true;
    }
  }

  // Ensure no zombies occupy the profile lock if we are about to launch
  await killZombieChromes();

  const chromePath = findChromeBinary();
  if (!chromePath) {
    logger.warn(
      "Could not find Chrome/Chromium binary. Browser tools will be unavailable. " +
        "Install Chrome or set CHROME_AUTO_LAUNCH=false to silence this warning."
    );
    return false;
  }

  const args = [
    `--remote-debugging-port=${port}`,
    // Use a separate user-data-dir so we get a fresh Chrome instance even
    // when the user's regular Chrome is already open (macOS won't start a
    // second instance with the same profile).
    `--user-data-dir=${getAutomationProfileDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...extraFlags
  ];

  logger.info(`Launching Chrome: ${chromePath} ${args.join(" ")}`);

  childProcess = spawn(chromePath, args, {
    stdio: "ignore"
  });

  childProcess.on("error", (error) => {
    logger.error(`Chrome launch failed: ${error.message}`);
    childProcess = null;
  });

  childProcess.on("exit", (code) => {
    if (code !== null && code !== 0 && code !== 15 && code !== 9) { // 15=SIGTERM, 9=SIGKILL
      logger.warn(`Chrome exited with code ${code}`);
    }
    childProcess = null;
  });

  // Wait briefly for the debug port to become reachable
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ready = await isDebugPortReachable(host, port);
    if (ready) {
      logger.info(`Chrome DevTools Protocol ready on ${host}:${port}`);
      return true;
    }
  }

  logger.warn(
    `Chrome launched but DevTools port ${port} not reachable after ${maxAttempts * 500}ms — ` +
      "browser tools may not work until Chrome finishes starting"
  );
  return true; // Chrome was launched, just slow to start
};

/**
 * Kill the Chrome process that was launched by `launchChrome`.
 * Safe to call even if Chrome wasn't launched by us (no-op).
 */
export const killChrome = (): void => {
  if (childProcess) {
    try {
      childProcess.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    childProcess = null;
    logger.info("Chrome process terminated");
  }
};

/**
 * Returns true if we launched Chrome and it's still running.
 */
export const isChromeRunning = (): boolean => {
  return childProcess !== null && childProcess.exitCode === null;
};

// Stores the options used for the initial launch so ensureChromeRunning
// can relaunch with the same settings.
let lastLaunchOptions: ChromeLauncherOptions | null = null;

/**
 * Check whether Chrome is reachable on the debug port.  If not, relaunch it
 * automatically.  Call this at the top of any browser-tool handler so Chrome
 * self-heals after crashes, user-closes, or server restarts.
 *
 * Returns `true` if Chrome is reachable (or was successfully relaunched),
 * `false` if no Chrome binary could be found.
 */
export const ensureChromeRunning = async (
  options?: ChromeLauncherOptions
): Promise<boolean> => {
  const opts = options ?? lastLaunchOptions ?? {};
  const host = opts.host ?? "localhost";
  const port = opts.port ?? DEFAULT_PORT;

  const reachable = await isDebugPortReachable(host, port);
  if (reachable) return true;

  logger.info("Chrome not reachable — attempting relaunch");
  return launchChrome({ ...opts, reuseExisting: false });
};
