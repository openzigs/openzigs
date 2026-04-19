/**
 * GPU profile detection.
 *
 * Spawns `nvidia-smi` once at boot to enumerate CUDA devices and exposes
 * a cached profile used by the sidecar pinning policy and the /api/system/gpu
 * endpoint. Falls back gracefully when nvidia-smi is missing (CPU-only host or
 * macOS / non-NVIDIA box).
 */
import { execFile } from "node:child_process";
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
  /** Largest single-GPU VRAM in GB. Caps recommended_tier — model parallelism
   *  is opt-in (see issue #886) so tier is bound by the *biggest* card. */
  largest_gpu_gb: number;
  recommended_tier: ModelTier;
  /** Default device-pin map: sidecar id → CUDA device index. */
  pinning: Record<string, number>;
  detected_at: string;
}

const NVIDIA_SMI_QUERY = "index,name,memory.total,memory.free";

/** Compute the recommended tier from the largest single-GPU VRAM in GB. */
export function tierForVram(largestGpuGb: number): ModelTier {
  if (largestGpuGb >= 24) return "ultra";
  if (largestGpuGb >= 16) return "high";
  if (largestGpuGb >= 11) return "medium"; // 11 instead of 12 — RTX 3060 reports ~12.0 but free ~11.6
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
}

/**
 * Detect GPUs by invoking `nvidia-smi`. Returns a profile with `detected:false`
 * and an empty gpus list when nvidia-smi cannot be executed (no NVIDIA driver
 * or non-Linux/Windows host). Never throws.
 */
export async function detectGpuProfile(
  opts: DetectGpuProfileOptions = {},
): Promise<GpuProfile> {
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
      pinning: defaultPinning(0),
      detected_at: new Date().toISOString(),
    };
  }

  const gpus = parseNvidiaSmiCsv(stdout);
  const total_mb = gpus.reduce((sum, g) => sum + g.total_mb, 0);
  const largest_mb = gpus.reduce((m, g) => Math.max(m, g.total_mb), 0);
  const largest_gpu_gb = Math.round(largest_mb / 1024);

  return {
    detected: gpus.length > 0,
    gpus,
    total_vram_gb: Math.round(total_mb / 1024),
    largest_gpu_gb,
    recommended_tier: tierForVram(largest_gpu_gb),
    pinning: defaultPinning(gpus.length),
    detected_at: new Date().toISOString(),
  };
}

let cachedProfile: GpuProfile | null = null;

export async function getGpuProfile(
  opts?: DetectGpuProfileOptions,
): Promise<GpuProfile> {
  if (cachedProfile) return cachedProfile;
  cachedProfile = await detectGpuProfile(opts);
  return cachedProfile;
}

/** Test-only: reset the cached profile. */
export function _resetGpuProfileCache(): void {
  cachedProfile = null;
}
