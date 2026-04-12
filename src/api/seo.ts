/**
 * SEO Suite API Router (#838)
 *
 * Provides endpoints for audit history, audit snapshots, and report exports.
 * Mounted at /api/seo in server.ts.
 */

import { Router } from "express";
import type Database from "better-sqlite3";
import { AuditHistoryRepository } from "../mcp/tools/seo/audit-history.js";
import { exportAudit } from "../mcp/tools/seo/report-export.js";

export interface SeoRouterOptions {
  db: Database.Database;
}

export const createSeoRouter = ({ db }: SeoRouterOptions): Router => {
  const router = Router();
  const historyRepo = new AuditHistoryRepository(db);

  /** GET /api/seo/history — List all audit snapshots (newest first). */
  router.get("/history", (req, res) => {
    const siteUrl = req.query.siteUrl as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
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
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    }
  });

  return router;
};
