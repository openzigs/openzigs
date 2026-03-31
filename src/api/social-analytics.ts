/**
 * Social Analytics API router.
 *
 * Provides aggregated analytics from the Social Brain CRM data:
 *   GET /api/admin/social/analytics — time-series + summary analytics
 *   GET /api/admin/social/analytics/export — CSV export of analytics data
 */

import { Router, type Request, type Response } from "express";
import type { SocialRepository } from "../channels/social/social-repository.js";
import type { ConversationAnalytics } from "../channels/social/types.js";

// ── Types ──────────────────────────────────────────────────────────────

export type AnalyticsSummary = {
  totalMessages: number;
  totalContacts: number;
  autoReplyRate: number;
  escalationRate: number;
  leadCount: number;
  avgResponseTimeMs: number;
};

export type TimeSeriesEntry = {
  period: string;
  messagesIn: number;
  messagesOut: number;
  autoReplies: number;
  escalations: number;
  newLeads: number;
};

export type PlatformBreakdown = {
  platform: string;
  messages: number;
  contacts: number;
  leads: number;
  autoReplyRate: number;
};

export type AnalyticsResponse = {
  summary: AnalyticsSummary;
  timeSeries: TimeSeriesEntry[];
  platformBreakdown: PlatformBreakdown[];
};

// ── Aggregation logic ──────────────────────────────────────────────────

export function aggregateAnalytics(
  entries: ConversationAnalytics[],
): { summary: AnalyticsSummary; platformBreakdown: PlatformBreakdown[] } {
  let totalIn = 0;
  let totalOut = 0;
  let totalContacts = 0;
  let totalLeads = 0;
  let autoReplySum = 0;
  let escalationSum = 0;
  let msgCount = 0;

  const platformBreakdown: PlatformBreakdown[] = [];

  for (const entry of entries) {
    const msgs = entry.total_messages_in + entry.total_messages_out;
    totalIn += entry.total_messages_in;
    totalOut += entry.total_messages_out;
    totalContacts += entry.total_conversations;
    totalLeads += entry.leads_captured;
    autoReplySum += entry.auto_reply_rate * msgs;
    escalationSum += entry.escalation_rate * msgs;
    msgCount += msgs;

    platformBreakdown.push({
      platform: entry.platform,
      messages: msgs,
      contacts: entry.total_conversations,
      leads: entry.leads_captured,
      autoReplyRate: entry.auto_reply_rate,
    });
  }

  const summary: AnalyticsSummary = {
    totalMessages: totalIn + totalOut,
    totalContacts,
    autoReplyRate: msgCount > 0 ? autoReplySum / msgCount : 0,
    escalationRate: msgCount > 0 ? escalationSum / msgCount : 0,
    leadCount: totalLeads,
    avgResponseTimeMs: 0, // TODO: compute from paired timestamps
  };

  return { summary, platformBreakdown };
}

/**
 * Build time-series data by grouping messages by day/week/month.
 * This performs raw SQL queries on the social_messages + contacts tables.
 */
export function buildTimeSeries(
  db: import("better-sqlite3").Database,
  since: string,
  until: string,
  groupBy: "day" | "week" | "month",
  platform?: string,
): TimeSeriesEntry[] {
  const dateTrunc =
    groupBy === "day"
      ? "date(sm.created_at)"
      : groupBy === "week"
        ? "date(sm.created_at, 'weekday 0', '-6 days')"
        : "date(sm.created_at, 'start of month')";

  const platformClause = platform ? "AND c.platform = ?" : "";
  const params: unknown[] = [since, until];
  if (platform) params.push(platform);

  const rows = db
    .prepare(
      `SELECT
        ${dateTrunc} as period,
        SUM(CASE WHEN sm.direction = 'inbound' THEN 1 ELSE 0 END) as messages_in,
        SUM(CASE WHEN sm.direction = 'outbound' THEN 1 ELSE 0 END) as messages_out,
        SUM(CASE WHEN sm.status = 'auto_replied' THEN 1 ELSE 0 END) as auto_replies,
        SUM(CASE WHEN sm.status = 'escalated' THEN 1 ELSE 0 END) as escalations
      FROM social_messages sm
      JOIN contacts c ON c.id = sm.contact_id
      WHERE sm.created_at >= ? AND sm.created_at <= ? ${platformClause}
      GROUP BY period
      ORDER BY period ASC`,
    )
    .all(...params) as Array<Record<string, number | string>>;

  return rows.map((r) => ({
    period: String(r.period),
    messagesIn: Number(r.messages_in ?? 0),
    messagesOut: Number(r.messages_out ?? 0),
    autoReplies: Number(r.auto_replies ?? 0),
    escalations: Number(r.escalations ?? 0),
    newLeads: 0, // computed separately below if needed
  }));
}

/**
 * Export analytics as CSV.
 */
export function analyticsToCSV(
  summary: AnalyticsSummary,
  timeSeries: TimeSeriesEntry[],
  platformBreakdown: PlatformBreakdown[],
): string {
  const lines: string[] = [];

  // Summary section
  lines.push("# Summary");
  lines.push("Metric,Value");
  lines.push(`Total Messages,${summary.totalMessages}`);
  lines.push(`Total Contacts,${summary.totalContacts}`);
  lines.push(`Auto-Reply Rate,${(summary.autoReplyRate * 100).toFixed(1)}%`);
  lines.push(`Escalation Rate,${(summary.escalationRate * 100).toFixed(1)}%`);
  lines.push(`Lead Count,${summary.leadCount}`);
  lines.push("");

  // Platform breakdown
  lines.push("# Platform Breakdown");
  lines.push("Platform,Messages,Contacts,Leads,Auto-Reply Rate");
  for (const p of platformBreakdown) {
    lines.push(
      `${p.platform},${p.messages},${p.contacts},${p.leads},${(p.autoReplyRate * 100).toFixed(1)}%`,
    );
  }
  lines.push("");

  // Time series
  lines.push("# Time Series");
  lines.push("Period,Messages In,Messages Out,Auto-Replies,Escalations,New Leads");
  for (const t of timeSeries) {
    lines.push(
      `${t.period},${t.messagesIn},${t.messagesOut},${t.autoReplies},${t.escalations},${t.newLeads}`,
    );
  }

  return lines.join("\n");
}

// ── Router factory ─────────────────────────────────────────────────────

export function createSocialAnalyticsRouter(deps: {
  socialRepo: SocialRepository;
  db: import("better-sqlite3").Database;
}): Router {
  const router = Router();

  /**
   * GET /api/admin/social/analytics
   * Query: since (ISO8601), until (ISO8601), groupBy (day|week|month), platform?
   */
  router.get("/", (req: Request, res: Response) => {
    const since = String(req.query.since ?? new Date(Date.now() - 30 * 86400000).toISOString());
    const until = String(req.query.until ?? new Date().toISOString());
    const groupBy = (req.query.groupBy as string) ?? "day";
    const platform = req.query.platform as string | undefined;

    if (!["day", "week", "month"].includes(groupBy)) {
      res.status(400).json({ error: "groupBy must be day, week, or month" });
      return;
    }

    const analytics = deps.socialRepo.getAnalytics(since);
    const filtered = platform
      ? analytics.filter((a) => a.platform === platform)
      : analytics;

    const { summary, platformBreakdown } = aggregateAnalytics(filtered);

    let timeSeries: TimeSeriesEntry[] = [];
    try {
      timeSeries = buildTimeSeries(
        deps.db,
        since,
        until,
        groupBy as "day" | "week" | "month",
        platform,
      );
    } catch {
      // Tables may not exist yet — return empty time series
    }

    const response: AnalyticsResponse = { summary, timeSeries, platformBreakdown };
    res.json(response);
  });

  /**
   * GET /api/admin/social/analytics/export
   * Query: format=csv|json, plus same filters as main endpoint
   */
  router.get("/export", (req: Request, res: Response) => {
    const format = (req.query.format as string) ?? "csv";
    const since = String(req.query.since ?? new Date(Date.now() - 30 * 86400000).toISOString());
    const until = String(req.query.until ?? new Date().toISOString());
    const groupBy = (req.query.groupBy as string) ?? "day";
    const platform = req.query.platform as string | undefined;

    const analytics = deps.socialRepo.getAnalytics(since);
    const filtered = platform
      ? analytics.filter((a) => a.platform === platform)
      : analytics;

    const { summary, platformBreakdown } = aggregateAnalytics(filtered);

    let timeSeries: TimeSeriesEntry[] = [];
    try {
      timeSeries = buildTimeSeries(
        deps.db,
        since,
        until,
        groupBy as "day" | "week" | "month",
        platform,
      );
    } catch {
      // Tables may not exist
    }

    if (format === "json") {
      res.setHeader("Content-Disposition", "attachment; filename=social-analytics.json");
      res.json({ summary, timeSeries, platformBreakdown });
      return;
    }

    // Default: CSV
    const csv = analyticsToCSV(summary, timeSeries, platformBreakdown);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=social-analytics.csv");
    res.send(csv);
  });

  return router;
}
