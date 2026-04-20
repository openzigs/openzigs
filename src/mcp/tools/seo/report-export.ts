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
import { saveReportPdf, type PdfBranding } from "../shared/pdf-export.js";
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

export type ExportFormat = "csv" | "json" | "pdf" | "sheets";

export interface ExportOptions {
  branding?: PdfBranding;
  /** Required for the "sheets" format. Bring-your-own OAuth2 access token. */
  sheetsAccessToken?: string;
  /** Optional human-friendly metadata appended to the report. */
  metadata?: {
    pageCount?: number;
    durationMs?: number;
    crawledBy?: string;
  };
}

export interface ExportResult {
  format: ExportFormat;
  /** File path on disk for csv/json/pdf. URL for sheets. */
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
          escapeCsv(page.url),
          escapeCsv(issue.severity),
          escapeCsv(issue.category),
          escapeCsv(issue.message),
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

export function buildFullReportMarkdown(
  data: ExportableAuditData,
  metadata?: ExportOptions["metadata"],
): string {
  const lines: string[] = [];
  lines.push(`# SEO Audit Report: ${data.siteUrl}`);
  lines.push(`**Date:** ${data.auditDate}`);
  if (metadata?.pageCount != null) {
    lines.push(`**Pages crawled:** ${metadata.pageCount}`);
  }
  if (metadata?.durationMs != null) {
    const sec = Math.round(metadata.durationMs / 1000);
    lines.push(`**Duration:** ${sec}s`);
  }
  if (metadata?.crawledBy) {
    lines.push(`**Crawled by:** ${metadata.crawledBy}`);
  }
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
  options?: ExportOptions,
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
      const md = buildFullReportMarkdown(data, options?.metadata);
      const pdfPath = await saveReportPdf(baseName, md, dir, options?.branding);
      filePath = pdfPath ?? path.join(dir, `${baseName}.md`);
      if (!pdfPath) {
        // Fallback to markdown if PDF generation fails
        await fs.writeFile(filePath, md, "utf-8");
      }
      break;
    }
    case "sheets": {
      if (!options?.sheetsAccessToken) {
        throw new Error(
          "Google Sheets export requires sheetsAccessToken (OAuth2)",
        );
      }
      const url = await exportAuditToSheets(
        data,
        options.sheetsAccessToken,
        options.metadata,
      );
      // Persist a small reference file locally so call sites have a file path.
      filePath = path.join(dir, `${baseName}.sheets.url`);
      await fs.writeFile(filePath, url, "utf-8");
      const stat = await fs.stat(filePath);
      return { format, filePath: url, sizeBytes: stat.size };
    }
  }

  const stat = await fs.stat(filePath);
  return { format, filePath, sizeBytes: stat.size };
}

// ── Google Sheets export ─────────────────────────────────────────────

/**
 * Export an audit to a brand-new Google Spreadsheet using a per-call OAuth2
 * access token. Returns the spreadsheet URL.
 *
 * Issue #847.
 */
export async function exportAuditToSheets(
  data: ExportableAuditData,
  accessToken: string,
  metadata?: ExportOptions["metadata"],
): Promise<string> {
  // Lazy-import to avoid forcing googleapis to load when not used.
  const { SheetsClient } = await import("../sheets/sheets-client.js");
  const client = new SheetsClient({ accessToken });
  const title = `SEO Audit ${data.siteUrl} ${data.auditDate}`;
  const created = await client.createSpreadsheet(title);
  // The newly created spreadsheet contains a single default "Sheet1" tab. Add
  // the additional tabs we need before writing values into them.
  for (const tab of ["Issues", "Broken Links", "Health Score"]) {
    await client.addSheet(created.spreadsheetId, tab);
  }
  // Rename the default sheet to "Summary" via batchUpdate is overkill — we
  // just append values into Sheet1 and label the columns.
  const summaryRows: (string | number)[][] = [
    ["Site", data.siteUrl],
    ["Audit Date", data.auditDate],
  ];
  if (metadata?.pageCount != null)
    summaryRows.push(["Pages crawled", metadata.pageCount]);
  if (metadata?.durationMs != null)
    summaryRows.push(["Duration (ms)", metadata.durationMs]);
  if (data.healthScore)
    summaryRows.push([
      "Overall Health",
      `${data.healthScore.score} (${data.healthScore.rating})`,
    ]);
  await client.appendValues(created.spreadsheetId, "Sheet1!A1", summaryRows);

  const issueRows: (string | number)[][] = [
    ["URL", "Severity", "Category", "Message"],
    ...((data.pages ?? []).flatMap((p) =>
      p.issues.map((i) => [p.url, i.severity, i.category, i.message]),
    ) as (string | number)[][]),
  ];
  if (issueRows.length > 1)
    await client.appendValues(created.spreadsheetId, "Issues!A1", issueRows);

  const brokenRows: (string | number)[][] = [
    ["Source URL", "Target URL", "Anchor Text", "Status Code"],
    ...((data.linkAnalysis?.brokenLinks ?? []).map((l) => [
      l.sourceUrl,
      l.targetUrl,
      l.anchorText,
      l.statusCode,
    ]) as (string | number)[][]),
  ];
  if (brokenRows.length > 1)
    await client.appendValues(
      created.spreadsheetId,
      "Broken Links!A1",
      brokenRows,
    );

  if (data.healthScore) {
    const healthRows: (string | number)[][] = [
      ["Category", "Score", "Issues", "Critical", "High", "Medium", "Low"],
      ...data.healthScore.categories.map((c) => [
        c.category,
        c.score,
        c.issueCount,
        c.critical,
        c.high,
        c.medium,
        c.low,
      ]),
    ];
    await client.appendValues(
      created.spreadsheetId,
      "Health Score!A1",
      healthRows,
    );
  }
  return created.spreadsheetUrl;
}
