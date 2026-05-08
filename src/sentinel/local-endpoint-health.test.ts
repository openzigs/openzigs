import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { LocalEndpointHealthMonitor } from "./local-endpoint-health.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tmpStatePath: string;

const auditLogs: Array<{ event: string; category: string; level: string; details: Record<string, unknown> }> = [];
const auditLogger = {
  log: vi.fn(async (entry) => {
    auditLogs.push({
      event: entry.event,
      category: entry.category,
      level: entry.level,
      details: entry.details ?? {},
    });
    return entry;
  }),
};

const t0 = new Date("2026-02-09T12:00:00Z").getTime();

const buildMonitor = (overrides: Partial<ConstructorParameters<typeof LocalEndpointHealthMonitor>[0]> = {}) => {
  let now = t0;
  const monitor = new LocalEndpointHealthMonitor({
    endpoint: "http://127.0.0.1:11434/v1",
    statePath: tmpStatePath,
    fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    auditLogger: auditLogger as unknown as ConstructorParameters<typeof LocalEndpointHealthMonitor>[0]["auditLogger"],
    clock: () => new Date(now),
    intervalMs: 30000,
    failoverThreshold: 3,
    failoverWindowMs: 60000,
    failbackSuccesses: 5,
    ...overrides,
  });
  return {
    monitor,
    advance(ms: number) {
      now += ms;
    },
  };
};

describe("LocalEndpointHealthMonitor — state machine", () => {
  beforeEach(async () => {
    auditLogs.length = 0;
    auditLogger.log.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-leh-"));
    tmpStatePath = path.join(dir, "local-endpoint-health.json");
  });

  it("starts in healthy state with zero counters", () => {
    const { monitor } = buildMonitor();
    const s = monitor.getState();
    expect(s.status).toBe("healthy");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.consecutiveSuccesses).toBe(0);
    expect(s.failoverActive).toBe(false);
  });

  it("3 failures inside 60s window trips failover (status=failed-over)", () => {
    const { monitor, advance } = buildMonitor();
    monitor.evaluate(false);
    advance(20000);
    monitor.evaluate(false);
    advance(20000);
    monitor.evaluate(false);
    const s = monitor.getState();
    expect(s.failoverActive).toBe(true);
    expect(s.status).toBe("failed-over");
    expect(auditLogs.find((l) => l.event === "sentinel.failover")).toBeDefined();
  });

  it("failures spread over >60s do NOT trip failover (sliding window)", () => {
    const { monitor, advance } = buildMonitor();
    monitor.evaluate(false);
    advance(40000);
    monitor.evaluate(false);
    advance(40000); // first failure now outside the 60s window
    monitor.evaluate(false);
    const s = monitor.getState();
    expect(s.failoverActive).toBe(false);
    expect(s.status).toBe("degraded");
  });

  it("a single success between failures resets the failure counter", () => {
    const { monitor, advance } = buildMonitor();
    monitor.evaluate(false);
    advance(5000);
    monitor.evaluate(false);
    advance(5000);
    monitor.evaluate(true);
    advance(5000);
    monitor.evaluate(false);
    advance(5000);
    monitor.evaluate(false);
    expect(monitor.getState().failoverActive).toBe(false);
  });

  it("5 consecutive successes after failover restores healthy", () => {
    const { monitor } = buildMonitor();
    monitor.evaluate(false);
    monitor.evaluate(false);
    monitor.evaluate(false);
    expect(monitor.getState().failoverActive).toBe(true);
    for (let i = 0; i < 4; i += 1) monitor.evaluate(true);
    expect(monitor.getState().failoverActive).toBe(true);
    monitor.evaluate(true);
    const s = monitor.getState();
    expect(s.failoverActive).toBe(false);
    expect(s.status).toBe("healthy");
    expect(auditLogs.find((l) => l.event === "sentinel.failback")).toBeDefined();
  });

  it("emits 'failover' and 'failback' EventEmitter events", () => {
    const { monitor } = buildMonitor();
    const failoverFn = vi.fn();
    const failbackFn = vi.fn();
    monitor.on("failover", failoverFn);
    monitor.on("failback", failbackFn);

    monitor.evaluate(false);
    monitor.evaluate(false);
    monitor.evaluate(false);
    expect(failoverFn).toHaveBeenCalledTimes(1);
    expect(failoverFn.mock.calls[0][0]).toMatchObject({ failuresInWindow: 3 });

    for (let i = 0; i < 5; i += 1) monitor.evaluate(true);
    expect(failbackFn).toHaveBeenCalledTimes(1);
  });
});

describe("LocalEndpointHealthMonitor — privacy + assertAvailable", () => {
  beforeEach(async () => {
    auditLogs.length = 0;
    auditLogger.log.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-leh-"));
    tmpStatePath = path.join(dir, "local-endpoint-health.json");
  });

  it("assertAvailable() throws LOCAL_ENDPOINT_UNAVAILABLE_PRIVACY_MODE when privacy locked", () => {
    const { monitor } = buildMonitor({ isPrivacyLocked: () => true });
    expect(() => monitor.assertAvailable()).toThrow(/PRIVACY_MODE/);
    try {
      monitor.assertAvailable();
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe(
        "LOCAL_ENDPOINT_UNAVAILABLE_PRIVACY_MODE",
      );
    }
  });

  it("privacy block emits audit log with category=security", () => {
    const { monitor } = buildMonitor({ isPrivacyLocked: () => true });
    expect(() => monitor.assertAvailable()).toThrow();
    // Audit fire-and-forget — give the microtask queue a chance to flush.
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(
          auditLogs.find(
            (l) =>
              l.event === "sentinel.privacy_mode_block" &&
              l.category === "security",
          ),
        ).toBeDefined();
        resolve();
      });
    });
  });

  it("assertAvailable() throws LOCAL_ENDPOINT_UNAVAILABLE during failover", () => {
    const { monitor } = buildMonitor();
    monitor.evaluate(false);
    monitor.evaluate(false);
    monitor.evaluate(false);
    expect(() => monitor.assertAvailable()).toThrow(/UNAVAILABLE/);
  });

  it("assertAvailable() returns silently when healthy and not privacy-locked", () => {
    const { monitor } = buildMonitor();
    expect(() => monitor.assertAvailable()).not.toThrow();
  });

  it("privacy lock takes precedence over healthy status", () => {
    let locked = false;
    const { monitor } = buildMonitor({ isPrivacyLocked: () => locked });
    expect(() => monitor.assertAvailable()).not.toThrow();
    locked = true;
    expect(() => monitor.assertAvailable()).toThrow(/PRIVACY_MODE/);
  });
});

describe("LocalEndpointHealthMonitor — probe + persist", () => {
  beforeEach(async () => {
    auditLogs.length = 0;
    auditLogger.log.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-leh-"));
    tmpStatePath = path.join(dir, "local-endpoint-health.json");
  });

  it("probeOnce() calls fetch with /models suffix and bearer header when apiKey set", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    const { monitor } = buildMonitor({
      apiKey: "the-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await monitor.probeOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toBe("http://127.0.0.1:11434/v1/models");
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toBe("Bearer the-key");
  });

  it("probeOnce() treats non-2xx as failure", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);
    const { monitor } = buildMonitor({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await monitor.probeOnce();
    expect(monitor.getState().consecutiveFailures).toBe(1);
  });

  it("probeOnce() persists state to the configured statePath", async () => {
    const { monitor } = buildMonitor();
    await monitor.probeOnce();
    const raw = await fs.readFile(tmpStatePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.lastProbeAt).toMatch(/^2026-02-09T12:00:00/);
  });

  it("start()/stop() are idempotent", () => {
    const { monitor } = buildMonitor();
    monitor.start();
    monitor.start();
    monitor.stop();
    monitor.stop();
    // No throw, no leaked timer.
    expect(true).toBe(true);
  });
});
