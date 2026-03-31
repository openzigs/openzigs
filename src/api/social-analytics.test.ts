import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  aggregateAnalytics,
  analyticsToCSV,
  buildTimeSeries,
  type AnalyticsSummary,
  type TimeSeriesEntry,
  type PlatformBreakdown,
} from "./social-analytics.js";
import type { ConversationAnalytics } from "../channels/social/types.js";

// ── aggregateAnalytics ─────────────────────────────────────────────────

describe("aggregateAnalytics", () => {
  it("returns zero summary for empty input", () => {
    const { summary, platformBreakdown } = aggregateAnalytics([]);
    expect(summary.totalMessages).toBe(0);
    expect(summary.totalContacts).toBe(0);
    expect(summary.leadCount).toBe(0);
    expect(summary.autoReplyRate).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(platformBreakdown).toHaveLength(0);
  });

  it("aggregates single platform", () => {
    const entries: ConversationAnalytics[] = [
      {
        platform: "instagram" as any,
        total_conversations: 10,
        total_messages_in: 30,
        total_messages_out: 20,
        avg_response_time_ms: 0,
        auto_reply_rate: 0.5,
        escalation_rate: 0.1,
        leads_captured: 3,
      },
    ];

    const { summary, platformBreakdown } = aggregateAnalytics(entries);
    expect(summary.totalMessages).toBe(50);
    expect(summary.totalContacts).toBe(10);
    expect(summary.leadCount).toBe(3);
    expect(summary.autoReplyRate).toBe(0.5);
    expect(summary.escalationRate).toBe(0.1);
    expect(platformBreakdown).toHaveLength(1);
    expect(platformBreakdown[0].platform).toBe("instagram");
  });

  it("aggregates multiple platforms", () => {
    const entries: ConversationAnalytics[] = [
      {
        platform: "instagram" as any,
        total_conversations: 10,
        total_messages_in: 20,
        total_messages_out: 10,
        avg_response_time_ms: 0,
        auto_reply_rate: 0.6,
        escalation_rate: 0.1,
        leads_captured: 2,
      },
      {
        platform: "telegram" as any,
        total_conversations: 5,
        total_messages_in: 15,
        total_messages_out: 5,
        avg_response_time_ms: 0,
        auto_reply_rate: 0.4,
        escalation_rate: 0.2,
        leads_captured: 1,
      },
    ];

    const { summary, platformBreakdown } = aggregateAnalytics(entries);
    expect(summary.totalMessages).toBe(50); // 20+10+15+5
    expect(summary.totalContacts).toBe(15);
    expect(summary.leadCount).toBe(3);
    expect(platformBreakdown).toHaveLength(2);

    // Weighted auto-reply rate: (0.6*30 + 0.4*20) / 50 = (18+8)/50 = 0.52
    expect(summary.autoReplyRate).toBeCloseTo(0.52, 2);
  });

  it("handles platform with zero messages", () => {
    const entries: ConversationAnalytics[] = [
      {
        platform: "discord" as any,
        total_conversations: 0,
        total_messages_in: 0,
        total_messages_out: 0,
        avg_response_time_ms: 0,
        auto_reply_rate: 0,
        escalation_rate: 0,
        leads_captured: 0,
      },
    ];

    const { summary } = aggregateAnalytics(entries);
    expect(summary.totalMessages).toBe(0);
    expect(summary.autoReplyRate).toBe(0);
  });
});

// ── analyticsToCSV ─────────────────────────────────────────────────────

describe("analyticsToCSV", () => {
  it("generates valid CSV output", () => {
    const summary: AnalyticsSummary = {
      totalMessages: 100,
      totalContacts: 20,
      autoReplyRate: 0.45,
      escalationRate: 0.1,
      leadCount: 5,
      avgResponseTimeMs: 0,
    };

    const timeSeries: TimeSeriesEntry[] = [
      { period: "2026-03-01", messagesIn: 10, messagesOut: 8, autoReplies: 5, escalations: 1, newLeads: 1 },
      { period: "2026-03-02", messagesIn: 12, messagesOut: 10, autoReplies: 6, escalations: 2, newLeads: 0 },
    ];

    const platformBreakdown: PlatformBreakdown[] = [
      { platform: "instagram", messages: 60, contacts: 12, leads: 3, autoReplyRate: 0.5 },
      { platform: "telegram", messages: 40, contacts: 8, leads: 2, autoReplyRate: 0.4 },
    ];

    const csv = analyticsToCSV(summary, timeSeries, platformBreakdown);

    expect(csv).toContain("# Summary");
    expect(csv).toContain("Total Messages,100");
    expect(csv).toContain("Total Contacts,20");
    expect(csv).toContain("Auto-Reply Rate,45.0%");
    expect(csv).toContain("Lead Count,5");
    expect(csv).toContain("# Platform Breakdown");
    expect(csv).toContain("instagram,60,12,3,50.0%");
    expect(csv).toContain("# Time Series");
    expect(csv).toContain("2026-03-01,10,8,5,1,1");
  });

  it("handles empty data", () => {
    const csv = analyticsToCSV(
      { totalMessages: 0, totalContacts: 0, autoReplyRate: 0, escalationRate: 0, leadCount: 0, avgResponseTimeMs: 0 },
      [],
      [],
    );
    expect(csv).toContain("# Summary");
    expect(csv).toContain("Total Messages,0");
  });
});

// ── buildTimeSeries ────────────────────────────────────────────────────

describe("buildTimeSeries", () => {
  function setupDb() {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_user_id TEXT,
        display_name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE social_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT,
        status TEXT DEFAULT 'sent',
        created_at TEXT NOT NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );
    `);
    return db;
  }

  it("returns empty array when no messages", () => {
    const db = setupDb();
    const result = buildTimeSeries(db, "2026-01-01", "2026-12-31", "day");
    expect(result).toHaveLength(0);
  });

  it("groups by day", () => {
    const db = setupDb();
    db.exec(`
      INSERT INTO contacts (id, platform, platform_user_id) VALUES ('c1', 'instagram', 'user1');
      INSERT INTO social_messages (id, contact_id, direction, content, status, created_at)
        VALUES ('m1', 'c1', 'inbound', 'hi', 'sent', '2026-03-10T10:00:00Z');
      INSERT INTO social_messages (id, contact_id, direction, content, status, created_at)
        VALUES ('m2', 'c1', 'outbound', 'hello', 'auto_replied', '2026-03-10T11:00:00Z');
      INSERT INTO social_messages (id, contact_id, direction, content, status, created_at)
        VALUES ('m3', 'c1', 'inbound', 'thanks', 'sent', '2026-03-11T09:00:00Z');
    `);

    const result = buildTimeSeries(db, "2026-03-01", "2026-03-31", "day");
    expect(result.length).toBeGreaterThanOrEqual(2);

    const day10 = result.find((r) => r.period === "2026-03-10");
    expect(day10).toBeDefined();
    expect(day10!.messagesIn).toBe(1);
    expect(day10!.messagesOut).toBe(1);
    expect(day10!.autoReplies).toBe(1);
  });

  it("groups by month", () => {
    const db = setupDb();
    db.exec(`
      INSERT INTO contacts (id, platform, platform_user_id) VALUES ('c1', 'telegram', 'user1');
      INSERT INTO social_messages (id, contact_id, direction, content, status, created_at)
        VALUES ('m1', 'c1', 'inbound', 'hi', 'sent', '2026-03-05T10:00:00Z');
      INSERT INTO social_messages (id, contact_id, direction, content, status, created_at)
        VALUES ('m2', 'c1', 'inbound', 'hello', 'sent', '2026-03-20T10:00:00Z');
    `);

    const result = buildTimeSeries(db, "2026-01-01", "2026-12-31", "month");
    expect(result).toHaveLength(1);
    expect(result[0].period).toBe("2026-03-01");
    expect(result[0].messagesIn).toBe(2);
  });

  it("filters by platform", () => {
    const db = setupDb();
    db.exec(`
      INSERT INTO contacts (id, platform, platform_user_id) VALUES ('c1', 'instagram', 'user1');
      INSERT INTO contacts (id, platform, platform_user_id) VALUES ('c2', 'telegram', 'user2');
      INSERT INTO social_messages (id, contact_id, direction, content, status, created_at)
        VALUES ('m1', 'c1', 'inbound', 'hi', 'sent', '2026-03-10T10:00:00Z');
      INSERT INTO social_messages (id, contact_id, direction, content, status, created_at)
        VALUES ('m2', 'c2', 'inbound', 'hi', 'sent', '2026-03-10T10:00:00Z');
    `);

    const result = buildTimeSeries(db, "2026-03-01", "2026-03-31", "day", "instagram");
    expect(result).toHaveLength(1);
    expect(result[0].messagesIn).toBe(1);

    const allResult = buildTimeSeries(db, "2026-03-01", "2026-03-31", "day");
    const day10 = allResult.find((r) => r.period === "2026-03-10");
    expect(day10!.messagesIn).toBe(2);
  });
});
