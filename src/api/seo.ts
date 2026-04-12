/**
 * SEO Suite API Router (#838)
 *
 * Provides endpoints for audit history, audit snapshots, report exports,
 * and audit triggering.
 * Mounted at /api/seo in server.ts.
 */

import { Router } from "express";
import type Database from "better-sqlite3";
import { AuditHistoryRepository } from "../mcp/tools/seo/audit-history.js";
import { exportAudit } from "../mcp/tools/seo/report-export.js";
import { logger } from "../logging/logger.js";

export interface SeoRouterOptions {
  db: Database.Database;
}

/** Clamp a numeric value to a positive integer within [1, max]. */
function clampLimit(raw: unknown, defaultVal: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(Math.floor(n), max);
}

export const createSeoRouter = ({ db }: SeoRouterOptions): Router => {
  const router = Router();
  const historyRepo = new AuditHistoryRepository(db);

  /**
   * GET /api/seo/health — Check if Firecrawl sidecar is available.
   * Returns { available: boolean, message: string }
   */
  router.get("/health", async (_req, res) => {
    try {
      const firecrawlUrl = process.env.FIRECRAWL_URL ?? "http://localhost:3002";
      const resp = await fetch(`${firecrawlUrl}/`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        return res.json({ available: true, message: "Firecrawl is ready" });
      }
      return res.json({
        available: false,
        message: "Firecrawl responded but is not healthy",
      });
    } catch {
      return res.json({
        available: false,
        message:
          "Firecrawl sidecar is not running. Start it with: docker compose -f docker-compose.firecrawl.yml up -d",
      });
    }
  });

  /** GET /api/seo/history — List all audit snapshots (newest first). */
  router.get("/history", (req, res) => {
    const siteUrl = req.query.siteUrl as string | undefined;
    const limit = req.query.limit
      ? clampLimit(req.query.limit, 50, 100)
      : undefined;
    const snapshots = siteUrl
      ? historyRepo.listSnapshots(siteUrl, limit ?? 12)
      : historyRepo.listAll(limit ?? 50);
    return res.json(snapshots);
  });

  /** GET /api/seo/history/:id — Get a single audit snapshot by ID. */
  router.get("/history/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid snapshot ID" });
    }
    const snapshot = historyRepo.getSnapshot(id);
    if (!snapshot) {
      return res.status(404).json({ error: "Snapshot not found" });
    }
    return res.json(snapshot);
  });

  /** GET /api/seo/history/compare/:siteUrl — Compare latest two snapshots. */
  router.get("/history/compare/:siteUrl", (req, res) => {
    const comparison = historyRepo.compareLatest(req.params.siteUrl);
    if (!comparison) {
      return res.status(404).json({ error: "Not enough snapshots to compare" });
    }
    return res.json(comparison);
  });

  /** POST /api/seo/export/:id — Export an audit snapshot. */
  router.post("/export/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid snapshot ID" });
    }
    const snapshot = historyRepo.getSnapshot(id);
    if (!snapshot) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    const format = (req.body?.format as string) ?? "json";
    if (!["csv", "json", "pdf"].includes(format)) {
      return res
        .status(400)
        .json({ error: "Invalid format. Use csv, json, or pdf." });
    }

    try {
      const data = JSON.parse(snapshot.dataJson);
      const result = await exportAudit(
        {
          siteUrl: snapshot.siteUrl,
          auditDate: snapshot.createdAt,
          healthScore: data.healthScore ?? undefined,
        },
        format as "csv" | "json" | "pdf",
      );
      return res.json({ path: result.filePath });
    } catch (err) {
      logger.error("[SEO] Export failed", {
        snapshotId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: "Export failed" });
    }
  });

  /**
   * POST /api/seo/audit — Trigger an SEO audit.
   * Body: { url: string }
   * Returns { status: "started", url } — audit runs via the MCP tool system.
   * The caller should listen for crawl:started / crawl:progress / crawl:completed
   * Socket.IO events for real-time progress.
   */
  router.post("/audit", (req, res) => {
    const url = (req.body?.url as string)?.trim();
    if (!url) {
      return res.status(400).json({ error: "Missing required field: url" });
    }

    // Basic URL validation
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ error: "URL must use http or https" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    // Return immediately — the audit will be triggered by the frontend
    // sending a chat message to invoke the seo-site-audit tool.
    // This endpoint validates the URL and provides a clean API contract.
    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    return res.json({ status: "accepted", url: normalizedUrl });
  });

  return router;
};
