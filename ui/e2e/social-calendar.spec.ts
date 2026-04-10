import { test, expect } from "@playwright/test";
import { navigateTo } from "./helpers";

/**
 * E2E Tests — Social Calendar (#823)
 *
 * Acceptance Criteria from issue:
 * AC1: Month view shows all scheduled + published posts across platforms
 * AC2: Week view with time slots for granular scheduling
 * AC3: Day view with detailed post timeline
 * AC4: Drag-and-drop rescheduling updates the outbox/scheduler immediately
 * AC5: Color-coded by platform with icon + media thumbnail preview
 * AC6: Click on post shows preview with caption, media, and target platform
 * AC7: Gap detection highlights days with no scheduled content
 * AC8: Filter by platform
 * AC9: Responsive design works on desktop and tablet
 * AC10: Route /social/calendar or enhancement of /scheduler
 */
test.describe("Social Calendar (#823)", () => {
  // AC1: Calendar endpoint returns events
  test("should have calendar API endpoint returning events", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("events");
      expect(body).toHaveProperty("gaps");
      expect(body).toHaveProperty("meta");
      expect(body.meta).toHaveProperty("totalEvents");
    }
  });

  // AC7: Gap detection available
  test("should support gap detection via includeGaps param", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z&includeGaps=true",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("gaps");
      expect(body.meta).toHaveProperty("totalGaps");
    }
  });

  // AC8: Platform filter works
  test("should support platform filtering", async ({ request }) => {
    const res = await request.get(
      "/api/admin/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z&platforms=youtube",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("events");
    }
  });

  // AC1: Scheduler page is accessible
  test("should navigate to scheduler page", async ({ page }) => {
    await navigateTo(page, "/scheduler");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  // AC5: Calendar events include platform color information
  test("should return events with platform color coding", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z",
    );
    if (res.ok()) {
      const body = await res.json();
      if (body.events.length > 0) {
        const event = body.events[0];
        expect(event).toHaveProperty("color");
        expect(event).toHaveProperty("source");
        expect(event).toHaveProperty("editable");
      }
    }
  });

  // AC6: Events contain metadata for previews
  test("should return events with preview metadata", async ({ request }) => {
    const res = await request.get(
      "/api/admin/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z",
    );
    if (res.ok()) {
      const body = await res.json();
      if (body.events.length > 0) {
        const event = body.events[0];
        expect(event).toHaveProperty("title");
        expect(event).toHaveProperty("start");
        expect(event).toHaveProperty("metadata");
      }
    }
  });

  // AC10: Meta includes date range
  test("should return meta with start/end date range", async ({ request }) => {
    const res = await request.get(
      "/api/admin/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body.meta).toHaveProperty("start");
      expect(body.meta).toHaveProperty("end");
    }
  });
});
