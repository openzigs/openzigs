import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  createCalendarRouter,
  outboxToEvent,
  schedulerToEvent,
  detectGaps,
} from "./calendar.js";

// ── Mocks ──────────────────────────────────────────────────

function mockOutboxRepo(items: unknown[] = []) {
  return { list: vi.fn().mockReturnValue(items) } as any;
}

function mockScheduler(jobs: unknown[] = []) {
  return { list: vi.fn().mockReturnValue(jobs) } as any;
}

function makeOutboxItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "ox-1",
    title: "Test Post",
    contentBody: "Hello world",
    platform: "youtube",
    scheduledTime: new Date("2026-04-10T10:00:00Z"),
    status: "pending",
    agentContext: "agent ctx",
    publishedUrl: null,
    assetUrl: null,
    ...overrides,
  };
}

function makeSchedulerJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "sj-1",
    name: "Daily Digest",
    cronExpression: "0 9 * * *",
    actionType: "prompt",
    enabled: true,
    lastRunAt: new Date("2026-04-09T09:00:00Z"),
    nextRunAt: null,
    ...overrides,
  };
}

// ── Unit tests ─────────────────────────────────────────────

describe("Calendar API", () => {
  describe("outboxToEvent", () => {
    it("converts an outbox item to a calendar event", () => {
      const item = makeOutboxItem();
      const ev = outboxToEvent(item as any);
      expect(ev.id).toBe("outbox-ox-1");
      expect(ev.source).toBe("outbox");
      expect(ev.platform).toBe("youtube");
      expect(ev.color).toBe("#FF0000"); // YouTube red
      expect(ev.editable).toBe(true);
    });

    it("marks published items as non-editable", () => {
      const item = makeOutboxItem({ status: "published" });
      const ev = outboxToEvent(item as any);
      expect(ev.editable).toBe(false);
    });
  });

  describe("schedulerToEvent", () => {
    it("converts a scheduled job to a calendar event", () => {
      const job = makeSchedulerJob();
      const ev = schedulerToEvent(job as any);
      expect(ev.id).toBe("sched-sj-1");
      expect(ev.source).toBe("scheduler");
      expect(ev.title).toContain("Daily Digest");
    });
  });

  describe("detectGaps", () => {
    it("finds days with no events", () => {
      const events = [
        { start: "2026-04-01T10:00:00Z" },
        { start: "2026-04-03T10:00:00Z" },
      ] as any[];
      const gaps = detectGaps(
        events,
        new Date("2026-04-01"),
        new Date("2026-04-04"),
      );
      const gapDates = gaps.map((g) => g.date);
      expect(gapDates).toContain("2026-04-02");
      expect(gapDates).toContain("2026-04-04");
      expect(gapDates).not.toContain("2026-04-01");
      expect(gapDates).not.toContain("2026-04-03");
    });

    it("returns empty array when no gaps", () => {
      const events = [
        { start: "2026-04-01T10:00:00Z" },
        { start: "2026-04-02T10:00:00Z" },
      ] as any[];
      const gaps = detectGaps(
        events,
        new Date("2026-04-01"),
        new Date("2026-04-02"),
      );
      expect(gaps).toHaveLength(0);
    });
  });

  describe("GET /calendar", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      const outbox = mockOutboxRepo([
        makeOutboxItem({ scheduledTime: new Date("2026-04-10T10:00:00Z") }),
        makeOutboxItem({
          id: "ox-2",
          title: "IG Post",
          platform: "instagram",
          scheduledTime: new Date("2026-04-12T14:00:00Z"),
        }),
      ]);
      const sched = mockScheduler([makeSchedulerJob()]);
      app.use(
        "/calendar",
        createCalendarRouter({ outboxRepo: outbox, scheduler: sched }),
      );
    });

    it("returns calendar events", async () => {
      const res = await request(app)
        .get("/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z")
        .expect(200);
      expect(res.body.events.length).toBeGreaterThan(0);
      expect(res.body.meta.totalEvents).toBeGreaterThan(0);
    });

    it("filters by platform", async () => {
      const res = await request(app)
        .get(
          "/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z&platforms=instagram",
        )
        .expect(200);
      const outboxEvents = res.body.events.filter(
        (e: any) => e.source === "outbox",
      );
      expect(outboxEvents.every((e: any) => e.platform === "instagram")).toBe(
        true,
      );
    });

    it("includes gap days when requested", async () => {
      const res = await request(app)
        .get(
          "/calendar?start=2026-04-10T00:00:00Z&end=2026-04-12T23:59:59Z&includeGaps=true",
        )
        .expect(200);
      expect(res.body.gaps.length).toBeGreaterThan(0);
      expect(res.body.meta.totalGaps).toBeGreaterThan(0);
    });

    it("returns empty gaps array when not requested", async () => {
      const res = await request(app)
        .get("/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z")
        .expect(200);
      expect(res.body.gaps).toEqual([]);
    });
  });
});
