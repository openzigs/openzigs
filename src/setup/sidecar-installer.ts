/**
 * SidecarInstaller — wraps existing sidecar install scripts in
 * `scripts/start-mac-sidecars.sh` and related shell tooling.
 *
 * Issue #1159 — Wizard: sidecar installer step (cross-platform detect/install).
 *
 * The 8 sidecars are the Python services under `sidecars/`:
 *   audio, image-gen, image-processing, lipsync, music, music-studio, v2a,
 *   sadtalker.
 *
 * Detection: presence of `server.py` and `venv/` directory inside the sidecar
 * folder is treated as "installed". Install: spawns the OS-appropriate install
 * script and streams stdout/stderr to the caller via an async iterator.
 *
 * Security: sidecar names are validated against a closed allowlist before they
 * are interpolated into any file path, preventing path-traversal.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";

export const SIDECAR_NAMES = [
  "audio",
  "image-gen",
  "image-processing",
  "lipsync",
  "music",
  "music-studio",
  "v2a",
  "sadtalker",
] as const;

export type SidecarName = (typeof SIDECAR_NAMES)[number];

export interface SidecarStatus {
  name: SidecarName;
  installed: boolean;
  hasServer: boolean;
  hasVenv: boolean;
  description: string;
}

const DESCRIPTIONS: Record<SidecarName, string> = {
  audio: "Speech synthesis (F5-TTS, GPT-SoVITS, Coqui)",
  "image-gen": "Image generation (SDXL, Flux)",
  "image-processing": "OCR, background removal, upscaling",
  lipsync: "Lip-sync video (LatentSync, Wav2Lip)",
  music: "Music generation (MusicGen)",
  "music-studio": "DAW-style music composition",
  v2a: "Video-to-audio (foley, ambience)",
  sadtalker: "Talking-head avatar from a still image",
};

export interface OsInfo {
  platform: NodeJS.Platform;
  arch: string;
}

export interface SidecarInstallerOptions {
  /** Override the repo root (where `scripts/` and `sidecars/` live). */
  repoRoot?: string;
  /** Override OS info in tests. */
  osInfo?: OsInfo;
}

export class SidecarInstaller {
  private readonly repoRoot: string;
  private readonly osInfo: OsInfo;

  constructor(options: SidecarInstallerOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.osInfo = options.osInfo ?? {
      platform: os.platform(),
      arch: os.arch(),
    };
  }

  /** Lists all 8 sidecars with installation status. */
  async listStatus(): Promise<SidecarStatus[]> {
    return Promise.all(SIDECAR_NAMES.map((n) => this.statusOf(n)));
  }

  async statusOf(name: SidecarName): Promise<SidecarStatus> {
    assertKnownSidecar(name);
    const dir = path.join(this.repoRoot, "sidecars", name);
    const hasServer = await fileExists(path.join(dir, "server.py"));
    const hasVenv = await fileExists(path.join(dir, "venv"));
    return {
      name,
      installed: hasServer && hasVenv,
      hasServer,
      hasVenv,
      description: DESCRIPTIONS[name],
    };
  }

  /** Returns the install script path for the current OS. */
  installScript(): { script: string; supported: boolean } {
    if (this.osInfo.platform === "darwin") {
      return {
        script: path.join(this.repoRoot, "scripts", "start-mac-sidecars.sh"),
        supported: true,
      };
    }
    if (this.osInfo.platform === "linux") {
      return {
        script: path.join(this.repoRoot, "scripts", "setup-cuda-sidecars.sh"),
        supported: true,
      };
    }
    if (this.osInfo.platform === "win32") {
      return {
        script: path.join(this.repoRoot, "scripts", "setup-cuda-sidecars.sh"),
        supported: false,
      };
    }
    return { script: "", supported: false };
  }

  /**
   * Spawns the install script and yields stdout/stderr chunks.
   *
   * The sidecar name is validated against the allowlist before being passed
   * as the script's argument, so users cannot inject arbitrary shell.
   */
  async *streamInstall(
    name: SidecarName,
  ): AsyncGenerator<InstallEvent, void, void> {
    assertKnownSidecar(name);
    const { script, supported } = this.installScript();
    if (!supported) {
      yield {
        kind: "error",
        message: `Automatic install not supported on ${this.osInfo.platform}. See docs/INSTALL.md.`,
      };
      yield { kind: "done", code: 1 };
      return;
    }
    if (!(await fileExists(script))) {
      yield { kind: "error", message: `Install script not found: ${script}` };
      yield { kind: "done", code: 1 };
      return;
    }

    yield {
      kind: "log",
      stream: "info",
      message: `Running ${path.basename(script)} for sidecar "${name}"...`,
    };

    const child = spawn("bash", [script, name], {
      cwd: this.repoRoot,
      env: { ...process.env, OPENZIGS_SIDECAR: name },
    });

    const chunks: InstallEvent[] = [];
    let resolveNext: ((v: void) => void) | null = null;
    const wait = () =>
      new Promise<void>((r) => {
        resolveNext = r;
      });
    const push = (evt: InstallEvent) => {
      chunks.push(evt);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };
    child.stdout.on("data", (b: Buffer) =>
      push({ kind: "log", stream: "stdout", message: b.toString("utf-8") }),
    );
    child.stderr.on("data", (b: Buffer) =>
      push({ kind: "log", stream: "stderr", message: b.toString("utf-8") }),
    );
    let exitCode: number | null = null;
    child.on("close", (code) => {
      exitCode = code ?? 0;
      push({ kind: "done", code: exitCode });
    });

    while (true) {
      if (chunks.length === 0) {
        if (exitCode !== null) break;
        await wait();
      }
      while (chunks.length > 0) {
        const evt = chunks.shift()!;
        yield evt;
        if (evt.kind === "done") return;
      }
    }
  }
}

export type InstallEvent =
  | { kind: "log"; stream: "stdout" | "stderr" | "info"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done"; code: number };

function assertKnownSidecar(name: string): asserts name is SidecarName {
  if (!(SIDECAR_NAMES as readonly string[]).includes(name)) {
    throw new Error(`unknown sidecar: ${name}`);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
