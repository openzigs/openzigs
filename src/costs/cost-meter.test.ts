import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { CostMeter } from "./cost-meter.js";
import { BUNDLED_PRICING } from "./copilot-pricing.js";
import { AuditLogger } from "../logging/audit-logger.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const newDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

const fixedClock = () => () => new Date("2026-05-08T10:30:00Z");

describe("CostMeter", () => {
  let db: ReturnType<typeof newDb>;
  beforeEach(() => {
    db = newDb();
  });

  it("creates the session_costs table on construction", () => {
    new CostMeter({ db, pricing: BUNDLED_PRICING, clock: fixedClock() });
    const cols = db
      .prepare("PRAGMA table_info(session_costs)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("session_id");
    expect(names).toContain("call_id");
    expect(names).toContain("would_have_cost");
    expect(names).toContain("pricing_source");
  });

  it("records a cloud call with actualCost === wouldHaveCost", () => {
    const meter = new CostMeter({ db, pricing: BUNDLED_PRICING, clock: fixedClock() });
    const row = meter.record({
      sessionId: "sess-1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 1_000_000,
      outputTokens: 0,
      callId: "call-1",
    });
    expect(row.actualCost).toBe(2);
    expect(row.wouldHaveCost).toBe(2);
    expect(row.pricingSource).toBe("bundled");
    expect(row.pricingVersion).toBe(BUNDLED_PRICING.version);
  });

  it("records a local-copilot call with actualCost = 0 and wouldHaveCost > 0", () => {
    const meter = new CostMeter({ db, pricing: BUNDLED_PRICING, clock: fixedClock() });
    const row = meter.record({
      sessionId: "sess-1",
      modelId: "gemma4:26b",
      cloudEquivalentModelId: "gpt-4.1",
      providerKind: "local-copilot",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      callId: "call-2",
    });
    expect(row.actualCost).toBe(0);
    expect(row.wouldHaveCost).toBe(6);
  });

  it("uses fallback pricing when local model id has no cloud equivalent", () => {
    const meter = new CostMeter({ db, pricing: BUNDLED_PRICING, clock: fixedClock() });
    const row = meter.record({
      sessionId: "sess-1",
      modelId: "gemma4:31b",
      providerKind: "local-copilot",
      inputTokens: 1_000_000,
      outputTokens: 0,
      callId: "call-3",
    });
    // Fallback: $2/M input → $2 wouldHaveCost
    expect(row.wouldHaveCost).toBeCloseTo(2, 6);
  });

  it("aggregates per-session totals", () => {
    const meter = new CostMeter({ db, pricing: BUNDLED_PRICING, clock: fixedClock() });
    meter.record({
      sessionId: "sess-1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 500_000,
      outputTokens: 100_000,
      callId: "c1",
    });
    meter.record({
      sessionId: "sess-1",
      modelId: "gemma4:26b",
      cloudEquivalentModelId: "gpt-4.1",
      providerKind: "local-copilot",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      callId: "c2",
    });

    const agg = meter.aggregate("sess-1");
    expect(agg.callCount).toBe(2);
    expect(agg.totalInputTokens).toBe(1_500_000);
    expect(agg.totalOutputTokens).toBe(600_000);
    // cloud cost: 500k @ $2/M + 100k @ $8/M = 1 + 0.8 = $1.8
    expect(agg.totalActualCost).toBeCloseTo(1.8, 6);
    // wouldHave: cloud $1.8 + local-equivalent $6 = $7.8
    expect(agg.totalWouldHaveCost).toBeCloseTo(7.8, 6);
    // saved = 7.8 - 1.8 = $6
    expect(agg.savedByLocal).toBeCloseTo(6, 6);
    expect(agg.lastCallAt).toBe("2026-05-08T10:30:00.000Z");
  });

  it("returns zero aggregate for an unknown session", () => {
    const meter = new CostMeter({ db, pricing: BUNDLED_PRICING, clock: fixedClock() });
    const agg = meter.aggregate("never-touched");
    expect(agg.callCount).toBe(0);
    expect(agg.totalActualCost).toBe(0);
    expect(agg.savedByLocal).toBe(0);
    expect(agg.lastCallAt).toBeNull();
  });

  it("is idempotent on (sessionId, callId) — re-recording replaces", () => {
    const meter = new CostMeter({ db, pricing: BUNDLED_PRICING, clock: fixedClock() });
    meter.record({
      sessionId: "sess-1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 100_000,
      outputTokens: 0,
      callId: "dup",
    });
    meter.record({
      sessionId: "sess-1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 200_000,
      outputTokens: 0,
      callId: "dup",
    });
    const agg = meter.aggregate("sess-1");
    expect(agg.callCount).toBe(1);
    expect(agg.totalInputTokens).toBe(200_000);
  });

  it("emits an audit log entry per recorded call when an audit logger is provided", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cost-meter-audit-"));
    const auditLogger = new AuditLogger({ baseDir: dir, clock: fixedClock() });
    const spy = vi.spyOn(auditLogger, "log");
    const meter = new CostMeter({ db, pricing: BUNDLED_PRICING, auditLogger, clock: fixedClock() });
    meter.record({
      sessionId: "sess-1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 1000,
      outputTokens: 0,
      callId: "call-x",
    });
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = spy.mock.calls[0][0];
    expect(entry.category).toBe("system");
    expect(entry.event).toBe("cost.recorded");
    expect((entry.details as Record<string, unknown>).providerKind).toBe("cloud");
    expect((entry.details as Record<string, unknown>).pricingSource).toBe("bundled");
  });

  it("listing per-session calls returns oldest first", () => {
    const meter = new CostMeter({
      db,
      pricing: BUNDLED_PRICING,
      clock: () => new Date("2026-05-08T10:00:00Z"),
    });
    meter.record({
      sessionId: "sess-1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 100,
      outputTokens: 0,
      callId: "first",
      occurredAt: new Date("2026-05-08T10:00:00Z"),
    });
    meter.record({
      sessionId: "sess-1",
      modelId: "gpt-4.1",
      providerKind: "cloud",
      inputTokens: 100,
      outputTokens: 0,
      callId: "second",
      occurredAt: new Date("2026-05-08T11:00:00Z"),
    });
    const calls = meter.callsForSession("sess-1");
    expect(calls.map((c) => c.callId)).toEqual(["first", "second"]);
  });
});
