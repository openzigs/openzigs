/**
 * System info endpoints — GPU profile, model recommendations, platform.
 * Issue #885 (Epic #883).
 *
 * Issue #917 (Epic #888): merge GPU coordinator state into the GPU
 * response so the UI can render mutual-exclusion conflicts and the
 * current serving mode (idle / diffusion / vllm-tp2 / mixed).
 *
 * Issue #1063 (Epic #1053): add `GET /platform` for the System
 * Requirements UI card and the offline setup wizard.
 */
import { Router } from "express";

import { getGpuProfile, type GpuProfile } from "../system/gpu-profile.js";
import {
  detectPlatformProfile,
  recommendGemma4Variant,
  type PlatformProfile,
  type RecommendedModel,
} from "../system/platform-detector.js";
import {
  summariseClaims,
  type GpuCoordinator,
} from "../gpu/gpu-coordinator.js";
import type { GpuDispatcher, GpuLaneSnapshot } from "../gpu/gpu-dispatcher.js";

export interface SystemRouterDeps {
  /** Override profile loader for tests. */
  loadProfile?: () => Promise<GpuProfile>;
  /** Override platform detector for tests. */
  loadPlatform?: () => PlatformProfile;
  /**
   * GPU coordinator used to surface `serving_mode` and `conflicts[]`.
   * Optional so legacy callers (and tests that don't care) keep working —
   * if omitted, the response degrades to `serving_mode: "idle"` with no
   * conflicts.
   */
  coordinator?: Pick<GpuCoordinator, "currentClaims">;
  /**
   * GPU dispatcher (Issue #1056) used to surface per-GPU lane state
   * (`idle | busy | error`), current job, queue depth, and mutex-blocked
   * indicators. Optional — when omitted, the response omits the
   * `dispatcher` block entirely so the admin UI can keep its legacy
   * "no dispatcher" fallback.
   */
  dispatcher?: Pick<GpuDispatcher, "state">;
}

const GB = 1024 * 1024 * 1024;
const bytesToGb = (n: number) => Math.round((n / GB) * 10) / 10;

export function createSystemRouter(deps: SystemRouterDeps = {}): Router {
  const router = Router();
  const loader = deps.loadProfile ?? (() => getGpuProfile());
  const platformLoader = deps.loadPlatform ?? (() => detectPlatformProfile());
  const coordinator = deps.coordinator;
  const dispatcher = deps.dispatcher;

  router.get("/gpu", async (_req, res) => {
    try {
      const profile = await loader();
      const claims = coordinator ? coordinator.currentClaims() : [];
      const summary = summariseClaims(claims);
      const dispatcherBlock: { dispatcher?: { gpus: GpuLaneSnapshot[] } } =
        dispatcher ? { dispatcher: { gpus: dispatcher.state() } } : {};
      res.json({ ...profile, ...summary, ...dispatcherBlock });
    } catch (err) {
      res.status(500).json({
        error: "Failed to detect GPU profile",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * `GET /platform` — host capabilities + recommended Gemma 4 variant.
   *
   * Used by the System Requirements card on `/admin` and the offline
   * setup wizard on `/setup` so both surfaces show the same hardware
   * truth from a single source.
   */
  router.get("/platform", async (_req, res) => {
    try {
      const platform = platformLoader();
      let largestGpuVramBytes: number | undefined;
      try {
        const gpu = await loader();
        if (gpu.detected && gpu.largest_gpu_gb > 0) {
          largestGpuVramBytes = gpu.largest_gpu_gb * GB;
        }
      } catch {
        // GPU detection failures here are non-fatal — recommendation
        // falls back to the conservative variant.
      }
      const recommended: RecommendedModel = recommendGemma4Variant(platform, {
        largestGpuVramBytes,
      });
      res.json({
        platform,
        recommended,
        memoryGb: bytesToGb(platform.totalMemoryBytes),
        unifiedMemoryGb:
          platform.unifiedMemoryBytes != null
            ? bytesToGb(platform.unifiedMemoryBytes)
            : null,
        largestGpuVramGb:
          largestGpuVramBytes != null ? bytesToGb(largestGpuVramBytes) : null,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to detect platform profile",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
