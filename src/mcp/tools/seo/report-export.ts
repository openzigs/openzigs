/**
 * Visual Reporting & Export (#847)
 *
 * - CSV export for each audit section
 * - JSON export of full audit data
 * - PDF report generation using existing saveReportPdf pattern
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { saveReportPdf } from "../shared/pdf-export.js";
import type { HealthScoreResult } from "./health-score.js";
import type { LinkAnalysisResult } from "./link-analyzer.js";
import type { ContentAnalysisResult } from "./content-analyzer.js";
import type { CoreWebVitalsResult } from "./core-web-vitals.js";

const SEO_REPORTS_DIR = path.join(os.homedir(), ".openzigs", "seo-reports");

// ── Types ────────────────────────────────────────────────────────────────

export interface ExportableAuditData {
  siteUrl: string;
  auditDate: string;
  healthScore?: HealthScoreResult;
  linkAnalysis?: LinkAnalysisResult;
  contentAnalysis?: ContentAnalysisResult;
  coreWebVitals?: CoreWebVitalsResult[];
  pages?: Array<{
    url: string;
    title: string;
    wordCount: number;
    issues: Array<{ severity: string; category: string; message: string }>;
  }>;
}

export type ExportFormat = "csv" | "json" | "pdf";

export interface ExportResult {
  format: ExportFormat;
  filePath: string;
  sizeBytes: number;
}

// ── CSV Export ───────────────────────────────────────────────────────────

function escapeCsv(value: string | number | boolean): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportIssuesToCsv(data: ExportableAuditData): string {
  const rows: string[] = ["URL,Severity,Category,Message"];

  for (const page of data.pages ?? []) {
    for (const issue of page.issues) {
      rows.push(
        [
          escapeCsv(issue.severity),
          escapeCsv(issue.category),
          escapeCsv(issue.message),
          escapeCsv(page.url),
        ].join(","),
      );
    }
  }
  return rows.join("\n");
}

export function exportBrokenLinksCsv(data: ExportableAuditData): string {
  const rows: string[] = ["Source URL,Target URL,Anchor Text,Status Code"];
  for (const link of data.linkAnalysis?.brokenLinks ?? []) {
    rows.push(
      [
        escapeCsv(link.sourceUrl),
        escapeCsv(link.targetUrl),
        escapeCsv(link.anchorText),
        escapeCsv(link.statusCode),
      ].join(","),
    );
  }
  return rows.join("\n");
}

export function exportHealthScoreCsv(data: ExportableAuditData): string {
  const rows: string[] = ["Category,Score,Issues,Critical,High,Medium,Low"];
  if (data.healthScore) {
    for (const cat of data.healthScore.categories) {
      rows.push(
        [
          escapeCsv(cat.category),
          escapeCsv(cat.score),
          escapeCsv(cat.issueCount),
          escapeCsv(cat.critical),
          escapeCsv(cat.high),
          escapeCsv(cat.medium),
          escapeCsv(cat.low),
        ].join(","),
      );
    }
  }
  return rows.join("\n");
}

// ── JSON Export ──────────────────────────────────────────────────────────

export function exportToJson(data: ExportableAuditData): string {
  return JSON.stringify(data, null, 2);
}

// ── PDF Export ───────────────────────────────────────────────────────────

export function buildFullReportMarkdown(data: ExportableAuditData): string {
  const lines: string[] = [];
  lines.push(`# SEO Audit Report: ${data.siteUrl}`);
  lines.push(`**Date:** ${data.auditDate}`);
  lines.push("");

  if (data.healthScore) {
    lines.push("## Health Score");
    lines.push(
      `**Overall Score:** ${data.healthScore.score}/100 (${data.healthScore.rating})`,
    );
    lines.push("");
    lines.push("| Category | Score | Issues |");
    lines.push("|----------|-------|--------|");
    for (const cat of data.healthScore.categories) {
      lines.push(`| ${cat.category} | ${cat.score} | ${cat.issueCount} |`);
    }
    lines.push("");
  }

  if (data.linkAnalysis) {
    lines.push("## Link Analysis");
    lines.push(`- Total Links: ${data.linkAnalysis.totalLinks}`);
    lines.push(`- Broken Links: ${data.linkAnalysis.brokenLinks.length}`);
    lines.push(`- Redirect Chains: ${data.linkAnalysis.redirectChains.length}`);
    lines.push(`- Orphan Pages: ${data.linkAnalysis.orphanPages.length}`);
    lines.push("");
  }

  if (data.contentAnalysis) {
    lines.push("## Content Intelligence");
    lines.push(
      `- Duplicate Groups: ${data.contentAnalysis.duplicateGroups.length}`,
    );
    lines.push(
      `- Thin Content Pages: ${data.contentAnalysis.thinContentPages.length}`,
    );
    lines.push("");
  }

  if (data.coreWebVitals && data.coreWebVitals.length > 0) {
    lines.push("## Core Web Vitals");
    lines.push("| URL | Score | LCP | CLS | TBT |");
    lines.push("|-----|-------|-----|-----|-----|");
    for (const cwv of data.coreWebVitals) {
      const lcp = cwv.metrics.find((m) => m.name === "LCP")?.value ?? "-";
      const cls = cwv.metrics.find((m) => m.name === "CLS")?.value ?? "-";
      const tbt = cwv.metrics.find((m) => m.name === "TBT")?.value ?? "-";
      lines.push(
        `| ${cwv.url} | ${cwv.performanceScore} | ${lcp} | ${cls} | ${tbt} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Export orchestration ─────────────────────────────────────────────────

export async function exportAudit(
  data: ExportableAuditData,
  format: ExportFormat,
  outputDir?: string,
): Promise<ExportResult> {
  const dir = outputDir ?? path.join(SEO_REPORTS_DIR, "exports");
  await fs.mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `seo-audit-${timestamp}`;

  let filePath: string;

  switch (format) {
    case "csv": {
      filePath = path.join(dir, `${baseName}.csv`);
      const csv = exportIssuesToCsv(data);
      await fs.writeFile(filePath, csv, "utf-8");
      break;
    }
    case "json": {
      filePath = path.join(dir, `${baseName}.json`);
      const json = exportToJson(data);
      await fs.writeFile(filePath, json, "utf-8");
      break;
    }
    case "pdf": {
      const md = buildFullReportMarkdown(data);
      const pdfPath = await saveReportPdf(baseName, md, dir);
      filePath = pdfPath ?? path.join(dir, `${baseName}.md`);
      if (!pdfPath) {
        // Fallback to markdown if PDF generation fails
        await fs.writeFile(filePath, md, "utf-8");
      }
      break;
    }
  }

  const stat = await fs.stat(filePath);
  return { format, filePath, sizeBytes: stat.size };
}
