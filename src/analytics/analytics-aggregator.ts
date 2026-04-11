/**
 * Video Performance Analytics — Aggregation & Caching — #828
 *
 * Pulls performance metrics from social MCPs (YouTube, TikTok, etc.),
 * normalizes them, and caches results in SQLite with a configurable TTL.
 */
import type Database from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────────

export interface VideoMetrics {
  contentId: string;
  platform: string;
  title: string;
  publishedUrl: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagementRate: number; // (likes + comments + shares) / views * 100
  watchTimeMinutes: number;
  ctr: number; // click-through rate %
  publishedAt: string;
  fetchedAt: string;
}

export interface AnalyticsSummary {
  totalViews: number;
  totalEngagements: number;
  overallEngagementRate: number;
  topContent: VideoMetrics | null;
  platformBreakdown: PlatformSummary[];
  dateRange: { start: string; end: string };
}

export interface PlatformSummary {
  platform: string;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  avgEngagementRate: number;
  contentCount: number;
}

export interface BestTimeSlot {
  dayOfWeek: number; // 0=Sun…6=Sat
  hour: number; // 0–23
  avgEngagementRate: number;
  postCount: number;
}

// ── Analytics Cache ────────────────────────────────────────────

const DEFAULT_TTL_MS = 3600_000; // 1 hour

interface AnalyticsCacheRow {
  content_id: string;
  platform: string;
  title: string;
  published_url: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagement_rate: number;
  watch_time_minutes: number;
  ctr: number;
  published_at: string;
  fetched_at: string;
}

export class AnalyticsCache {
  private ttlMs: number;

  constructor(
    private db: Database.Database,
    options?: { ttlMs?: number },
  ) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_cache (
        content_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        published_url TEXT,
        views INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        engagement_rate REAL NOT NULL DEFAULT 0,
        watch_time_minutes REAL NOT NULL DEFAULT 0,
        ctr REAL NOT NULL DEFAULT 0,
        published_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (content_id, platform)
      );
    `);
  }

  get(contentId: string, platform: string): VideoMetrics | null {
    const row = this.db
      .prepare(
        "SELECT * FROM analytics_cache WHERE content_id = ? AND platform = ?",
      )
      .get(contentId, platform) as AnalyticsCacheRow | undefined;
    if (!row) return null;
    if (Date.now() - new Date(row.fetched_at).getTime() > this.ttlMs)
      return null;
    return this.rowToMetrics(row);
  }

  set(metrics: VideoMetrics): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO analytics_cache
        (content_id, platform, title, published_url, views, likes, comments, shares,
         engagement_rate, watch_time_minutes, ctr, published_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        metrics.contentId,
        metrics.platform,
        metrics.title,
        metrics.publishedUrl,
        metrics.views,
        metrics.likes,
        metrics.comments,
        metrics.shares,
        metrics.engagementRate,
        metrics.watchTimeMinutes,
        metrics.ctr,
        metrics.publishedAt,
        metrics.fetchedAt,
      );
  }

  getAll(dateRange?: { start: string; end: string }): VideoMetrics[] {
    let sql = "SELECT * FROM analytics_cache";
    const params: unknown[] = [];
    if (dateRange) {
      sql += " WHERE published_at >= ? AND published_at <= ?";
      params.push(dateRange.start, dateRange.end);
    }
    sql += " ORDER BY views DESC";
    const rows = this.db.prepare(sql).all(...params) as AnalyticsCacheRow[];
    return rows.map((r) => this.rowToMetrics(r));
  }

  clear(): void {
    this.db.exec("DELETE FROM analytics_cache");
  }

  private rowToMetrics(row: AnalyticsCacheRow): VideoMetrics {
    return {
      contentId: row.content_id,
      platform: row.platform,
      title: row.title,
      publishedUrl: row.published_url,
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      shares: row.shares,
      engagementRate: row.engagement_rate,
      watchTimeMinutes: row.watch_time_minutes,
      ctr: row.ctr,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
    };
  }
}

// ── Analytics Aggregator ───────────────────────────────────────

export class AnalyticsAggregator {
  constructor(private cache: AnalyticsCache) {}

  /**
   * Ingest metrics from any social MCP (YouTube, TikTok, etc.).
   * Caller is responsible for fetching from the platform API.
   */
  ingest(metrics: VideoMetrics): void {
    this.cache.set(metrics);
  }

  /**
   * Summarize all cached metrics for a given date range.
   */
  summarize(dateRange?: { start: string; end: string }): AnalyticsSummary {
    const all = this.cache.getAll(dateRange);

    const totalViews = all.reduce((s, m) => s + m.views, 0);
    const totalEngagements = all.reduce(
      (s, m) => s + m.likes + m.comments + m.shares,
      0,
    );
    const overallEngagementRate =
      totalViews > 0 ? (totalEngagements / totalViews) * 100 : 0;

    const topContent =
      all.length > 0
        ? all.reduce((best, m) => (m.views > best.views ? m : best))
        : null;

    // Platform breakdown
    const byPlatform = new Map<string, VideoMetrics[]>();
    for (const m of all) {
      const list = byPlatform.get(m.platform) ?? [];
      list.push(m);
      byPlatform.set(m.platform, list);
    }

    const platformBreakdown: PlatformSummary[] = [];
    for (const [platform, items] of byPlatform) {
      const totalPViews = items.reduce((s, m) => s + m.views, 0);
      const totalPLikes = items.reduce((s, m) => s + m.likes, 0);
      const totalPComments = items.reduce((s, m) => s + m.comments, 0);
      const totalPShares = items.reduce((s, m) => s + m.shares, 0);
      const avgEngagement =
        items.length > 0
          ? items.reduce((s, m) => s + m.engagementRate, 0) / items.length
          : 0;
      platformBreakdown.push({
        platform,
        totalViews: totalPViews,
        totalLikes: totalPLikes,
        totalComments: totalPComments,
        totalShares: totalPShares,
        avgEngagementRate: avgEngagement,
        contentCount: items.length,
      });
    }

    return {
      totalViews,
      totalEngagements,
      overallEngagementRate,
      topContent,
      platformBreakdown,
      dateRange: dateRange ?? {
        start: all.length > 0 ? all[all.length - 1].publishedAt : "",
        end: all.length > 0 ? all[0].publishedAt : "",
      },
    };
  }

  /**
   * Compute best posting times based on historical engagement.
   */
  computeBestTimes(): BestTimeSlot[] {
    const all = this.cache.getAll();
    const slotMap = new Map<string, { total: number; count: number }>();

    for (const m of all) {
      const d = new Date(m.publishedAt);
      const key = `${d.getUTCDay()}-${d.getUTCHours()}`;
      const slot = slotMap.get(key) ?? { total: 0, count: 0 };
      slot.total += m.engagementRate;
      slot.count += 1;
      slotMap.set(key, slot);
    }

    const slots: BestTimeSlot[] = [];
    for (const [key, data] of slotMap) {
      const [day, hour] = key.split("-").map(Number);
      slots.push({
        dayOfWeek: day,
        hour,
        avgEngagementRate: data.count > 0 ? data.total / data.count : 0,
        postCount: data.count,
      });
    }

    return slots.sort((a, b) => b.avgEngagementRate - a.avgEngagementRate);
  }

  /**
   * Compare two content items side-by-side.
   */
  compare(
    id1: string,
    platform1: string,
    id2: string,
    platform2: string,
  ): { a: VideoMetrics | null; b: VideoMetrics | null } {
    return {
      a: this.cache.get(id1, platform1),
      b: this.cache.get(id2, platform2),
    };
  }
}
