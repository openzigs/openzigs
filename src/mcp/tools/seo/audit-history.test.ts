import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { AuditHistoryRepository } from "./audit-history.js";
import type { HealthScoreResult } from "./health-score.js";

function makeHealthScore(
  overrides: Partial<HealthScoreResult> = {},
): HealthScoreResult {
  return {
    score: 85,
    rating: "good",
    totalIssues: 5,
    critical: 0,
    high: 1,
    medium: 3,
    low: 1,
    categories: [
      {
        category: "technical",
        score: 90,
        issueCount: 2,
        critical: 0,
        high: 1,
        medium: 1,
        low: 0,
      },
      {
        category: "content",
        score: 95,
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
        score: 99,
        issueCount: 2,
        critical: 0,
        high: 0,
        medium: 1,
        low: 1,
      },
    ],
    ...overrides,
  };
}

describe("AuditHistoryRepository", () => {
  let db: Database.Database;
  let repo: AuditHistoryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    repo = new AuditHistoryRepository(db);
  });

  it("creates the seo_audit_snapshots table on construction", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='seo_audit_snapshots'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("saveSnapshot stores a new snapshot and returns id", () => {
    const id = repo.saveSnapshot(
      "https://example.com",
      makeHealthScore(),
      25,
      '{"test": true}',
    );
    expect(id).toBeGreaterThan(0);
  });

  it("getSnapshot returns stored snapshot", () => {
    const id = repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 90 }),
      30,
      '{"pages": 30}',
    );
    const snapshot = repo.getSnapshot(id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.siteUrl).toBe("https://example.com");
    expect(snapshot!.healthScore).toBe(90);
    expect(snapshot!.pagesAudited).toBe(30);
  });

  it("getSnapshot returns undefined for non-existent id", () => {
    expect(repo.getSnapshot(999)).toBeUndefined();
  });

  it("listSnapshots returns snapshots for a site, newest first", () => {
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 80 }),
      20,
      "{}",
    );
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 85 }),
      25,
      "{}",
    );
    repo.saveSnapshot(
      "https://other.com",
      makeHealthScore({ score: 70 }),
      15,
      "{}",
    );

    const snapshots = repo.listSnapshots("https://example.com");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].healthScore).toBe(85); // newest
    expect(snapshots[1].healthScore).toBe(80);
  });

  it("listSnapshots respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      repo.saveSnapshot(
        "https://example.com",
        makeHealthScore({ score: 50 + i }),
        10 + i,
        "{}",
      );
    }
    const snapshots = repo.listSnapshots("https://example.com", 3);
    expect(snapshots).toHaveLength(3);
  });

  it("listAll returns all snapshots", () => {
    repo.saveSnapshot("https://a.com", makeHealthScore(), 10, "{}");
    repo.saveSnapshot("https://b.com", makeHealthScore(), 20, "{}");

    const all = repo.listAll();
    expect(all).toHaveLength(2);
  });

  it("compareLatest returns null when no snapshots exist", () => {
    expect(repo.compareLatest("https://example.com")).toBeNull();
  });

  it("compareLatest returns comparison with null previous for single snapshot", () => {
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 80, totalIssues: 5 }),
      20,
      "{}",
    );

    const comparison = repo.compareLatest("https://example.com");
    expect(comparison).not.toBeNull();
    expect(comparison!.current.healthScore).toBe(80);
    expect(comparison!.previous).toBeNull();
    expect(comparison!.newIssues).toBe(5);
    expect(comparison!.resolvedIssues).toBe(0);
  });

  it("compareLatest detects regressions", () => {
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 85, totalIssues: 3, critical: 0, high: 1 }),
      20,
      "{}",
    );
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 60, totalIssues: 10, critical: 2, high: 3 }),
      20,
      "{}",
    );

    const comparison = repo.compareLatest("https://example.com");
    expect(comparison!.scoreDelta).toBe(-25);
    expect(comparison!.newIssues).toBe(7);
    expect(comparison!.regressions.length).toBeGreaterThan(0);
    expect(
      comparison!.regressions.some((r) =>
        r.includes("Critical issues increased"),
      ),
    ).toBe(true);
    expect(
      comparison!.regressions.some((r) => r.includes("Health score dropped")),
    ).toBe(true);
  });

  it("compareLatest detects improvement", () => {
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 60, totalIssues: 10, critical: 2, high: 3 }),
      20,
      "{}",
    );
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 85, totalIssues: 3, critical: 0, high: 1 }),
      25,
      "{}",
    );

    const comparison = repo.compareLatest("https://example.com");
    expect(comparison!.scoreDelta).toBe(25);
    expect(comparison!.resolvedIssues).toBe(7);
    expect(comparison!.regressions).toHaveLength(0);
  });

  it("migrate is idempotent", () => {
    // Call migrate again — should not throw
    repo.migrate();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='seo_audit_snapshots'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("getTrend returns oldest-first score data", () => {
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 70 }),
      10,
      "{}",
    );
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 80 }),
      15,
      "{}",
    );
    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 90 }),
      20,
      "{}",
    );

    const trend = repo.getTrend("https://example.com");
    expect(trend).toHaveLength(3);
    expect(trend[0].score).toBe(70); // oldest first
    expect(trend[2].score).toBe(90); // newest last
  });

  it("getTrend respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.saveSnapshot(
        "https://example.com",
        makeHealthScore({ score: 50 + i * 5 }),
        10,
        "{}",
      );
    }
    const trend = repo.getTrend("https://example.com", 3);
    expect(trend).toHaveLength(3);
  });

  it("pruneOldSnapshots removes old entries", () => {
    // Insert an old snapshot by manipulating created_at
    db.prepare(
      "INSERT INTO seo_audit_snapshots (site_url, health_score, rating, pages_audited, total_issues, critical, high, medium, low, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "https://example.com",
      80,
      "good",
      10,
      5,
      0,
      1,
      3,
      1,
      "{}",
      "2020-01-01T00:00:00.000Z",
    );

    repo.saveSnapshot(
      "https://example.com",
      makeHealthScore({ score: 90 }),
      20,
      "{}",
    );

    const deleted = repo.pruneOldSnapshots(1); // prune older than 1 day
    expect(deleted).toBe(1);

    const remaining = repo.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].healthScore).toBe(90);
  });

  it("pruneOldSnapshots scoped to site", () => {
    db.prepare(
      "INSERT INTO seo_audit_snapshots (site_url, health_score, rating, pages_audited, total_issues, critical, high, medium, low, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "https://a.com",
      70,
      "needs-improvement",
      10,
      5,
      0,
      1,
      3,
      1,
      "{}",
      "2020-01-01T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO seo_audit_snapshots (site_url, health_score, rating, pages_audited, total_issues, critical, high, medium, low, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "https://b.com",
      60,
      "poor",
      10,
      5,
      0,
      1,
      3,
      1,
      "{}",
      "2020-01-01T00:00:00.000Z",
    );

    const deleted = repo.pruneOldSnapshots(1, "https://a.com");
    expect(deleted).toBe(1);

    const remaining = repo.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].siteUrl).toBe("https://b.com");
  });

  it("deleteSnapshot removes a single entry", () => {
    const id = repo.saveSnapshot(
      "https://example.com",
      makeHealthScore(),
      10,
      "{}",
    );
    expect(repo.deleteSnapshot(id)).toBe(true);
    expect(repo.getSnapshot(id)).toBeUndefined();
  });

  it("deleteSnapshot returns false for non-existent id", () => {
    expect(repo.deleteSnapshot(9999)).toBe(false);
  });
});
