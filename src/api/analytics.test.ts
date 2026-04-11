import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAnalyticsRouter } from "./analytics.js";

function mockAggregator() {
  return {
    summarize: vi.fn().mockReturnValue({
      totalViews: 5000,
      totalEngagements: 300,
      overallEngagementRate: 6.0,
      topContent: { contentId: "v-1", title: "Top Video", views: 3000 },
      platformBreakdown: [
        { platform: "youtube", totalViews: 3000, contentCount: 2 },
        { platform: "tiktok", totalViews: 2000, contentCount: 1 },
      ],
      dateRange: { start: "2026-04-01", end: "2026-04-30" },
    }),
    computeBestTimes: vi.fn().mockReturnValue([
      { dayOfWeek: 1, hour: 10, avgEngagementRate: 8.5, postCount: 5 },
      { dayOfWeek: 3, hour: 14, avgEngagementRate: 7.2, postCount: 3 },
    ]),
    compare: vi.fn().mockReturnValue({
      a: { contentId: "v-1", views: 3000 },
      b: { contentId: "v-2", views: 2000 },
    }),
  };
}

describe("Analytics API", () => {
  let app: express.Express;
  let agg: ReturnType<typeof mockAggregator>;

  beforeEach(() => {
    app = express();
    agg = mockAggregator();
    app.use("/analytics", createAnalyticsRouter({ aggregator: agg as any }));
  });

  it("GET /summary returns summary", async () => {
    const res = await request(app).get("/analytics/summary").expect(200);
    expect(res.body.totalViews).toBe(5000);
    expect(res.body.platformBreakdown).toHaveLength(2);
    expect(agg.summarize).toHaveBeenCalled();
  });

  it("GET /summary accepts period param", async () => {
    await request(app).get("/analytics/summary?period=30d").expect(200);
    expect(agg.summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        start: expect.any(String),
        end: expect.any(String),
      }),
    );
  });

  it("GET /best-times returns slots", async () => {
    const res = await request(app).get("/analytics/best-times").expect(200);
    expect(res.body.slots).toHaveLength(2);
    expect(res.body.slots[0].dayOfWeek).toBe(1);
  });

  it("GET /compare returns comparison", async () => {
    const res = await request(app)
      .get(
        "/analytics/compare?id1=v-1&platform1=youtube&id2=v-2&platform2=tiktok",
      )
      .expect(200);
    expect(res.body.a.contentId).toBe("v-1");
    expect(res.body.b.contentId).toBe("v-2");
    expect(agg.compare).toHaveBeenCalledWith("v-1", "youtube", "v-2", "tiktok");
  });

  it("GET /compare returns 400 for missing params", async () => {
    await request(app).get("/analytics/compare?id1=v-1").expect(400);
  });
});
