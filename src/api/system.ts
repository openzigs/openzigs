/**
 * System info endpoints — GPU profile, model recommendations.
 * Issue #885 (Epic #883).
 */
import { Router } from "express";

import { getGpuProfile, type GpuProfile } from "../system/gpu-profile.js";

export interface SystemRouterDeps {
  /** Override profile loader for tests. */
  loadProfile?: () => Promise<GpuProfile>;
}

export function createSystemRouter(deps: SystemRouterDeps = {}): Router {
  const router = Router();
  const loader = deps.loadProfile ?? (() => getGpuProfile());

  router.get("/gpu", async (_req, res) => {
    try {
      const profile = await loader();
      res.json(profile);
    } catch (err) {
      res.status(500).json({
        error: "Failed to detect GPU profile",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
