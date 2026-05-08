/**
 * Platform profile detection (epic #1053 / issue #1063).
 *
 * Returns a typed `PlatformProfile` describing OS, architecture, chip family
 * (best-effort on Apple Silicon via `sysctl`), unified-memory size, GPU kind,
 * and the recommended LLM backend for the host. Used by:
 *   - `GET /api/system/platform`
 *   - the System Requirements UI card on the admin/setup pages
 *   - the setup wizard for offline-mode walkthroughs
 *
 * IMPORTANT — Mac code paths cannot be live-tested on the dev rig (Windows + 2x
 * NVIDIA). Every platform branch is unit-testable via dependency injection
 * (`detectPlatformProfile({ platform, arch, totalMemoryBytes, runSysctl, runNvidiaSmi })`)
 * and has tests stubbing each combination. Live Mac validation is deferred
 * to a separate validation pass on a Mac.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

export type PlatformOS = "windows" | "macos" | "linux";
export type PlatformArch = "x64" | "arm64" | "unknown";
export type GpuKind = "nvidia" | "apple-silicon" | "amd" | "none";
export type RecommendedBackend =
  | "ollama-mlx"
  | "ollama-cuda"
  | "vllm-cuda"
  | "ollama-cpu";

export interface PlatformProfile {
  os: PlatformOS;
  arch: PlatformArch;
  /** Best-effort chip identifier; "Apple M3 Pro", "Intel x86_64", etc. */
  chip: string | null;
  /** Total system RAM in bytes. On Apple Silicon this IS the GPU memory ceiling. */
  totalMemoryBytes: number;
  /**
   * Unified memory size in bytes. ONLY set on Apple Silicon — equals
   * totalMemoryBytes because GPU shares the same RAM pool. `null` everywhere
   * else (where VRAM is reported separately by the GPU profile module).
   */
  unifiedMemoryBytes: number | null;
  /** GPU family. `none` covers CPU-only hosts. */
  gpuKind: GpuKind;
  /** Best-fit local-LLM backend for the host. */
  recommendedBackend: RecommendedBackend;
  /** ISO timestamp of when this profile was computed. */
  detectedAt: string;
}

export type PlatformDetectorOptions = {
  /** Override `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override `process.arch`. */
  arch?: string;
  /** Override total RAM bytes (default `os.totalmem()`). */
  totalMemoryBytes?: number;
  /** Override `sysctl -n machdep.cpu.brand_string` runner (Apple Silicon chip detection). */
  runSysctl?: () => string;
  /** Override `nvidia-smi -L` runner (NVIDIA GPU detection). */
  runNvidiaSmi?: () => string;
  /** ISO timestamp for the detected profile. Default = `new Date().toISOString()`. */
  now?: () => Date;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const normaliseOs = (platform: NodeJS.Platform): PlatformOS => {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  // Other platforms (freebsd, sunos, aix...) collapse to linux for runtime
  // assumptions (POSIX-ish). The recommendedBackend stays "ollama-cpu" unless
  // an NVIDIA GPU is detected.
  return "linux";
};

const normaliseArch = (arch: string): PlatformArch => {
  if (arch === "x64" || arch === "amd64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return "unknown";
};

const safeRunSysctl = (): string => {
  try {
    return execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

const safeRunNvidiaSmi = (): string => {
  try {
    return execFileSync("nvidia-smi", ["-L"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Detect the host's platform profile.
 *
 * All inputs are injectable so each branch is unit-testable on any host —
 * critical because the dev rig is Windows+NVIDIA and cannot exercise the
 * Apple Silicon path live.
 */
export function detectPlatformProfile(
  options: PlatformDetectorOptions = {},
): PlatformProfile {
  const platform = options.platform ?? process.platform;
  const archRaw = options.arch ?? process.arch;
  const totalMemoryBytes = options.totalMemoryBytes ?? os.totalmem();
  const now = options.now ?? (() => new Date());

  const osName = normaliseOs(platform);
  const arch = normaliseArch(archRaw);

  // ── Chip detection ────────────────────────────────────────────────────────
  let chip: string | null = null;
  if (osName === "macos" && arch === "arm64") {
    const runSysctl = options.runSysctl ?? safeRunSysctl;
    const out = runSysctl();
    chip = out.length > 0 ? out : "Apple Silicon";
  } else {
    chip = `${archRaw} CPU`;
  }

  // ── GPU detection ─────────────────────────────────────────────────────────
  let gpuKind: GpuKind = "none";
  if (osName === "macos" && arch === "arm64") {
    gpuKind = "apple-silicon";
  } else {
    const runNvidiaSmi = options.runNvidiaSmi ?? safeRunNvidiaSmi;
    const smi = runNvidiaSmi();
    if (smi.length > 0 && /GPU \d+:/i.test(smi)) {
      gpuKind = "nvidia";
    }
  }

  // ── Unified memory (Apple Silicon only) ───────────────────────────────────
  const unifiedMemoryBytes =
    osName === "macos" && arch === "arm64" ? totalMemoryBytes : null;

  // ── Recommended backend ───────────────────────────────────────────────────
  let recommendedBackend: RecommendedBackend;
  if (gpuKind === "apple-silicon") {
    recommendedBackend = "ollama-mlx";
  } else if (gpuKind === "nvidia") {
    // vLLM is only worth the operational cost on multi-GPU hosts. Single-GPU
    // boxes get the Ollama default (simpler ops, single binary, faster cold
    // start). Callers can override via config; this is just a recommendation.
    recommendedBackend = "ollama-cuda";
  } else {
    recommendedBackend = "ollama-cpu";
  }

  return {
    os: osName,
    arch,
    chip,
    totalMemoryBytes,
    unifiedMemoryBytes,
    gpuKind,
    recommendedBackend,
    detectedAt: now().toISOString(),
  };
}

// ── Recommended Gemma 4 variant by hardware budget ───────────────────────────

/**
 * Map a `PlatformProfile` to a recommended Gemma 4 model id + quantisation.
 * Encodes the planner-locked sizing matrix from the epic decision doc.
 *
 * Rules (per locked product-owner decision 2026-05-08):
 *   - Windows / Linux + NVIDIA 16-23 GB    → gemma4:26b Q4
 *   - Windows / Linux + NVIDIA 24+ GB      → gemma4:26b Q4 (default) or
 *                                            gemma4:31b INT4 (advanced)
 *   - Mac < 16 GB unified                  → gemma4:e4b only
 *   - Mac 16-23 GB                         → gemma4:26b Q3 / Q4_K_S
 *   - Mac 24-35 GB                         → gemma4:26b Q4_K_M
 *   - Mac 36-63 GB                         → gemma4:31b INT4
 *   - Mac 64+ GB                           → gemma4:31b Q4_K_M / FP8
 *
 * `largestGpuVramBytes` is consulted on NVIDIA hosts; the unified memory pool
 * is consulted on Apple Silicon. Both are optional — when unknown the function
 * falls back to the smallest viable variant.
 */
export type RecommendedModel = {
  modelId: string;
  quantisation: string;
  /** Free-form note explaining the choice, surfaced verbatim in the UI. */
  rationale: string;
  /** Minimum memory budget required to run this variant (bytes). */
  minMemoryBytes: number;
};

const GB = 1024 * 1024 * 1024;

export function recommendGemma4Variant(
  profile: PlatformProfile,
  options: { largestGpuVramBytes?: number } = {},
): RecommendedModel {
  if (profile.gpuKind === "apple-silicon") {
    const unified = profile.unifiedMemoryBytes ?? 0;
    if (unified < 16 * GB) {
      return {
        modelId: "gemma4:e4b",
        quantisation: "Q4",
        rationale:
          "Apple Silicon < 16 GB unified memory: only the 4B-effective E4B variant fits comfortably.",
        minMemoryBytes: 6 * GB,
      };
    }
    if (unified < 24 * GB) {
      return {
        modelId: "gemma4:26b",
        quantisation: "Q3 / Q4_K_S",
        rationale:
          "Apple Silicon 16–23 GB: 26B at Q3 or Q4_K_S keeps a workable KV cache.",
        minMemoryBytes: 14 * GB,
      };
    }
    if (unified < 36 * GB) {
      return {
        modelId: "gemma4:26b",
        quantisation: "Q4_K_M",
        rationale:
          "Apple Silicon 24–35 GB: 26B Q4_K_M is the sweet spot — quality + headroom for browsing/tool calls.",
        minMemoryBytes: 18 * GB,
      };
    }
    if (unified < 64 * GB) {
      return {
        modelId: "gemma4:31b",
        quantisation: "INT4",
        rationale:
          "Apple Silicon 36–63 GB: 31B dense at INT4 — competitive with Claude Haiku.",
        minMemoryBytes: 22 * GB,
      };
    }
    return {
      modelId: "gemma4:31b",
      quantisation: "Q4_K_M / FP8",
      rationale:
        "Apple Silicon 64 GB+: 31B Q4_K_M (or FP8 on M3 Ultra+) — full quality, near-cloud latency with MLX.",
      minMemoryBytes: 32 * GB,
    };
  }

  if (profile.gpuKind === "nvidia") {
    const vram = options.largestGpuVramBytes ?? 0;
    if (vram >= 24 * GB) {
      return {
        modelId: "gemma4:26b",
        quantisation: "Q4 (default) / 31b INT4 (advanced)",
        rationale:
          "NVIDIA 24+ GB VRAM: 26B Q4 fits with KV headroom; switch to 31B INT4 if you need stronger reasoning.",
        minMemoryBytes: 18 * GB,
      };
    }
    if (vram >= 16 * GB) {
      return {
        modelId: "gemma4:26b",
        quantisation: "Q4",
        rationale:
          "NVIDIA 16–23 GB VRAM: 26B Q4 — fits with conservative KV cache.",
        minMemoryBytes: 16 * GB,
      };
    }
    return {
      modelId: "gemma4:e4b",
      quantisation: "Q4",
      rationale:
        "NVIDIA < 16 GB VRAM: stick with the E4B variant. Larger Gemma 4 variants will OOM under load.",
      minMemoryBytes: 6 * GB,
    };
  }

  // CPU-only hosts get the smallest variant.
  return {
    modelId: "gemma4:e4b",
    quantisation: "Q4",
    rationale:
      "No discrete GPU detected: only the 4B-effective E4B variant is realistic on CPU. Expect 2–6 tok/s.",
    minMemoryBytes: 6 * GB,
  };
}
