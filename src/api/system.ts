/**
 * System info endpoints — GPU profile, model recommendations.
 * Issue #885 (Epic #883).
 *
 * Issue #917 (Epic #888): merge GPU coordinator state into the GPU
 * response so the UI can render mutual-exclusion conflicts and the
 * current serving mode (idle / diffusion / vllm-tp2 / mixed).
 */
import { Router } from "express";

import { getGpuProfile, type GpuProfile } from "../system/gpu-profile.js";
import {
  summariseClaims,
  type GpuCoordinator,
} from "../gpu/gpu-coordinator.js";
import type { GpuDispatcher, GpuLaneSnapshot } from "../gpu/gpu-dispatcher.js";

export interface SystemRouterDeps {
  /** Override profile loader for tests. */
  loadProfile?: () => Promise<GpuProfile>;
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

export function createSystemRouter(deps: SystemRouterDeps = {}): Router {
  const router = Router();
  const loader = deps.loadProfile ?? (() => getGpuProfile());
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

  return router;
}
