import { describe, it, expect } from "vitest";
import {
  calculateHealthScore,
  classifyAuditIssue,
  SEVERITY_WEIGHTS,
  type ClassifiedIssue,
} from "./health-score.js";

describe("classifyAuditIssue", () => {
  it("maps error + missing title to critical", () => {
    const result = classifyAuditIssue({
      severity: "error",
      category: "meta",
      message: "Missing page title",
    });
    expect(result.severity).toBe("critical");
    expect(result.category).toBe("technical");
  });

  it("maps error + missing H1 to critical", () => {
    const result = classifyAuditIssue({
      severity: "error",
      category: "headings",
      message: "Missing H1 tag",
    });
    expect(result.severity).toBe("critical");
  });

  it("maps error + missing meta description to high", () => {
    const result = classifyAuditIssue({
      severity: "error",
      category: "meta",
      message: "Missing meta description",
    });
    expect(result.severity).toBe("high");
  });

  it("maps warning + duplicates to high", () => {
    const result = classifyAuditIssue({
      severity: "warning",
      category: "duplicates",
      message: "Duplicate meta title",
    });
    expect(result.severity).toBe("high");
    expect(result.category).toBe("technical");
  });

  it("maps warning + thin content to medium", () => {
    const result = classifyAuditIssue({
      severity: "warning",
      category: "content",
      message: "Thin content (50 words)",
    });
    expect(result.severity).toBe("medium");
    expect(result.category).toBe("content");
  });

  it("maps info to low", () => {
    const result = classifyAuditIssue({
      severity: "info",
      category: "schema",
      message: "No structured data found",
    });
    expect(result.severity).toBe("low");
    expect(result.category).toBe("technical");
  });

  it("preserves url field", () => {
    const result = classifyAuditIssue({
      severity: "error",
      category: "meta",
      message: "Missing page title",
      url: "https://example.com/page",
    });
    expect(result.url).toBe("https://example.com/page");
  });
});

describe("calculateHealthScore", () => {
  it("returns 100 for no issues", () => {
    const result = calculateHealthScore([]);
    expect(result.score).toBe(100);
    expect(result.rating).toBe("good");
    expect(result.totalIssues).toBe(0);
  });

  it("penalizes critical issues by 10 points each", () => {
    const issues: ClassifiedIssue[] = [
      { severity: "critical", category: "technical", message: "Test" },
    ];
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(90);
    expect(result.critical).toBe(1);
  });

  it("penalizes high issues by 3 points each", () => {
    const issues: ClassifiedIssue[] = [
      { severity: "high", category: "content", message: "Test" },
      { severity: "high", category: "content", message: "Test 2" },
    ];
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(94);
    expect(result.high).toBe(2);
  });

  it("penalizes medium issues by 1 point each", () => {
    const issues: ClassifiedIssue[] = Array.from({ length: 5 }, (_, i) => ({
      severity: "medium" as const,
      category: "links" as const,
      message: `Issue ${i}`,
    }));
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(95);
    expect(result.medium).toBe(5);
  });

  it("penalizes low issues by 0.25 points each", () => {
    const issues: ClassifiedIssue[] = Array.from({ length: 4 }, () => ({
      severity: "low" as const,
      category: "technical" as const,
      message: "Info",
    }));
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(99);
    expect(result.low).toBe(4);
  });

  it("clamps score to 0 minimum", () => {
    const issues: ClassifiedIssue[] = Array.from({ length: 15 }, () => ({
      severity: "critical" as const,
      category: "technical" as const,
      message: "Bad",
    }));
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(0);
    expect(result.rating).toBe("poor");
  });

  it("normalizes score per-page when pageCount is provided", () => {
    // 500 medium issues across 500 pages → 500 / 500 = 1 deduction → score 99
    const issues: ClassifiedIssue[] = Array.from({ length: 500 }, (_, i) => ({
      severity: "medium" as const,
      category: "content" as const,
      message: `Issue ${i}`,
    }));
    const result = calculateHealthScore(issues, 500);
    expect(result.score).toBe(99);
    expect(result.totalIssues).toBe(500);
  });

  it("without pageCount, large sites score 0 (backward compat)", () => {
    const issues: ClassifiedIssue[] = Array.from({ length: 200 }, () => ({
      severity: "medium" as const,
      category: "technical" as const,
      message: "Issue",
    }));
    // 200 × 1 = 200 → clamped to 100 deductions → score 0
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(0);
  });

  it("caps normalized deductions at 100", () => {
    // 10 critical issues on 1 page → 100 deductions → score 0 even normalized
    const issues: ClassifiedIssue[] = Array.from({ length: 10 }, () => ({
      severity: "critical" as const,
      category: "technical" as const,
      message: "Bad",
    }));
    const result = calculateHealthScore(issues, 1);
    expect(result.score).toBe(0);
    expect(result.rating).toBe("poor");
  });

  it("normalizes category breakdown per-page", () => {
    const issues: ClassifiedIssue[] = Array.from({ length: 100 }, () => ({
      severity: "medium" as const,
      category: "links" as const,
      message: "Broken link",
    }));
    const result = calculateHealthScore(issues, 100);
    const links = result.categories.find((c) => c.category === "links")!;
    expect(links.score).toBe(99); // 100/100 = 1 deduction
    expect(links.issueCount).toBe(100);
  });

  it("rates good for score >= 80", () => {
    const result = calculateHealthScore([
      { severity: "high", category: "technical", message: "A" },
      { severity: "medium", category: "content", message: "B" },
    ]);
    expect(result.score).toBe(96);
    expect(result.rating).toBe("good");
  });

  it("rates needs-improvement for score 60-79", () => {
    const issues: ClassifiedIssue[] = Array.from({ length: 4 }, () => ({
      severity: "critical" as const,
      category: "technical" as const,
      message: "Bad",
    }));
    // 100 - 40 = 60
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(60);
    expect(result.rating).toBe("needs-improvement");
  });

  it("rates poor for score < 60", () => {
    const issues: ClassifiedIssue[] = Array.from({ length: 5 }, () => ({
      severity: "critical" as const,
      category: "technical" as const,
      message: "Bad",
    }));
    // 100 - 50 = 50
    const result = calculateHealthScore(issues);
    expect(result.score).toBe(50);
    expect(result.rating).toBe("poor");
  });

  it("provides category breakdown", () => {
    const issues: ClassifiedIssue[] = [
      { severity: "critical", category: "technical", message: "A" },
      { severity: "high", category: "content", message: "B" },
      { severity: "medium", category: "links", message: "C" },
    ];
    const result = calculateHealthScore(issues);
    expect(result.categories).toHaveLength(4);

    const tech = result.categories.find((c) => c.category === "technical")!;
    expect(tech.critical).toBe(1);
    expect(tech.score).toBe(90);

    const content = result.categories.find((c) => c.category === "content")!;
    expect(content.high).toBe(1);
    expect(content.score).toBe(97);
  });

  it("SEVERITY_WEIGHTS are correct", () => {
    expect(SEVERITY_WEIGHTS.critical).toBe(10);
    expect(SEVERITY_WEIGHTS.high).toBe(3);
    expect(SEVERITY_WEIGHTS.medium).toBe(1);
    expect(SEVERITY_WEIGHTS.low).toBe(0.25);
  });
});
