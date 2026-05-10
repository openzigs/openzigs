/**
 * Bug #1064-#6a regression guard.
 *
 * The bug: `adminRouter` declares `/sessions/:id` and was mounted at
 * `/api/admin` BEFORE `sessionCostsRouter`. Express therefore matched
 * `/api/admin/sessions/cost-summary` against `/sessions/:id` with
 * `id="cost-summary"`, hit `sessionManager.getSession("cost-summary")`,
 * and returned 404 `{"error":"Session not found: cost-summary"}` —
 * making the dedicated cost-summary route unreachable.
 *
 * This test composes Express the way `src/server.ts` does it
 * (`createSessionCostsRouter` mounted first, a stub admin router with
 * `/sessions/:id` mounted second) and asserts that
 * `GET /api/admin/sessions/cost-summary` returns 200 with the
 * summary shape — i.e. the stub admin router never sees it.
 *
 * If the mount order is reverted, this test fails with the same 404
 * the user experienced in production.
 */

import { describe, it, expect } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import Database from "better-sqlite3";

import { createSessionCostsRouter } from "./session-costs.js";
import { CostMeter } from "../costs/cost-meter.js";
import { BUNDLED_PRICING } from "../costs/copilot-pricing.js";

const buildApp = (mountOrder: "fixed" | "broken") => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const meter = new CostMeter({ db, pricing: BUNDLED_PRICING });

  // Stub of the real adminRouter — only the conflicting `/sessions/:id`
  // route is needed to reproduce the bug.
  const adminRouterStub: Router = Router();
  adminRouterStub.get("/sessions/:id", (req, res) => {
    res.status(404).json({ error: `Session not found: ${req.params.id}` });
  });

  const app = express();
  if (mountOrder === "fixed") {
    app.use("/api/admin", createSessionCostsRouter({ costMeter: meter }));
    app.use("/api/admin", adminRouterStub);
  } else {
    app.use("/api/admin", adminRouterStub);
    app.use("/api/admin", createSessionCostsRouter({ costMeter: meter }));
  }
  return { app, meter };
};

describe("admin route mount order — cost-summary regression (bug #1064-#6a)", () => {
  it("FIXED order: GET /api/admin/sessions/cost-summary returns 200 with summary shape", async () => {
    const { app } = buildApp("fixed");
    const res = await request(app).get("/api/admin/sessions/cost-summary");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("summary");
    expect(res.body.summary).toMatchObject({
      callCount: 0,
      sessionCount: 0,
      totalActualCost: 0,
      totalWouldHaveCost: 0,
      savedByLocal: 0,
    });
  });

  it("FIXED order: legitimate /sessions/:id requests still fall through to adminRouter", async () => {
    const { app } = buildApp("fixed");
    const res = await request(app).get("/api/admin/sessions/some-real-session");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Session not found: some-real-session" });
  });

  it("BROKEN order (control): cost-summary is swallowed by /sessions/:id and 404s", async () => {
    // This control assertion documents the original failure mode so a
    // future refactor that flips mount order trips this test instead of
    // shipping a regression to production.
    const { app } = buildApp("broken");
    const res = await request(app).get("/api/admin/sessions/cost-summary");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Session not found: cost-summary" });
  });
});
