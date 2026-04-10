/**
 * Video Performance Analytics API — #828
 *
 * REST endpoints for the cross-platform analytics dashboard.
 */
import { Router } from "express";
import { z } from "zod";
import type { AnalyticsAggregator } from "../analytics/analytics-aggregator.js";

const dateRangeSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  period: z.enum(["7d", "30d", "90d", "all"]).optional(),
});

const compareSchema = z.object({
  id1: z.string(),
  platform1: z.string(),
  id2: z.string(),
  platform2: z.string(),
});

export interface AnalyticsRouterOptions {
  aggregator: AnalyticsAggregator;
}

export function createAnalyticsRouter({
  aggregator,
}: AnalyticsRouterOptions): Router {
  const router = Router();

  function resolveDateRange(
    query: z.infer<typeof dateRangeSchema>,
  ): { start: string; end: string } | undefined {
    if (query.start && query.end) return { start: query.start, end: query.end };
    if (query.period && query.period !== "all") {
      const days = query.period === "7d" ? 7 : query.period === "30d" ? 30 : 90;
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400_000);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    return undefined;
  }

  /** GET /summary — Cross-platform summary with KPIs */
  router.get("/summary", (req, res) => {
    const parsed = dateRangeSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const dateRange = resolveDateRange(parsed.data);
    const summary = aggregator.summarize(dateRange);
    res.json(summary);
  });

  /** GET /best-times — Heatmap of best posting times */
  router.get("/best-times", (_req, res) => {
    const times = aggregator.computeBestTimes();
    res.json({ slots: times });
  });

  /** GET /compare — Side-by-side content comparison */
  router.get("/compare", (req, res) => {
    const parsed = compareSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { id1, platform1, id2, platform2 } = parsed.data;
    const result = aggregator.compare(id1, platform1, id2, platform2);
    res.json(result);
  });

  return router;
}
