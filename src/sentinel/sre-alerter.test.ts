import { describe, expect, it, vi } from "vitest";
import { SREAlerter, type SentinelAlert } from "./sre-alerter.js";

const makeAlert = (overrides: Partial<SentinelAlert> = {}): SentinelAlert => ({
  type: overrides.type ?? "consecutive-failures",
  priority: overrides.priority ?? "warning",
  message: overrides.message ?? "Test alert",
  data: overrides.data ?? {},
  timestamp: overrides.timestamp ?? new Date("2026-06-15T12:00:00Z").toISOString(),
});

describe("SREAlerter", () => {
  it("fires alerts via Socket.IO", async () => {
    const io = { emit: vi.fn() };
    const alerter = new SREAlerter({ io });

    const alert = makeAlert({ type: "queue-depth", priority: "warning" });
    const fired = await alerter.fireAlerts([alert]);

    expect(fired).toBe(1);
    expect(io.emit).toHaveBeenCalledWith("sentinel:alert", alert);
  });

  it("deduplicates alerts by type within cooldown window", async () => {
    let now = new Date("2026-06-15T12:00:00Z");
    const io = { emit: vi.fn() };
    const alerter = new SREAlerter({ io, clock: () => now });

    const alert = makeAlert({ type: "queue-depth", priority: "warning" });

    // First fire succeeds
    const first = await alerter.fireAlerts([alert]);
    expect(first).toBe(1);

    // Second fire within cooldown should be suppressed
    now = new Date("2026-06-15T12:01:00Z"); // 1 minute later (warning cooldown = 30 min)
    const second = await alerter.fireAlerts([alert]);
    expect(second).toBe(0);
    expect(io.emit).toHaveBeenCalledTimes(1);
  });

  it("critical alerts have shorter cooldown (5 min)", async () => {
    let now = new Date("2026-06-15T12:00:00Z");
    const io = { emit: vi.fn() };
    const alerter = new SREAlerter({ io, clock: () => now });

    const alert = makeAlert({ type: "consecutive-failures", priority: "critical" });

    await alerter.fireAlerts([alert]);

    // 6 minutes later — should be past the 5-min cooldown
    now = new Date("2026-06-15T12:06:00Z");
    const fired = await alerter.fireAlerts([alert]);
    expect(fired).toBe(1);
    expect(io.emit).toHaveBeenCalledTimes(2);
  });

  it("warning alerts have 30-minute cooldown", async () => {
    let now = new Date("2026-06-15T12:00:00Z");
    const io = { emit: vi.fn() };
    const alerter = new SREAlerter({ io, clock: () => now });

    const alert = makeAlert({ type: "queue-depth", priority: "warning" });

    await alerter.fireAlerts([alert]);

    // 25 minutes later — still within 30-min cooldown
    now = new Date("2026-06-15T12:25:00Z");
    const suppressed = await alerter.fireAlerts([alert]);
    expect(suppressed).toBe(0);

    // 31 minutes later — past cooldown
    now = new Date("2026-06-15T12:31:00Z");
    const fired = await alerter.fireAlerts([alert]);
    expect(fired).toBe(1);
  });

  it("different alert types have independent cooldowns", async () => {
    const io = { emit: vi.fn() };
    const alerter = new SREAlerter({ io });

    const alert1 = makeAlert({ type: "queue-depth" });
    const alert2 = makeAlert({ type: "orphaned-task" });

    await alerter.fireAlerts([alert1, alert2]);
    expect(io.emit).toHaveBeenCalledTimes(2);
  });

  it("clearCooldowns resets all cooldowns", async () => {
    const io = { emit: vi.fn() };
    const alerter = new SREAlerter({ io });

    const alert = makeAlert({ type: "queue-depth", priority: "warning" });

    await alerter.fireAlerts([alert]);
    alerter.clearCooldowns();

    const fired = await alerter.fireAlerts([alert]);
    expect(fired).toBe(1);
    expect(io.emit).toHaveBeenCalledTimes(2);
  });

  it("works without Socket.IO (no io provided)", async () => {
    const alerter = new SREAlerter({});
    const alert = makeAlert();

    const fired = await alerter.fireAlerts([alert]);
    expect(fired).toBe(1); // Still counts as fired, just no emission
  });

  it("setIO replaces the Socket.IO instance", async () => {
    const alerter = new SREAlerter({});
    const io = { emit: vi.fn() };

    alerter.setIO(io);
    const alert = makeAlert();
    await alerter.fireAlerts([alert]);

    expect(io.emit).toHaveBeenCalledWith("sentinel:alert", alert);
  });
});
