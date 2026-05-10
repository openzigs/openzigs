/**
 * GPU profile detection.
 *
 * Spawns `nvidia-smi` once at boot to enumerate CUDA devices and exposes
 * a cached profile used by the sidecar pinning policy and the /api/system/gpu
 * endpoint. Falls back gracefully when nvidia-smi is missing (CPU-only host or
 * macOS / non-NVIDIA box).
 *
 * Issue #1071: on `darwin` the spawn is skipped entirely — there is no
 * `nvidia-smi` on Mac and we don't want to pay the spawn cost (or risk
 * shadowing a stray PATH binary). The profile reports a single Apple Silicon
 * Metal device with `unified: true` so the admin GPU panel can render a Mac
 * row without inheriting NVIDIA-shaped fields.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GpuInfo {
  index: number;
  name: string;
  total_mb: number;
  free_mb: number;
}

export type ModelTier = "low" | "medium" | "high" | "ultra";

export interface GpuProfile {
  detected: boolean;
  gpus: GpuInfo[];
  total_vram_gb: number;
  /** Largest single-GPU VRAM in GB. Caps `recommended_tier` because model
   *  parallelism is opt-in (see issue #886) so the safe default tier is
   *  bound by the biggest individual card. */
  largest_gpu_gb: number;
  /** Tier bound by the largest single GPU. The safe default — every
   *  shipped model fits on one card. */
  recommended_tier: ModelTier;
  /** Tier bound by the *aggregate* VRAM across all GPUs. Advisory only;
   *  reachable only when the user explicitly opts a sidecar into pooling
   *  mode (e.g. `IMAGE_GEN_POOLING_MODE=manual-flux`). Undefined when
   *  pooling is not supported. */
  recommended_tier_pooled?: ModelTier;
  /** True when the host has ≥2 GPUs of the same model (sharding viable). */
  pooling_supported: boolean;
  /** True when all detected GPUs report the same `name` field. Mixed-arch
   *  pools work in theory but are not validated and can deadlock on NCCL
   *  collective ops, so we surface this so the UI can warn. */
  same_arch: boolean;
  /** Current pooling mode from user config (e.g. `"manual-flux"` or `"off"`). */
  pooling_mode?: string;
  /** Default device-pin map: sidecar id → CUDA device index. */
  pinning: Record<string, number>;
  /**
   * Apple Silicon block (issue #1071). Populated only on `darwin/arm64`.
   * `unified: true` flags that the device shares its memory pool with the
   * CPU — there is no separate VRAM ceiling. NVIDIA-only fields
   * (`gpus[]`, `total_vram_gb`, `pinning`) collapse to their empty/0
   * defaults on Mac so consumers don't accidentally render CUDA labels.
   */
  apple_silicon?: {
    name: string;
    unified: true;
    unified_memory_gb: number;
  };
  detected_at: string;
}

const NVIDIA_SMI_QUERY = "index,name,memory.total,memory.free";

/** Compute the recommended tier from a VRAM budget in GB. Used for both
 *  single-card (`largestGpuGb`) and pooled (`total_vram_gb`) tiers. */
export function tierForVram(vramGb: number): ModelTier {
  if (vramGb >= 24) return "ultra";
  if (vramGb >= 16) return "high";
  if (vramGb >= 11) return "medium"; // 11 instead of 12 — RTX 3060 reports ~12.0 but free ~11.6
  return "low";
}

/** Default sidecar→GPU pinning. Audio + image-gen on GPU 0, video + lipsync
 *  on GPU 1 when ≥2 GPUs are present so the talking-head pipeline can overlap
 *  TTS, video generation, and lipsync. Single-GPU systems use index 0 for all. */
export function defaultPinning(gpuCount: number): Record<string, number> {
  if (gpuCount <= 1) {
    return { "image-gen": 0, audio: 0, worker: 0, lipsync: 0, sadtalker: 0 };
  }
  return { "image-gen": 0, audio: 0, worker: 1, lipsync: 1, sadtalker: 1 };
}

function parseNvidiaSmiCsv(stdout: string): GpuInfo[] {
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const out: GpuInfo[] = [];
  for (const row of rows) {
    // CSV from `nvidia-smi --format=csv,noheader,nounits`:
    //   "0, NVIDIA GeForce RTX 3060, 12288, 11762"
    const parts = row.split(",").map((p) => p.trim());
    if (parts.length < 4) continue;
    const index = Number.parseInt(parts[0], 10);
    const total = Number.parseInt(parts[2], 10);
    const free = Number.parseInt(parts[3], 10);
    if (Number.isNaN(index) || Number.isNaN(total)) continue;
    out.push({
      index,
      name: parts[1],
      total_mb: total,
      free_mb: Number.isNaN(free) ? 0 : free,
    });
  }
  return out;
}

export interface DetectGpuProfileOptions {
  /** Override the executor — primarily for tests. */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  /** Optional WSL distro to query (Windows hosts where CUDA is in WSL2). */
  wslDistro?: string;
  /** Override `process.platform` (default `process.platform`). Used so the
   *  Apple Silicon branch can be exercised on the Windows test rig. */
  platform?: NodeJS.Platform;
  /** Override `os.totalmem()` (default `os.totalmem()`). Apple Silicon
   *  reports the unified memory pool here. */
  totalMemoryBytes?: number;
}

/**
 * Detect GPUs by invoking `nvidia-smi`. Returns a profile with `detected:false`
 * and an empty gpus list when nvidia-smi cannot be executed (no NVIDIA driver
 * or non-Linux/Windows host). Never throws.
 */
export async function detectGpuProfile(
  opts: DetectGpuProfileOptions = {},
): Promise<GpuProfile> {
  const platform = opts.platform ?? process.platform;

  // Apple Silicon: skip nvidia-smi entirely. Surface the unified-memory Metal
  // device so the admin GPU panel can render a Mac row.
  if (platform === "darwin") {
    const totalBytes = opts.totalMemoryBytes ?? totalmem();
    const unifiedGb = Math.round(totalBytes / 1024 / 1024 / 1024);
    return {
      detected: false,
      gpus: [],
      total_vram_gb: 0,
      largest_gpu_gb: 0,
      recommended_tier: "low",
      pooling_supported: false,
      same_arch: false,
      pinning: defaultPinning(0),
      apple_silicon: {
        name: "Apple Silicon GPU (Metal)",
        unified: true,
        unified_memory_gb: unifiedGb,
      },
      detected_at: new Date().toISOString(),
    };
  }

  const exec =
    opts.exec ??
    (async (cmd: string, args: string[]) => {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
      return { stdout };
    });

  const args = [
    `--query-gpu=${NVIDIA_SMI_QUERY}`,
    "--format=csv,noheader,nounits",
  ];

  let stdout = "";
  try {
    if (opts.wslDistro) {
      const result = await exec("wsl", [
        "-d",
        opts.wslDistro,
        "--",
        "nvidia-smi",
        ...args,
      ]);
      stdout = result.stdout;
    } else {
      const result = await exec("nvidia-smi", args);
      stdout = result.stdout;
    }
  } catch {
    return {
      detected: false,
      gpus: [],
      total_vram_gb: 0,
      largest_gpu_gb: 0,
      recommended_tier: "low",
      pooling_supported: false,
      same_arch: false,
      pinning: defaultPinning(0),
      detected_at: new Date().toISOString(),
    };
  }

  const gpus = parseNvidiaSmiCsv(stdout);
  const total_mb = gpus.reduce((sum, g) => sum + g.total_mb, 0);
  const largest_mb = gpus.reduce((m, g) => Math.max(m, g.total_mb), 0);
  const largest_gpu_gb = Math.round(largest_mb / 1024);
  const total_vram_gb = Math.round(total_mb / 1024);
  const same_arch =
    gpus.length > 0 && gpus.every((g) => g.name === gpus[0].name);
  // Pooling needs ≥2 GPUs and is only validated for same-arch hosts.
  const pooling_supported = gpus.length >= 2 && same_arch;

  return {
    detected: gpus.length > 0,
    gpus,
    total_vram_gb,
    largest_gpu_gb,
    recommended_tier: tierForVram(largest_gpu_gb),
    recommended_tier_pooled: pooling_supported
      ? tierForVram(total_vram_gb)
      : undefined,
    pooling_supported,
    same_arch,
    pinning: defaultPinning(gpus.length),
    detected_at: new Date().toISOString(),
  };
}

let cachedProfile: GpuProfile | null = null;

/** Read `gpu.poolingMode` from the user config file.  Returns `undefined`
 *  when the config file is missing or doesn't contain the key. */
async function readPoolingModeFromConfig(): Promise<string | undefined> {
  try {
    const configPath =
      process.env.OPENZIGS_CONFIG_PATH ??
      join(homedir(), ".openzigs", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const gpu = config?.gpu;
    if (gpu && typeof gpu === "object" && "poolingMode" in gpu) {
      const mode = (gpu as Record<string, unknown>).poolingMode;
      if (typeof mode === "string") return mode;
    }
  } catch {
    // Config file may not exist — not an error.
  }
  return undefined;
}

export async function getGpuProfile(
  opts?: DetectGpuProfileOptions,
): Promise<GpuProfile> {
  if (cachedProfile) return cachedProfile;
  const profile = await detectGpuProfile(opts);
  profile.pooling_mode = await readPoolingModeFromConfig();
  cachedProfile = profile;
  return cachedProfile;
}

/** Test-only: reset the cached profile. */
export function _resetGpuProfileCache(): void {
  cachedProfile = null;
}
