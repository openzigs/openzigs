/**
 * Pinterest Reports API routes.
 *
 * Mounted at /api/pinterest — serves saved Pinterest report data (JSON + markdown)
 * from ~/.openzigs/pinterest-reports/ for the UI analytics dashboard.
 */

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPORTS_DIR = path.join(os.homedir(), ".openzigs", "pinterest-reports");

export const createPinterestRouter = (): Router => {
  const router = Router();

  /** GET /api/pinterest/reports — list all reports with metadata */
  router.get("/reports", (_req, res) => {
    if (!fs.existsSync(REPORTS_DIR)) {
      return res.json({ reports: [] });
    }

    const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".md"));
    const reports = files.map((filename) => {
      const baseName = filename.replace(/\.md$/, "");
      const mdPath = path.join(REPORTS_DIR, filename);
      const jsonPath = path.join(REPORTS_DIR, `${baseName}.json`);
      const stat = fs.statSync(mdPath);

      // Extract type from filename pattern: type-...-timestamp.md
      const typeMatch = baseName.match(/^(analytics|keyword-metrics|seo-analysis|trends)-/);
      const type = typeMatch ? typeMatch[1] : "unknown";

      // Extract timestamp from end of filename (2026-03-09T15-44-04)
      const tsMatch = baseName.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
      const generated = tsMatch ? tsMatch[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3") : stat.mtime.toISOString();

      return {
        filename: baseName,
        type,
        generated,
        size: stat.size,
        hasJson: fs.existsSync(jsonPath),
      };
    });

    // Sort newest first
    reports.sort((a, b) => b.generated.localeCompare(a.generated));
    return res.json({ reports });
  });

  /** GET /api/pinterest/reports/:filename — get a specific report (JSON preferred, markdown fallback) */
  router.get("/reports/:filename", (req, res) => {
    const filename = path.basename(req.params.filename); // sanitize
    const jsonPath = path.join(REPORTS_DIR, `${filename}.json`);
    const mdPath = path.join(REPORTS_DIR, `${filename}.md`);

    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        return res.json({ format: "json", data });
      } catch {
        // Fall through to markdown
      }
    }

    if (fs.existsSync(mdPath)) {
      const content = fs.readFileSync(mdPath, "utf-8");
      return res.json({ format: "markdown", content });
    }

    return res.status(404).json({ error: "Report not found" });
  });

  /** GET /api/pinterest/status — Pinterest connection status */
  router.get("/status", (_req, res) => {
    const hasToken = !!process.env.PINTEREST_ACCESS_TOKEN;
    const reportCount = fs.existsSync(REPORTS_DIR)
      ? fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".md")).length
      : 0;

    return res.json({
      connected: hasToken,
      reportsDir: REPORTS_DIR,
      reportCount,
    });
  });

  return router;
};
