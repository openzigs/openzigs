/**
 * Platform capability detection module.
 *
 * Provides a typed capabilities object describing the host OS, architecture,
 * Docker availability, native sidecar support (macOS ARM only), and Chrome
 * path. Used by server startup and UI feature gating.
 *
 * Issue #599
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import childProcess from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────────

export type PlatformCapabilities = {
  /** Normalised OS: "darwin", "win32", "linux" */
  os: NodeJS.Platform;
  /** CPU architecture: "arm64", "x64", etc. */
  arch: string;
  /** Whether Docker is available on the host */
  dockerAvailable: boolean;
  /** Native macOS-ARM sidecars (image-gen, audio, music, etc.) */
  sidecarsSupported: boolean;
  /** Resolved Chrome / Chromium executable path, or null */
  chromePath: string | null;
  /** Whether the OS is Windows */
  isWindows: boolean;
  /** Whether the OS is macOS */
  isMacOS: boolean;
  /** Whether the OS is Linux */
  isLinux: boolean;
};

// ── Chrome discovery ─────────────────────────────────────────────────────────

/** Exported for testing — find Chrome/Chromium executable path. */
export function findChromePath(platformOverride?: NodeJS.Platform): string | null {
  const platform = platformOverride ?? process.platform;

  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (platform === "win32") {
    const programFiles = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else {
    // Linux
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
    );
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not accessible, try next
    }
  }

  return null;
}

// ── Docker detection ─────────────────────────────────────────────────────────

/** Exported for testing — check Docker availability synchronously. */
export function isDockerAvailableSync(): boolean {
  try {
    childProcess.execSync("docker info", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Detect platform capabilities.
 *
 * All checks are synchronous so the result can be used during server
 * initialisation without async bootstrapping.
 *
 * @param overrides — optional partial overrides for testing
 */
export function getPlatformCapabilities(
  overrides?: Partial<PlatformCapabilities>,
): PlatformCapabilities {
  const currentOS = process.platform;
  const arch = os.arch();

  const base: PlatformCapabilities = {
    os: currentOS,
    arch,
    dockerAvailable: isDockerAvailableSync(),
    // Native sidecars (image-gen, music-studio etc.)
    // only work on macOS ARM (Apple Silicon) currently
    sidecarsSupported: currentOS === "darwin" && arch === "arm64",
    chromePath: findChromePath(),
    isWindows: currentOS === "win32",
    isMacOS: currentOS === "darwin",
    isLinux: currentOS === "linux",
  };

  return { ...base, ...overrides };
}
