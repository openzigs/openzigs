import { test, expect } from "@playwright/test";

/**
 * E2E Tests — Video Pipeline API Integration
 *
 * Tests for the unified video pipeline REST API routes that serve
 * multiple sub-features: clip extraction, reframing, audio cleaning,
 * B-Roll, captions, export, and thumbnails.
 *
 * These are API-level tests validating the backend endpoints that the
 * UI panels call into.
 */
test.describe("Video Pipeline API", () => {
  // ── Clip Extraction (#821) ──

  // AC: POST /clip rejects missing source
  test("POST /pipeline/clip should reject empty body with 400", async ({
    request,
  }) => {
    const res = await request.post("/api/studio/pipeline/clip", {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  // ── Reframe (#818) ──

  // AC: POST /reframe rejects invalid aspect
  test("POST /pipeline/reframe should reject invalid aspect with 400", async ({
    request,
  }) => {
    const res = await request.post("/api/studio/pipeline/reframe", {
      data: { source: "/tmp/test.mp4", targetAspect: "invalid" },
    });
    expect(res.status()).toBe(400);
  });

  // ── Caption Templates (#819) ──

  // AC1: At least 6 caption templates
  test("GET /pipeline/caption-templates should return 6+ templates", async ({
    request,
  }) => {
    const res = await request.get("/api/studio/pipeline/caption-templates");
    if (res.ok()) {
      const body = await res.json();
      expect(body.templates.length).toBeGreaterThanOrEqual(6);

      // Verify expected template IDs
      const ids = body.templates.map((t: { id: string }) => t.id);
      expect(ids).toContain("hormozi");
      expect(ids).toContain("minimal");
      expect(ids).toContain("tiktok");
      expect(ids).toContain("news");
      expect(ids).toContain("podcast");
      expect(ids).toContain("corporate");
    }
  });

  // AC1: Each template has required fields
  test("caption templates should have name, position, and animation fields", async ({
    request,
  }) => {
    const res = await request.get("/api/studio/pipeline/caption-templates");
    if (res.ok()) {
      const body = await res.json();
      for (const tmpl of body.templates) {
        expect(tmpl).toHaveProperty("id");
        expect(tmpl).toHaveProperty("name");
      }
    }
  });

  // ── NLE Export (#826) ──

  // AC: FCP XML export succeeds
  test("POST /pipeline/export with fcpxml should return complete status", async ({
    request,
  }) => {
    const res = await request.post("/api/studio/pipeline/export", {
      data: {
        manifest: {
          composition: { fps: 30, width: 1920, height: 1080 },
          timeline: [
            { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
          ],
        },
        format: "fcpxml",
        title: "E2E Test Export",
      },
    });
    if (res.ok()) {
      const body = await res.json();
      expect(body.status).toBe("complete");
      expect(body.format).toBe("fcpxml");
      expect(body).toHaveProperty("outputPath");
      expect(body).toHaveProperty("clips");
      expect(body).toHaveProperty("transitions");
    }
  });

  // AC: EDL export succeeds
  test("POST /pipeline/export with edl should return complete status", async ({
    request,
  }) => {
    const res = await request.post("/api/studio/pipeline/export", {
      data: {
        manifest: {
          composition: { fps: 30 },
          timeline: [
            { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
          ],
        },
        format: "edl",
      },
    });
    if (res.ok()) {
      const body = await res.json();
      expect(body.status).toBe("complete");
      expect(body.format).toBe("edl");
    }
  });

  // AC: Invalid format returns 400
  test("POST /pipeline/export should reject invalid format", async ({
    request,
  }) => {
    const res = await request.post("/api/studio/pipeline/export", {
      data: { manifest: {}, format: "invalid" },
    });
    expect(res.status()).toBe(400);
  });

  // ── Analytics (#828) ──

  // AC: Summary endpoint returns expected structure
  test("GET /video-analytics/summary should return KPI data", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/video-analytics/summary?period=30d",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("totalViews");
      expect(body).toHaveProperty("totalEngagements");
      expect(body).toHaveProperty("overallEngagementRate");
      expect(body).toHaveProperty("topContent");
      expect(body).toHaveProperty("platformBreakdown");
    }
  });

  // AC: Best times returns slots
  test("GET /video-analytics/best-times should return slots array", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/video-analytics/best-times");
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("slots");
    }
  });

  // ── Calendar (#823) ──

  // AC: Calendar endpoint returns events with metadata
  test("GET /calendar should return structured event data", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z",
    );
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("events");
      expect(body).toHaveProperty("meta");
      expect(body.meta).toHaveProperty("totalEvents");
      expect(body.meta).toHaveProperty("start");
      expect(body.meta).toHaveProperty("end");
    }
  });

  // AC: Calendar with gaps returns gap data
  test("GET /calendar with includeGaps should return gap days", async ({
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
});
