/**
 * SEO Suite API Router (#838)
 *
 * Provides endpoints for audit history, audit snapshots, report exports,
 * scheduled audits, trend data, and audit triggering.
 * Mounted at /api/seo in server.ts.
 */

import { Router } from "express";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AuditHistoryRepository } from "../mcp/tools/seo/audit-history.js";
import { exportAudit } from "../mcp/tools/seo/report-export.js";
import { fetchCoreWebVitalsBatch } from "../mcp/tools/seo/core-web-vitals.js";
import { PriceSnapshotRepository } from "../mcp/tools/price-monitor.js";
import { CompetitorRepository } from "../mcp/tools/competitive-monitor.js";
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

  /** GET /api/seo/trend/:siteUrl — Trend data for charting. */
  router.get("/trend/:siteUrl", (req, res) => {
    const siteUrl = decodeURIComponent(req.params.siteUrl);
    const limit = req.query.limit ? clampLimit(req.query.limit, 12, 50) : 12;
    const trend = historyRepo.getTrend(siteUrl, limit);
    return res.json(trend);
  });

  /** POST /api/seo/prune — Prune audit snapshots older than N days. */
  router.post("/prune", (req, res) => {
    const days = Number(req.body?.days);
    if (!Number.isFinite(days) || days < 1) {
      return res
        .status(400)
        .json({ error: "Invalid days parameter. Must be >= 1." });
    }
    const siteUrl = (req.body?.siteUrl as string) ?? undefined;
    const deleted = historyRepo.pruneOldSnapshots(days, siteUrl);
    return res.json({ deleted, days });
  });

  /** DELETE /api/seo/history/:id — Delete a single snapshot. */
  router.delete("/history/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid snapshot ID" });
    }
    const deleted = historyRepo.deleteSnapshot(id);
    if (!deleted) {
      return res.status(404).json({ error: "Snapshot not found" });
    }
    return res.json({ deleted: true });
  });

  /**
   * POST /api/seo/cwv — Run Core Web Vitals analysis for a snapshot's pages.
   *
   * Body: { snapshotId: number, maxUrls?: number }
   * Fetches PageSpeed Insights for the top pages in the snapshot,
   * patches the snapshot's dataJson with coreWebVitals results,
   * and returns the results array.
   *
   * Uses Google PageSpeed Insights API (free; no key needed for low volume).
   * Optional: set GOOGLE_PSI_API_KEY env var for higher rate limits.
   */
  router.post("/cwv", async (req, res) => {
    const snapshotId = Number(req.body?.snapshotId);
    if (!Number.isFinite(snapshotId)) {
      return res.status(400).json({ error: "Missing or invalid snapshotId" });
    }

    const maxUrls = Math.min(Number(req.body?.maxUrls) || 5, 10);
    const snapshot = historyRepo.getSnapshot(snapshotId);
    if (!snapshot) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    // Extract top page URLs from the snapshot data — homepage first
    let pages: string[] = [];
    try {
      const data = JSON.parse(snapshot.dataJson) as {
        pages?: Array<{ url: string }>;
      };
      if (Array.isArray(data.pages)) {
        pages = data.pages.map((p) => p.url);
      }
    } catch {
      // fall through — use the site URL as fallback
    }

    // Always include the site root and de-duplicate
    pages = [snapshot.siteUrl, ...pages.filter((u) => u !== snapshot.siteUrl)];
    pages = [...new Set(pages)].slice(0, maxUrls);

    const apiKey = process.env.GOOGLE_PSI_API_KEY;

    try {
      logger.info("[SEO] Running Core Web Vitals analysis", {
        snapshotId,
        urlCount: pages.length,
      });

      const results = await fetchCoreWebVitalsBatch(pages, apiKey, 1200);

      // Patch snapshot's dataJson with CWV results
      historyRepo.patchDataJson(snapshotId, {
        coreWebVitals: results.map((r) => ({
          url: r.url,
          performanceScore: r.performanceScore,
          metrics: r.metrics,
          fetchedAt: r.fetchedAt,
        })),
      });

      return res.json({ results, urlsAnalyzed: results.length });
    } catch (err) {
      logger.error("[SEO] CWV analysis failed", {
        snapshotId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : "Core Web Vitals analysis failed",
      });
    }
  });

  // ── Leads endpoints ─────────────────────────────────────────────────────

  /**
   * GET /api/seo/leads — List lead extraction sessions grouped by domain.
   * Returns [{domain, files: [{name, capturedAt, sizeBytes}]}]
   */
  router.get("/leads", (_req, res) => {
    const leadsDir = path.join(
      os.homedir(),
      ".openzigs",
      "extractions",
      "leads",
    );
    if (!fs.existsSync(leadsDir)) {
      return res.json([]);
    }
    try {
      const domains = fs
        .readdirSync(leadsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const domainDir = path.join(leadsDir, d.name);
          const files = fs
            .readdirSync(domainDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => {
              const stat = fs.statSync(path.join(domainDir, f));
              return {
                name: f,
                capturedAt: stat.mtime.toISOString(),
                sizeBytes: stat.size,
              };
            })
            .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
          return { domain: d.name, files };
        })
        .filter((d) => d.files.length > 0)
        .sort((a, b) => {
          const la = a.files[0]?.capturedAt ?? "";
          const lb = b.files[0]?.capturedAt ?? "";
          return lb.localeCompare(la);
        });
      return res.json(domains);
    } catch (err) {
      logger.error("[SEO] Failed to list lead extractions", {
        error: String(err),
      });
      return res.status(500).json({ error: "Failed to list lead extractions" });
    }
  });

  /**
   * GET /api/seo/leads/:domain/:file — Download a leads extraction markdown file.
   */
  router.get("/leads/:domain/:file", (req, res) => {
    // Sanitize path components — only allow alphanumeric, dots, hyphens, underscores
    const domainParam = req.params.domain.replace(/[^a-zA-Z0-9._-]/g, "");
    const fileParam = req.params.file.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!domainParam || !fileParam || !fileParam.endsWith(".md")) {
      return res.status(400).json({ error: "Invalid path" });
    }
    const filePath = path.join(
      os.homedir(),
      ".openzigs",
      "extractions",
      "leads",
      domainParam,
      fileParam,
    );
    // Ensure the resolved path stays within the leads directory
    const leadsDir = path.join(
      os.homedir(),
      ".openzigs",
      "extractions",
      "leads",
    );
    if (!filePath.startsWith(leadsDir + path.sep)) {
      return res.status(400).json({ error: "Invalid path" });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileParam}"`);
    return res.sendFile(filePath);
  });

  // ── Prices endpoints ─────────────────────────────────────────────────────

  /**
   * GET /api/seo/prices — List all monitored price URLs with snapshot counts.
   * Returns [{url, label, snapshotCount, lastCapture}]
   */
  router.get("/prices", (_req, res) => {
    try {
      const repo = new PriceSnapshotRepository(db);
      return res.json(repo.listMonitoredUrls());
    } catch (err) {
      logger.error("[SEO] Failed to list price monitors", {
        error: String(err),
      });
      return res.status(500).json({ error: "Failed to list price monitors" });
    }
  });

  /**
   * GET /api/seo/prices/export.csv — Download all price snapshots as CSV.
   */
  router.get("/prices/export.csv", (_req, res) => {
    try {
      const repo = new PriceSnapshotRepository(db);
      const rows = repo.listMonitoredUrls();
      const lines = ["URL,Label,Snapshots,Last Captured"];
      for (const r of rows) {
        const url = `"${r.url.replace(/"/g, '""')}"`;
        const label = `"${(r.label ?? "").replace(/"/g, '""')}"`;
        lines.push(`${url},${label},${r.snapshotCount},${r.lastCapture}`);
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="price-monitors.csv"`,
      );
      return res.send(lines.join("\n"));
    } catch (err) {
      logger.error("[SEO] Failed to export price data", { error: String(err) });
      return res.status(500).json({ error: "Failed to export price data" });
    }
  });

  // ── Competitors endpoints ─────────────────────────────────────────────────

  /**
   * GET /api/seo/competitors — List all tracked competitors.
   * Returns [{url, name, addedAt, lastSnapshotAt}]
   */
  router.get("/competitors", (_req, res) => {
    try {
      const repo = new CompetitorRepository(db);
      return res.json(repo.listCompetitors());
    } catch (err) {
      logger.error("[SEO] Failed to list competitors", { error: String(err) });
      return res.status(500).json({ error: "Failed to list competitors" });
    }
  });

  /**
   * GET /api/seo/competitors/export.csv — Download tracked competitors as CSV.
   */
  router.get("/competitors/export.csv", (_req, res) => {
    try {
      const repo = new CompetitorRepository(db);
      const rows = repo.listCompetitors();
      const lines = ["URL,Name,Added At,Last Snapshot"];
      for (const r of rows) {
        const url = `"${r.url.replace(/"/g, '""')}"`;
        const name = `"${(r.name ?? "").replace(/"/g, '""')}"`;
        lines.push(`${url},${name},${r.addedAt},${r.lastSnapshotAt ?? ""}`);
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="competitors.csv"`,
      );
      return res.send(lines.join("\n"));
    } catch (err) {
      logger.error("[SEO] Failed to export competitor data", {
        error: String(err),
      });
      return res
        .status(500)
        .json({ error: "Failed to export competitor data" });
    }
  });

  return router;
};
