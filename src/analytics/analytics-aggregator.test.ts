import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  AnalyticsCache,
  AnalyticsAggregator,
  type VideoMetrics,
} from "./analytics-aggregator.js";

function makeMetrics(overrides: Partial<VideoMetrics> = {}): VideoMetrics {
  return {
    contentId: "v-1",
    platform: "youtube",
    title: "Test Video",
    publishedUrl: "https://youtube.com/watch?v=123",
    views: 1000,
    likes: 50,
    comments: 10,
    shares: 5,
    engagementRate: 6.5,
    watchTimeMinutes: 300,
    ctr: 4.2,
    publishedAt: "2026-04-10T10:00:00Z",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("AnalyticsCache", () => {
  let db: Database.Database;
  let cache: AnalyticsCache;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    cache = new AnalyticsCache(db);
    cache.migrate();
  });

  it("stores and retrieves metrics", () => {
    const m = makeMetrics();
    cache.set(m);
    const got = cache.get("v-1", "youtube");
    expect(got).not.toBeNull();
    expect(got!.views).toBe(1000);
    expect(got!.title).toBe("Test Video");
  });

  it("returns null for expired entries", () => {
    const expired = makeMetrics({
      fetchedAt: new Date(Date.now() - 7200_000).toISOString(),
    });
    cache.set(expired);
    const got = cache.get("v-1", "youtube");
    expect(got).toBeNull();
  });

  it("returns null for missing entries", () => {
    expect(cache.get("missing", "youtube")).toBeNull();
  });

  it("getAll returns all entries", () => {
    cache.set(makeMetrics({ contentId: "v-1" }));
    cache.set(makeMetrics({ contentId: "v-2", views: 500 }));
    const all = cache.getAll();
    expect(all).toHaveLength(2);
  });

  it("getAll filters by date range", () => {
    cache.set(
      makeMetrics({ contentId: "v-1", publishedAt: "2026-04-01T10:00:00Z" }),
    );
    cache.set(
      makeMetrics({ contentId: "v-2", publishedAt: "2026-04-15T10:00:00Z" }),
    );
    const filtered = cache.getAll({ start: "2026-04-10", end: "2026-04-20" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].contentId).toBe("v-2");
  });

  it("clear removes all entries", () => {
    cache.set(makeMetrics());
    cache.clear();
    expect(cache.getAll()).toHaveLength(0);
  });

  it("upserts on duplicate key", () => {
    cache.set(makeMetrics({ views: 100 }));
    cache.set(makeMetrics({ views: 200 }));
    const all = cache.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].views).toBe(200);
  });
});

describe("AnalyticsAggregator", () => {
  let db: Database.Database;
  let cache: AnalyticsCache;
  let agg: AnalyticsAggregator;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    cache = new AnalyticsCache(db, { ttlMs: 86400_000 });
    cache.migrate();
    agg = new AnalyticsAggregator(cache);
  });

  it("ingest writes to cache", () => {
    agg.ingest(makeMetrics());
    expect(cache.getAll()).toHaveLength(1);
  });

  it("summarize computes totals", () => {
    agg.ingest(
      makeMetrics({
        contentId: "v-1",
        views: 1000,
        likes: 50,
        comments: 10,
        shares: 5,
      }),
    );
    agg.ingest(
      makeMetrics({
        contentId: "v-2",
        platform: "tiktok",
        views: 2000,
        likes: 100,
        comments: 20,
        shares: 10,
      }),
    );
    const summary = agg.summarize();
    expect(summary.totalViews).toBe(3000);
    expect(summary.totalEngagements).toBe(195);
    expect(summary.platformBreakdown).toHaveLength(2);
    expect(summary.topContent!.contentId).toBe("v-2");
  });

  it("summarize returns zero summary for empty data", () => {
    const summary = agg.summarize();
    expect(summary.totalViews).toBe(0);
    expect(summary.topContent).toBeNull();
    expect(summary.platformBreakdown).toHaveLength(0);
  });

  it("computeBestTimes returns sorted slots", () => {
    agg.ingest(
      makeMetrics({
        contentId: "v-1",
        publishedAt: "2026-04-07T10:00:00Z",
        engagementRate: 8.0,
      }),
    );
    agg.ingest(
      makeMetrics({
        contentId: "v-2",
        publishedAt: "2026-04-07T14:00:00Z",
        engagementRate: 3.0,
      }),
    );
    const times = agg.computeBestTimes();
    expect(times.length).toBeGreaterThan(0);
    expect(times[0].avgEngagementRate).toBeGreaterThanOrEqual(
      times[times.length - 1].avgEngagementRate,
    );
  });

  it("compare returns both items", () => {
    agg.ingest(makeMetrics({ contentId: "v-1", platform: "youtube" }));
    agg.ingest(makeMetrics({ contentId: "v-2", platform: "tiktok" }));
    const result = agg.compare("v-1", "youtube", "v-2", "tiktok");
    expect(result.a).not.toBeNull();
    expect(result.b).not.toBeNull();
  });

  it("compare returns null for missing items", () => {
    const result = agg.compare("missing", "youtube", "also-missing", "tiktok");
    expect(result.a).toBeNull();
    expect(result.b).toBeNull();
  });
});
