import { describe, it, expect } from "vitest";
import {
  exportIssuesToCsv,
  exportBrokenLinksCsv,
  exportHealthScoreCsv,
  exportToJson,
  buildFullReportMarkdown,
  type ExportableAuditData,
} from "./report-export.js";

function makeAuditData(
  overrides: Partial<ExportableAuditData> = {},
): ExportableAuditData {
  return {
    siteUrl: "https://example.com",
    auditDate: "2026-04-12",
    healthScore: {
      score: 85,
      rating: "good",
      totalIssues: 3,
      critical: 0,
      high: 1,
      medium: 1,
      low: 1,
      categories: [
        {
          category: "technical",
          score: 90,
          issueCount: 1,
          critical: 0,
          high: 1,
          medium: 0,
          low: 0,
        },
        {
          category: "content",
          score: 99,
          issueCount: 1,
          critical: 0,
          high: 0,
          medium: 1,
          low: 0,
        },
        {
          category: "links",
          score: 100,
          issueCount: 0,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
        },
        {
          category: "performance",
          score: 100,
          issueCount: 1,
          critical: 0,
          high: 0,
          medium: 0,
          low: 1,
        },
      ],
    },
    pages: [
      {
        url: "https://example.com",
        title: "Home",
        wordCount: 500,
        issues: [
          {
            severity: "error",
            category: "meta",
            message: "Missing meta description",
          },
          { severity: "warning", category: "content", message: "Thin content" },
        ],
      },
    ],
    linkAnalysis: {
      totalLinks: 50,
      internalLinks: 40,
      externalLinks: 10,
      brokenLinks: [
        {
          sourceUrl: "https://example.com",
          targetUrl: "https://example.com/broken",
          anchorText: "Broken Link",
          statusCode: 404,
        },
      ],
      redirectChains: [],
      orphanPages: [],
      linkDepths: [],
      linkDistribution: [],
    },
    contentAnalysis: {
      duplicateGroups: [],
      thinContentPages: [],
      keywordDensity: [],
    },
    coreWebVitals: [
      {
        url: "https://example.com",
        performanceScore: 90,
        metrics: [
          { name: "LCP", value: 2000, unit: "ms", rating: "good" },
          { name: "CLS", value: 0.05, unit: "", rating: "good" },
          { name: "TBT", value: 150, unit: "ms", rating: "good" },
        ],
        fetchedAt: "2026-04-12T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("exportIssuesToCsv", () => {
  it("includes header row", () => {
    const csv = exportIssuesToCsv(makeAuditData());
    expect(csv.startsWith("URL,Severity,Category,Message")).toBe(true);
  });

  it("includes issue rows", () => {
    const csv = exportIssuesToCsv(makeAuditData());
    const lines = csv.split("\n");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("handles empty pages", () => {
    const csv = exportIssuesToCsv(makeAuditData({ pages: [] }));
    expect(csv).toBe("URL,Severity,Category,Message");
  });
});

describe("exportBrokenLinksCsv", () => {
  it("includes header and broken link rows", () => {
    const csv = exportBrokenLinksCsv(makeAuditData());
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("404");
  });
});

describe("exportHealthScoreCsv", () => {
  it("includes category breakdown rows", () => {
    const csv = exportHealthScoreCsv(makeAuditData());
    const lines = csv.split("\n");
    expect(lines).toHaveLength(5); // header + 4 categories
    expect(lines[1]).toContain("technical");
  });
});

describe("exportToJson", () => {
  it("returns valid JSON", () => {
    const json = exportToJson(makeAuditData());
    const parsed = JSON.parse(json);
    expect(parsed.siteUrl).toBe("https://example.com");
  });
});

describe("buildFullReportMarkdown", () => {
  it("includes site URL", () => {
    const md = buildFullReportMarkdown(makeAuditData());
    expect(md).toContain("https://example.com");
  });

  it("includes health score section", () => {
    const md = buildFullReportMarkdown(makeAuditData());
    expect(md).toContain("## Health Score");
    expect(md).toContain("85/100");
  });

  it("includes link analysis section", () => {
    const md = buildFullReportMarkdown(makeAuditData());
    expect(md).toContain("## Link Analysis");
    expect(md).toContain("Broken Links: 1");
  });

  it("includes CWV section", () => {
    const md = buildFullReportMarkdown(makeAuditData());
    expect(md).toContain("## Core Web Vitals");
    expect(md).toContain("2000");
  });

  it("omits sections with no data", () => {
    const md = buildFullReportMarkdown(
      makeAuditData({
        healthScore: undefined,
        linkAnalysis: undefined,
        coreWebVitals: undefined,
      }),
    );
    expect(md).not.toContain("## Health Score");
    expect(md).not.toContain("## Link Analysis");
    expect(md).not.toContain("## Core Web Vitals");
  });
});
