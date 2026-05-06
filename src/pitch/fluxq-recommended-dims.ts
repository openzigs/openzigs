/**
 * Pitch — FluxQ recommended-dimension probe + clamp helper.
 *
 * Bug-fix for post-PR-#1017 walkthrough: the deck editor was enqueuing
 * flux-schnell jobs at full slide resolution (1920×1080) which exceeds
 * FluxQ's published `recommended_width` / `recommended_height` on a 12 GB
 * GPU and OOMs every job after 3 retries. The fix is to fetch FluxQ's
 * `/health` once at fan-out time, cache the advertised recommended dims,
 * and clamp every txt2img request to that ceiling before it's sent.
 *
 * Fallback when `/health` is unreachable or doesn't advertise dims:
 * 1024×576 — flux-schnell's published sweet spot for 12 GB GPUs and the
 * default in `MODEL_REGISTRY` for `flux-schnell` / `flux-dev`.
 *
 * The slide template is rendered at 1920×1080 by Reveal; the smaller PNG
 * is CSS-scaled with `object-fit: cover` (or stretched) — an acceptable
 * trade-off vs. zero images appearing.
 */

export interface FluxQRecommendedDims {
  width: number;
  height: number;
}

export const FLUXQ_FALLBACK_DIMS: Readonly<FluxQRecommendedDims> = Object.freeze(
  {
    width: 1024,
    height: 576,
  },
);

let cached: FluxQRecommendedDims | undefined;

/**
 * Bug-fix (post-PR-#1041 walkthrough): the bulk "Generate all images"
 * button silently enqueued 12 doomed jobs when the FluxQ sidecar was
 * running but had lost its CUDA accelerator (every job came back with
 * "`enable_model_cpu_offload` requires accelerator, but not found").
 * The probe now also captures whether FluxQ has a usable GPU so the
 * route handler can short-circuit with a 503 BEFORE fan-out.
 *
 * Tri-state by design:
 *   - `true`   FluxQ reports a working CUDA device
 *   - `false`  FluxQ reports `available: false` (or `device != "cuda"`)
 *   - `undefined`  probe was never run, or it failed to reach the sidecar
 *                  (in which case we fall through to the legacy "best
 *                  effort" behaviour and let the queue surface failures)
 */
let cachedGpuAvailable: boolean | undefined;

/** Default sidecar URL — mirrors `image-gen-service.ts`. */
function defaultSidecarUrl(): string {
  return process.env.IMAGE_GEN_SIDECAR_URL ?? "http://127.0.0.1:5005";
}

/**
 * Probe FluxQ's `/health` endpoint and cache the advertised recommended
 * width/height. Safe to call repeatedly; subsequent calls overwrite the
 * cache. Never throws — on any failure the cache is set to the fallback
 * and the fallback is returned.
 */
export async function refreshFluxQRecommendedDims(
  url?: string,
): Promise<FluxQRecommendedDims> {
  const target = url ?? defaultSidecarUrl();
  try {
    const res = await fetch(`${target}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      throw new Error(`status ${res.status}`);
    }
    const data = (await res.json()) as {
      recommended_width?: unknown;
      recommended_height?: unknown;
    };
    const w = Number(data.recommended_width);
    const h = Number(data.recommended_height);
    if (Number.isFinite(w) && w >= 64 && Number.isFinite(h) && h >= 64) {
      cached = { width: Math.floor(w), height: Math.floor(h) };
      return cached;
    }
  } catch {
    // Swallow — fall through to fallback below.
  }
  cached = { ...FLUXQ_FALLBACK_DIMS };
  return cached;
}

/**
 * Synchronous getter — returns the most recently cached recommendation,
 * or the fallback if the cache is empty. This is what
 * {@link clampToFluxQRecommendedDims} consults when callers can't await
 * a probe (e.g. the synchronous `enqueueSlideImage` entrypoint).
 */
export function getCachedFluxQRecommendedDims(): FluxQRecommendedDims {
  return cached ?? { ...FLUXQ_FALLBACK_DIMS };
}

/**
 * Synchronous getter — returns the most recently observed GPU availability
 * flag, or `undefined` if no successful probe has happened yet. See the
 * {@link cachedGpuAvailable} doc comment for the tri-state semantics.
 */
export function getCachedFluxQGpuAvailable(): boolean | undefined {
  return cachedGpuAvailable;
}

/**
 * Probe FluxQ's `/gpu-info` endpoint and cache whether a usable GPU is
 * present. Safe to call repeatedly. Never throws — on any transport or
 * shape error the cache is cleared (set back to `undefined`) and
 * `undefined` is returned so callers can distinguish "definitely no GPU"
 * from "we don't know yet".
 *
 * Bug-fix: previously used a 2 s timeout which was too short when the
 * sidecar was mid-model-load — the timeout silently returned `undefined`
 * instead of the definitive `available: false`, bypassing the 503
 * guard and enqueuing doomed jobs. Now retries up to 3 times with a
 * 5 s timeout per attempt so a slow-but-reachable sidecar still
 * delivers a definitive answer.
 */
export async function refreshFluxQGpuAvailable(
  url?: string,
): Promise<boolean | undefined> {
  const target = url ?? defaultSidecarUrl();
  const maxAttempts = 3;
  const timeoutMs = 5_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${target}/gpu-info`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        cachedGpuAvailable = undefined;
        return undefined;
      }
      const data = (await res.json()) as { available?: unknown };
      if (typeof data.available === "boolean") {
        cachedGpuAvailable = data.available;
        return cachedGpuAvailable;
      }
      cachedGpuAvailable = undefined;
      return undefined;
    } catch {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      cachedGpuAvailable = undefined;
      return undefined;
    }
  }
  cachedGpuAvailable = undefined;
  return undefined;
}

/**
 * Clamp the requested width/height down to the FluxQ-advertised
 * recommended ceiling. If either dim is missing, the recommended value
 * is used directly. Never up-scales — a caller asking for 256×256 still
 * gets 256×256.
 */
export function clampToFluxQRecommendedDims(
  width?: number,
  height?: number,
): FluxQRecommendedDims {
  const rec = getCachedFluxQRecommendedDims();
  const w =
    typeof width === "number" && Number.isFinite(width) && width > 0
      ? Math.min(Math.floor(width), rec.width)
      : rec.width;
  const h =
    typeof height === "number" && Number.isFinite(height) && height > 0
      ? Math.min(Math.floor(height), rec.height)
      : rec.height;
  return { width: w, height: h };
}

// ── Test hooks ─────────────────────────────────────────────────────────

export function _resetFluxQDimsCacheForTest(): void {
  cached = undefined;
  cachedGpuAvailable = undefined;
}

export function _setFluxQDimsCacheForTest(
  v: FluxQRecommendedDims | undefined,
): void {
  cached = v ? { ...v } : undefined;
}

export function _setFluxQGpuAvailableForTest(v: boolean | undefined): void {
  cachedGpuAvailable = v;
}
