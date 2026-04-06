/**
 * Calendar Aggregation API — #823
 *
 * Unifies outbox queue + scheduled jobs + publish history into a single
 * calendar event feed. Supports date-range filtering, platform scoping,
 * and gap detection for empty days.
 */
import { Router } from "express";
import { z } from "zod";
import type {
  OutboxRepository,
  OutboxItem,
} from "../outbox/outbox-repository.js";
import type { Scheduler, ScheduledJob } from "../productivity/scheduler.js";

// ── Types ──────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO-8601
  end?: string; // ISO-8601 (optional for point-in-time events)
  source: "outbox" | "scheduler";
  platform?: string;
  status?: string;
  color: string;
  editable: boolean;
  metadata: Record<string, unknown>;
}

export interface CalendarGap {
  date: string; // YYYY-MM-DD
  dayOfWeek: number; // 0=Sun…6=Sat
}

const PLATFORM_COLORS: Record<string, string> = {
  youtube: "#FF0000",
  tiktok: "#000000",
  instagram: "#E1306C",
  twitter: "#1DA1F2",
  linkedin: "#0A66C2",
  pinterest: "#E60023",
  reddit: "#FF4500",
  facebook: "#1877F2",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#3b82f6",
  processing: "#eab308",
  published: "#22c55e",
  failed: "#ef4444",
  canceled: "#6b7280",
};

// ── Helpers ────────────────────────────────────────────────────

function outboxToEvent(item: OutboxItem): CalendarEvent {
  const statusColor = STATUS_COLORS[item.status] ?? "#6b7280";
  const platformColor = PLATFORM_COLORS[item.platform] ?? statusColor;
  return {
    id: `outbox-${item.id}`,
    title:
      item.title ??
      item.contentBody?.slice(0, 60) ??
      item.agentContext.slice(0, 60),
    start:
      item.scheduledTime instanceof Date
        ? item.scheduledTime.toISOString()
        : String(item.scheduledTime),
    source: "outbox",
    platform: item.platform,
    status: item.status,
    color: platformColor,
    editable: item.status === "pending",
    metadata: {
      outboxId: item.id,
      publishedUrl: item.publishedUrl,
      contentBody: item.contentBody,
      assetUrl: item.assetUrl,
    },
  };
}

function schedulerToEvent(job: ScheduledJob): CalendarEvent {
  const start = job.nextRunAt
    ? job.nextRunAt.toISOString()
    : job.lastRunAt
      ? job.lastRunAt.toISOString()
      : new Date().toISOString();
  return {
    id: `sched-${job.id}`,
    title: `⏰ ${job.name}`,
    start,
    source: "scheduler",
    color: "#8b5cf6", // purple for scheduler
    editable: false,
    metadata: {
      jobId: job.id,
      cron: job.cronExpression,
      actionType: job.actionType,
      enabled: job.enabled,
    },
  };
}

function detectGaps(
  events: CalendarEvent[],
  start: Date,
  end: Date,
): CalendarGap[] {
  const covered = new Set<string>();
  for (const ev of events) {
    const d = ev.start.slice(0, 10);
    covered.add(d);
  }

  const gaps: CalendarGap[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setUTCHours(0, 0, 0, 0);

  while (cursor <= endDay) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (!covered.has(dateStr)) {
      gaps.push({ date: dateStr, dayOfWeek: cursor.getUTCDay() });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return gaps;
}

// ── Query schema ───────────────────────────────────────────────

const calendarQuerySchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  platforms: z.string().optional(),
  includeGaps: z.enum(["true", "false"]).optional(),
});

// ── Router factory ─────────────────────────────────────────────

export interface CalendarRouterOptions {
  outboxRepo: OutboxRepository;
  scheduler: Scheduler;
}

export function createCalendarRouter({
  outboxRepo,
  scheduler,
}: CalendarRouterOptions): Router {
  const router = Router();

  /**
   * GET /calendar
   * - ?start=ISO&end=ISO — date range (defaults to current month)
   * - ?platforms=youtube,twitter — comma-separated filter
   * - ?includeGaps=true — also return gap days
   */
  router.get("/", (req, res) => {
    const parsed = calendarQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const now = new Date();
    const start = parsed.data.start
      ? new Date(parsed.data.start)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = parsed.data.end
      ? new Date(parsed.data.end)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const platformFilter = parsed.data.platforms
      ? parsed.data.platforms.split(",").map((p) => p.trim().toLowerCase())
      : null;

    // ── Outbox items ──
    const outboxItems = outboxRepo.list({ limit: 500 });
    const filtered = outboxItems.filter((item) => {
      const t =
        item.scheduledTime instanceof Date
          ? item.scheduledTime
          : new Date(String(item.scheduledTime));
      if (t < start || t > end) return false;
      if (platformFilter && !platformFilter.includes(item.platform))
        return false;
      return true;
    });
    const outboxEvents = filtered.map(outboxToEvent);

    // ── Scheduled jobs ──
    const jobs = scheduler.list();
    const schedulerEvents = jobs.filter((j) => j.enabled).map(schedulerToEvent);

    const allEvents = [...outboxEvents, ...schedulerEvents];

    // ── Gap detection ──
    const includeGaps = parsed.data.includeGaps === "true";
    const gaps = includeGaps ? detectGaps(allEvents, start, end) : [];

    res.json({
      events: allEvents,
      gaps,
      meta: {
        start: start.toISOString(),
        end: end.toISOString(),
        totalEvents: allEvents.length,
        totalGaps: gaps.length,
      },
    });
  });

  return router;
}

// Export helpers for testing
export {
  outboxToEvent,
  schedulerToEvent,
  detectGaps,
  PLATFORM_COLORS,
  STATUS_COLORS,
};
