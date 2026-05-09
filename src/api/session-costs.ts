/**
 * Admin router: per-session cost meter (epic #1053 / issue #1059).
 *
 * Mounted at `/api/admin/sessions/:id/cost`. Returns the per-session
 * aggregate produced by the `CostMeter` so the chat UI cost widget and
 * the admin dashboard can surface "saved by going local" totals.
 *
 * Kept out of the bloated `src/api/admin.ts` per copilot-instructions.
 */

import { Router, type Request, type Response } from "express";
import type { CostMeter } from "../costs/cost-meter.js";

export type SessionCostsRouterDeps = {
  costMeter: CostMeter;
};

export function createSessionCostsRouter(
  deps: SessionCostsRouterDeps,
): Router {
  const router: Router = Router();
  const { costMeter } = deps;

  // Bug #1064-#6b: cross-session totals for the admin "Cost Summary" card.
  // MUST be registered before the `/sessions/:id/cost` route below so Express
  // doesn't match `cost-summary` as a session id.
  router.get("/sessions/cost-summary", (_req: Request, res: Response) => {
    try {
      const summary = costMeter.summary();
      res.json({ summary });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read cost summary",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get(
    "/sessions/:id/cost",
    (req: Request<{ id: string }>, res: Response) => {
      const sessionId = req.params.id?.trim();
      if (!sessionId) {
        res.status(400).json({ error: "Missing session id" });
        return;
      }
      // Defence in depth: SQLite call IDs come from req params here, but the
      // CostMeter uses parameterised queries so there's no injection surface.
      // We still bound the id length to avoid pathological queries.
      if (sessionId.length > 256) {
        res.status(400).json({ error: "session id too long" });
        return;
      }
      try {
        const aggregate = costMeter.aggregate(sessionId);
        const calls = costMeter.callsForSession(sessionId);
        res.json({ aggregate, calls });
      } catch (err) {
        res.status(500).json({
          error: "Failed to read session cost",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  return router;
}
