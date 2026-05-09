import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";

import { createSessionCostsRouter } from "./session-costs.js";
import { CostMeter } from "../costs/cost-meter.js";
import { BUNDLED_PRICING } from "../costs/copilot-pricing.js";

const newApp = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const meter = new CostMeter({ db, pricing: BUNDLED_PRICING });
  const app = express();
  app.use("/api/admin", createSessionCostsRouter({ costMeter: meter }));
  return { app, meter };
};

describe("session-costs router", () => {
  it("GET /sessions/:id/cost returns the aggregate + per-call rows", async () => {
    const { app, meter } = newApp();
    meter.record({
      sessionId: "s1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 1_000_000,
      outputTokens: 0,
      callId: "c1",
    });
    meter.record({
      sessionId: "s1",
      modelId: "gemma4:26b",
      cloudEquivalentModelId: "gpt-4.1",
      providerKind: "local-copilot",
      inputTokens: 1_000_000,
      outputTokens: 0,
      callId: "c2",
    });
    const res = await request(app).get("/api/admin/sessions/s1/cost");
    expect(res.status).toBe(200);
    expect(res.body.aggregate.callCount).toBe(2);
    expect(res.body.aggregate.totalActualCost).toBe(2);
    expect(res.body.aggregate.totalWouldHaveCost).toBe(4);
    expect(res.body.aggregate.savedByLocal).toBe(2);
    expect(res.body.calls).toHaveLength(2);
  });

  it("returns zero aggregate for an unknown session", async () => {
    const { app } = newApp();
    const res = await request(app).get("/api/admin/sessions/never/cost");
    expect(res.status).toBe(200);
    expect(res.body.aggregate.callCount).toBe(0);
    expect(res.body.aggregate.savedByLocal).toBe(0);
    expect(res.body.calls).toEqual([]);
  });

  it("rejects empty session id", async () => {
    const { app } = newApp();
    const res = await request(app).get("/api/admin/sessions/ /cost");
    expect(res.status).toBe(400);
  });

  it("rejects suspiciously long session id", async () => {
    const { app } = newApp();
    const longId = "a".repeat(300);
    const res = await request(app).get(`/api/admin/sessions/${longId}/cost`);
    expect(res.status).toBe(400);
  });

  it("GET /sessions/cost-summary returns cross-session totals", async () => {
    const { app, meter } = newApp();
    meter.record({
      sessionId: "s1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 1_000_000,
      outputTokens: 0,
      callId: "c1",
    });
    meter.record({
      sessionId: "s2",
      modelId: "gemma4:26b",
      cloudEquivalentModelId: "gpt-4.1",
      providerKind: "local-copilot",
      inputTokens: 1_000_000,
      outputTokens: 0,
      callId: "c2",
    });
    const res = await request(app).get("/api/admin/sessions/cost-summary");
    expect(res.status).toBe(200);
    expect(res.body.summary.callCount).toBe(2);
    expect(res.body.summary.sessionCount).toBe(2);
    expect(res.body.summary.totalActualCost).toBe(2);
    expect(res.body.summary.totalWouldHaveCost).toBe(4);
    expect(res.body.summary.savedByLocal).toBe(2);
  });

  it("GET /sessions/cost-summary returns zeroed totals for empty meter", async () => {
    const { app } = newApp();
    const res = await request(app).get("/api/admin/sessions/cost-summary");
    expect(res.status).toBe(200);
    expect(res.body.summary.callCount).toBe(0);
    expect(res.body.summary.sessionCount).toBe(0);
    expect(res.body.summary.savedByLocal).toBe(0);
    expect(res.body.summary.lastCallAt).toBeNull();
  });
});
