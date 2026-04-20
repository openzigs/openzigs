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
import {
  fetchCoreWebVitalsBatch,
  fetchCoreWebVitalsDual,
} from "../mcp/tools/seo/core-web-vitals.js";
import {
  getFirecrawlClient,
  isBlockedUrl,
} from "../browser/firecrawl-client.js";
import { PriceSnapshotRepository } from "../mcp/tools/price-monitor.js";
import { CompetitorRepository } from "../mcp/tools/competitive-monitor.js";
import { discoverCompetitorsFromAudit } from "../mcp/tools/seo/competitive-discover.js";
import {
  generateSchemaMarkup,
  getSchemaFields,
  SUPPORTED_SCHEMA_TYPES,
} from "../mcp/tools/seo/schema-generator.js";
import { logger } from "../logging/logger.js";
import type { Scheduler } from "../productivity/scheduler.js";
import type { FirecrawlWebhookHandler } from "../browser/firecrawl-webhooks.js";

export interface SeoRouterOptions {
  db: Database.Database;
  scheduler?: Scheduler;
  /** Optional: enables /audit/:jobId/cancel + /audit/claim endpoints (#841/#842). */
  firecrawlWebhookHandler?: FirecrawlWebhookHandler;
}

/** Clamp a numeric value to a positive integer within [1, max]. */
function clampLimit(raw: unknown, defaultVal: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(Math.floor(n), max);
}

export const createSeoRouter = ({
  db,
  scheduler,
  firecrawlWebhookHandler,
}: SeoRouterOptions): Router => {
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
    if (!["csv", "json", "pdf", "sheets"].includes(format)) {
      return res
        .status(400)
        .json({ error: "Invalid format. Use csv, json, pdf, or sheets." });
    }

    // Optional branding fields (PDF only). Validation/sanitization happens
    // in shared/pdf-export.ts (sanitizeLogoUrl/escapeHtml/hex regex), but
    // we whitelist allowed keys here so callers can't smuggle extra props.
    const branding =
      format === "pdf" &&
      req.body?.branding &&
      typeof req.body.branding === "object"
        ? {
            companyName:
              typeof req.body.branding.companyName === "string"
                ? req.body.branding.companyName
                : undefined,
            logoUrl:
              typeof req.body.branding.logoUrl === "string"
                ? req.body.branding.logoUrl
                : undefined,
            primaryColor:
              typeof req.body.branding.primaryColor === "string"
                ? req.body.branding.primaryColor
                : undefined,
          }
        : undefined;

    // Sheets format requires an OAuth2 access token in the body.
    const sheetsAccessToken =
      format === "sheets" && typeof req.body?.sheetsAccessToken === "string"
        ? req.body.sheetsAccessToken.trim()
        : undefined;
    if (format === "sheets" && !sheetsAccessToken) {
      return res.status(400).json({
        error:
          "Google Sheets export requires sheetsAccessToken (OAuth2 access token)",
      });
    }

    try {
      const data = JSON.parse(snapshot.dataJson);
      const result = await exportAudit(
        {
          siteUrl: snapshot.siteUrl,
          auditDate: snapshot.createdAt,
          healthScore: data.healthScore ?? undefined,
        },
        format as "csv" | "json" | "pdf" | "sheets",
        undefined,
        { branding, sheetsAccessToken },
      );
      return res.json({ path: result.filePath, format: result.format });
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

  /**
   * POST /api/seo/audit/claim — Claim future crawl events on a URL for a specific
   * Socket.IO clientId. Used by the UI to scope progress events to one tab (#841).
   * Body: { url: string, clientId: string }
   */
  router.post("/audit/claim", (req, res) => {
    if (!firecrawlWebhookHandler) {
      return res
        .status(503)
        .json({ error: "Crawl progress streaming disabled" });
    }
    const url = (req.body?.url as string)?.trim();
    const clientId = (req.body?.clientId as string)?.trim();
    if (!url || !clientId) {
      return res
        .status(400)
        .json({ error: "Missing required fields: url, clientId" });
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(clientId)) {
      return res.status(400).json({ error: "Invalid clientId format" });
    }
    // Reject URLs with a non-http(s) scheme outright before normalization.
    if (url.includes("://") && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "URL must use http or https" });
    }
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      if (!/^https?:$/.test(parsed.protocol)) {
        return res.status(400).json({ error: "URL must use http or https" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }
    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    firecrawlWebhookHandler.claimCrawlForClient(normalizedUrl, clientId);
    return res.json({ status: "claimed", url: normalizedUrl, clientId });
  });

  /**
   * POST /api/seo/audit/:jobId/cancel — Cancel an in-progress crawl (#842).
   * Returns 404 if the job is unknown or already completed.
   */
  router.post("/audit/:jobId/cancel", (req, res) => {
    if (!firecrawlWebhookHandler) {
      return res
        .status(503)
        .json({ error: "Crawl progress streaming disabled" });
    }
    const jobId = req.params.jobId;
    if (!/^[a-fA-F0-9]{1,64}$/.test(jobId)) {
      return res.status(400).json({ error: "Invalid jobId format" });
    }
    const cancelled = firecrawlWebhookHandler.cancelCrawl(jobId);
    if (!cancelled) {
      return res
        .status(404)
        .json({ error: "Job not found or already completed" });
    }
    return res.json({ status: "cancelled", jobId });
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
   * POST /api/seo/map — Discover URLs via Firecrawl /map endpoint (#862).
   * Body: { url: string, limit?: number }
   * Returns { urls: string[], count: number }
   */
  router.post("/map", async (req, res) => {
    const url = (req.body?.url as string)?.trim();
    if (!url) {
      return res.status(400).json({ error: "Missing required field: url" });
    }
    if (isBlockedUrl(url)) {
      return res.status(400).json({ error: "Blocked URL" });
    }

    const limit = Math.min(Number(req.body?.limit) || 200, 500);
    const client = getFirecrawlClient();
    if (!client.getConfig().enabled) {
      return res.status(503).json({ error: "Firecrawl is not enabled" });
    }

    try {
      const result = await client.map(url, { limit });
      return res.json({ urls: result.urls, count: result.urls.length });
    } catch (err) {
      logger.error("[SEO] URL map failed", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(502).json({
        error: "URL mapping failed",
      });
    }
  });

  /**
   * POST /api/seo/cwv — Run Core Web Vitals analysis for a snapshot's pages.
   *
   * Body: { snapshotId: number, maxUrls?: number, dual?: boolean }
   * When dual=true, fetches both mobile and desktop strategies.
   * Fetches PageSpeed Insights for the top pages in the snapshot,
   * patches the snapshot's dataJson with coreWebVitals results,
   * and returns the results array.
   */
  router.post("/cwv", async (req, res) => {
    const snapshotId = Number(req.body?.snapshotId);
    if (!Number.isFinite(snapshotId)) {
      return res.status(400).json({ error: "Missing or invalid snapshotId" });
    }

    const maxUrls = Math.min(Number(req.body?.maxUrls) || 5, 10);
    const dual = req.body?.dual === true;
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
        dual,
      });

      if (dual) {
        const dualResults = [];
        const dualErrors: Array<{ url: string; error: string }> = [];
        for (let i = 0; i < pages.length; i++) {
          try {
            dualResults.push(await fetchCoreWebVitalsDual(pages[i], apiKey));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            dualErrors.push({ url: pages[i], error: errMsg });
            logger.warn("[SEO] CWV dual fetch failed", {
              url: pages[i],
              error: errMsg,
            });
          }
          if (i < pages.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 2400));
          }
        }

        historyRepo.patchDataJson(snapshotId, {
          coreWebVitals: dualResults.flatMap((r) => [
            { ...r.mobile, strategy: "mobile" },
            { ...r.desktop, strategy: "desktop" },
          ]),
          cwvDual: dualResults.map((r) => ({
            url: r.url,
            mobile: {
              performanceScore: r.mobile.performanceScore,
              metrics: r.mobile.metrics,
            },
            desktop: {
              performanceScore: r.desktop.performanceScore,
              metrics: r.desktop.metrics,
            },
          })),
        });

        return res.json({
          results: dualResults,
          urlsAnalyzed: dualResults.length,
          urlsAttempted: pages.length,
          errors: dualErrors,
        });
      }

      const results = await fetchCoreWebVitalsBatch(pages, apiKey, 1200);

      // Patch snapshot's dataJson with CWV results
      historyRepo.patchDataJson(snapshotId, {
        coreWebVitals: results.map((r) => ({
          url: r.url,
          performanceScore: r.performanceScore,
          metrics: r.metrics,
          fetchedAt: r.fetchedAt,
          strategy: r.strategy ?? "mobile",
          error: r.error,
        })),
      });

      const successCount = results.filter((r) => !r.error).length;
      const failures = results
        .filter((r) => r.error)
        .map((r) => ({ url: r.url, error: r.error ?? "Unknown error" }));
      return res.json({
        results,
        urlsAnalyzed: successCount,
        urlsAttempted: pages.length,
        errors: failures,
      });
    } catch (err) {
      logger.error("[SEO] CWV analysis failed", {
        snapshotId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(502).json({
        error: "Core Web Vitals analysis failed",
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

  /**
   * POST /api/seo/competitors/discover — Discover competitors from audit data (#864).
   * Body: { url: string }
   * Returns DiscoveryResult from competitive-discover pipeline.
   */
  router.post("/competitors/discover", async (req, res) => {
    const url = (req.body?.url as string)?.trim();
    if (!url) {
      return res.status(400).json({ error: "Missing required field: url" });
    }

    let normalizedUrl: string;
    try {
      normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
      new URL(normalizedUrl);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    // Get the latest audit snapshot for this URL
    const snapshots = historyRepo.listSnapshots(normalizedUrl, 1);
    if (snapshots.length === 0) {
      return res.json({
        error: "No audit data found. Run a site audit first.",
        requiresApiKey: true,
        competitors: [],
        keywordsSearched: [],
        serpFeatures: { paa: [], relatedSearches: [] },
        targetDomain: "",
      });
    }

    // Parse the snapshot data to extract pages with keywords
    let pages: Array<{
      url: string;
      keywords?: Array<{ word: string; score: number }>;
    }> = [];
    try {
      const data = JSON.parse(snapshots[0].dataJson) as {
        pages?: Array<{
          url: string;
          keywords?: Array<{ word: string; score: number }>;
        }>;
      };
      if (Array.isArray(data.pages)) {
        pages = data.pages;
      }
    } catch {
      return res.status(500).json({ error: "Failed to parse audit data" });
    }

    // Extract domain from the URL
    let domain: string;
    try {
      domain = new URL(normalizedUrl).hostname.replace(/^www\./, "");
    } catch {
      return res.status(400).json({ error: "Could not extract domain" });
    }

    try {
      const result = await discoverCompetitorsFromAudit(pages, domain);
      return res.json(result);
    } catch (err) {
      logger.error("[SEO] Competitor discovery failed", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: "Competitor discovery failed" });
    }
  });

  /**
   * POST /api/seo/competitors/add-bulk — Add multiple competitors at once (#864).
   * Body: { competitors: Array<{ url: string; name?: string }> }
   * Returns { added: number, errors: Array<{ url: string; error: string }> }
   */
  router.post("/competitors/add-bulk", (req, res) => {
    const items = req.body?.competitors;
    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "Missing or empty competitors array" });
    }

    try {
      const repo = new CompetitorRepository(db);
      let added = 0;
      const errors: Array<{ url: string; error: string }> = [];

      for (const item of items) {
        const itemUrl = (item?.url as string)?.trim();
        if (!itemUrl) {
          errors.push({ url: "", error: "Missing URL" });
          continue;
        }
        try {
          new URL(itemUrl);
        } catch {
          errors.push({ url: itemUrl, error: "Invalid URL" });
          continue;
        }
        try {
          repo.addCompetitor(itemUrl, (item?.name as string) ?? undefined);
          added++;
        } catch (err) {
          errors.push({
            url: itemUrl,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return res.json({ added, errors });
    } catch (err) {
      logger.error("[SEO] Failed to add competitors in bulk", {
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: "Failed to add competitors" });
    }
  });

  /**
   * POST /api/seo/schedule — Create a scheduled SEO audit job (#856).
   * Body: { url: string, cron: string, name?: string, timezone?: string }
   */
  router.post("/schedule", (req, res) => {
    if (!scheduler) {
      return res.status(503).json({ error: "Scheduler not available" });
    }
    const url = (req.body?.url as string)?.trim();
    const cronExpr = (req.body?.cron as string)?.trim();
    if (!url || !cronExpr) {
      return res
        .status(400)
        .json({ error: "Missing required fields: url, cron" });
    }
    const name = (req.body?.name as string)?.trim() || `SEO Audit: ${url}`;
    const timezone = (req.body?.timezone as string)?.trim() || "UTC";

    try {
      const job = scheduler.create({
        name,
        cronExpression: cronExpr,
        timezone,
        actionType: "prompt",
        actionPayload: {
          promptText: `Run a comprehensive SEO site audit on ${url} using the seo-site-audit tool. Save the results.`,
          seoAuditUrl: url,
        },
        allowedTools: ["seo-site-audit"],
        enabled: true,
      });
      return res.json({ job });
    } catch (err) {
      logger.error("[SEO] Failed to create scheduled audit", {
        url,
        cron: cronExpr,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        error: "Failed to create scheduled audit",
      });
    }
  });

  /** GET /api/seo/schedule — List scheduled SEO audit jobs. */
  router.get("/schedule", (_req, res) => {
    if (!scheduler) {
      return res.status(503).json({ error: "Scheduler not available" });
    }
    const allJobs = scheduler.list();
    const seoJobs = allJobs.filter(
      (j) => (j.actionPayload as Record<string, unknown>)?.seoAuditUrl,
    );
    return res.json(seoJobs);
  });

  // ── Schema Generator (#879) ──

  /** POST /api/seo/schema/generate
   *  Body: { type: string, data: Record<string, unknown> }
   */
  router.post("/schema/generate", (req, res) => {
    try {
      const schemaType = (req.body?.type as string)?.trim();
      const data = req.body?.data as Record<string, unknown> | undefined;

      if (
        !schemaType ||
        !SUPPORTED_SCHEMA_TYPES.includes(
          schemaType as (typeof SUPPORTED_SCHEMA_TYPES)[number],
        )
      ) {
        return res.status(400).json({
          error: `Invalid schema type. Supported: ${SUPPORTED_SCHEMA_TYPES.join(", ")}`,
        });
      }

      const json = generateSchemaMarkup(
        schemaType as (typeof SUPPORTED_SCHEMA_TYPES)[number],
        data ?? {},
      );
      return res.json({ schema: JSON.parse(json), raw: json });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: msg });
    }
  });

  /** GET /api/seo/schema/types — List supported schema types with fields. */
  router.get("/schema/types", (_req, res) => {
    const types = SUPPORTED_SCHEMA_TYPES.map((t) => ({
      type: t,
      fields: getSchemaFields(t),
    }));
    return res.json(types);
  });
  return router;
};
