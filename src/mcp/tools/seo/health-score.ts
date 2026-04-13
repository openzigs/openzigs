/**
 * Site Health Score & Issue Prioritization (#843)
 *
 * Classifies audit issues by severity and computes a 0–100 health score.
 *
 * Formula: 100 - sum(issues × severity_weight)
 * Weights: critical=10, high=3, medium=1, low=0.25
 *
 * Category breakdown: technical, content, links, performance
 */

// ── Types ────────────────────────────────────────────────────────────────

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export interface ClassifiedIssue {
  severity: IssueSeverity;
  category: HealthCategory;
  message: string;
  url?: string;
}

export type HealthCategory = "technical" | "content" | "links" | "performance";

export interface CategoryBreakdown {
  category: HealthCategory;
  score: number;
  issueCount: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface HealthScoreResult {
  score: number;
  rating: "good" | "needs-improvement" | "poor";
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  categories: CategoryBreakdown[];
}

// ── Severity weights ─────────────────────────────────────────────────────

export const SEVERITY_WEIGHTS: Record<IssueSeverity, number> = {
  critical: 10,
  high: 3,
  medium: 1,
  low: 0.25,
};

// ── Audit issue → classified issue mapping ───────────────────────────────

/**
 * Maps the existing audit issue `severity` + `category` to the new
 * four-level severity and health category.
 */
export function classifyAuditIssue(issue: {
  severity: string;
  category: string;
  message: string;
  url?: string;
}): ClassifiedIssue {
  return {
    severity: mapSeverity(issue.severity, issue.category, issue.message),
    category: mapCategory(issue.category),
    message: issue.message,
    url: issue.url,
  };
}

function mapSeverity(
  original: string,
  category: string,
  message: string,
): IssueSeverity {
  // Critical: missing title, broken links (4xx/5xx), security issues
  if (original === "error") {
    if (
      message.includes("Missing page title") ||
      message.includes("Missing H1")
    ) {
      return "critical";
    }
    if (message.includes("Missing meta description")) return "high";
    return "high";
  }

  // Warnings map to medium or high depending on category
  if (original === "warning") {
    if (category === "duplicates") return "high";
    if (category === "content" && message.includes("Thin content"))
      return "medium";
    if (category === "links") return "medium";
    if (category === "images") return "medium";
    return "medium";
  }

  // Info → low
  return "low";
}

function mapCategory(original: string): HealthCategory {
  switch (original) {
    case "meta":
    case "headings":
    case "schema":
    case "duplicates":
      return "technical";
    case "content":
      return "content";
    case "links":
      return "links";
    case "images":
      return "technical";
    default:
      return "technical";
  }
}

// ── Health score calculation ─────────────────────────────────────────────

/**
 * Calculates a site health score from classified issues.
 *
 * When `pageCount` is provided the raw deductions are averaged per-page
 * so that a large site with many pages doesn't automatically score 0.
 *
 * Formula:
 *   rawDeductions  = sum(issues × severity_weight)
 *   normalizedDed  = rawDeductions / max(pageCount, 1)
 *   healthScore    = max(0, round(100 - min(normalizedDed, 100)))
 */
export function calculateHealthScore(
  issues: ClassifiedIssue[],
  pageCount?: number,
): HealthScoreResult {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let rawPenalty = 0;

  for (const issue of issues) {
    counts[issue.severity]++;
    rawPenalty += SEVERITY_WEIGHTS[issue.severity];
  }

  const divisor = Math.max(pageCount ?? 1, 1);
  const normalizedPenalty = rawPenalty / divisor;
  const score = Math.max(0, Math.round(100 - Math.min(normalizedPenalty, 100)));

  const categories: HealthCategory[] = [
    "technical",
    "content",
    "links",
    "performance",
  ];

  const categoryBreakdowns: CategoryBreakdown[] = categories.map((category) => {
    const catIssues = issues.filter((i) => i.category === category);
    let catRawPenalty = 0;
    const catCounts = { critical: 0, high: 0, medium: 0, low: 0 };

    for (const issue of catIssues) {
      catCounts[issue.severity]++;
      catRawPenalty += SEVERITY_WEIGHTS[issue.severity];
    }

    const catNormalized = catRawPenalty / divisor;
    return {
      category,
      score: Math.max(0, Math.round(100 - Math.min(catNormalized, 100))),
      issueCount: catIssues.length,
      ...catCounts,
    };
  });

  let rating: HealthScoreResult["rating"];
  if (score >= 80) rating = "good";
  else if (score >= 60) rating = "needs-improvement";
  else rating = "poor";

  return {
    score,
    rating,
    totalIssues: issues.length,
    ...counts,
    categories: categoryBreakdowns,
  };
}
