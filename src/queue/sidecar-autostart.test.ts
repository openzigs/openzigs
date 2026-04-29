/**
 * Tests for sub-issue #1010 sidecar auto-start + #1014 polish.
 *
 * Coverage targets:
 *   1. Fast path — health endpoint already responds, no spawn.
 *   2. Cold path — endpoint refused, spawn fired, eventually ready.
 *   3. Backoff schedule — sleep delays follow 250 → 500 → 1s → 2s → 4s → 5s cap.
 *   4. Timeout path — endpoint never responds; default 120s deadline.
 *   5. Spawn failure — spawn throws, error reported.
 *   6. Unsupported platform — returns error without spawning.
 *   7. Windows command resolution — powershell + media-ctl.ps1.
 *   8. POSIX command resolution — bash + media-ctl.sh.
 *   9. DEBUG log line — emitted per probe with attempt + elapsed + status.
 *  10. Non-ok health response is treated as not ready.
 */
import { describe, it, expect, vi } from "vitest";

import { logger } from "../logging/logger.js";
import { __test, ensureSidecarsRunning } from "./sidecar-autostart.js";

function fakeChild() {
  return { unref: vi.fn() } as unknown as ReturnType<typeof Object>;
}

describe("ensureSidecarsRunning", () => {
  const REPO_ROOT = "/tmp/repo";
  const HEALTH_URL = "http://127.0.0.1:5005/health";

  it("fast path: returns ready=true, started=false when health already ok", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);
    const spawnFn = vi.fn();
    let now = 1000;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async () => {
        now += 100;
      },
    });
    expect(result.ready).toBe(true);
    expect(result.started).toBe(false);
    expect(result.attempts).toBe(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cold path: spawns and reports ready after a few backoff probes", async () => {
    let probeCount = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      probeCount += 1;
      // Initial probe + first 2 polling probes fail; the 4th probe succeeds.
      if (probeCount < 4) throw new Error("ECONNREFUSED");
      return { ok: true } as Response;
    });
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    const sleeps: number[] = [];
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      platformOverride: "linux",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    expect(result.ready).toBe(true);
    expect(result.started).toBe(true);
    expect(result.attempts).toBe(4);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    // 1 initial probe + 3 polling probes = 4 fetches.
    expect(fetchFn).toHaveBeenCalledTimes(4);
    // The sleeps preceding probes 2, 3, 4 must follow the backoff schedule.
    expect(sleeps).toEqual([250, 500, 1_000]);
  });

  it("backoff schedule: respects 250 → 500 → 1s → 2s → 4s → 5s cap", async () => {
    // Force every probe to fail so we exhaust the schedule and verify the cap.
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    const sleeps: number[] = [];
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      // Big enough to fit the full schedule (250+500+1000+2000+4000+5000+5000+5000 = 22.75s)
      timeoutMs: 30_000,
      platformOverride: "linux",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    expect(result.ready).toBe(false);
    // First seven sleeps walk the schedule then cap at 5s.
    expect(sleeps.slice(0, 7)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    // Subsequent sleeps stay capped at 5s.
    for (const s of sleeps.slice(7, -1)) {
      expect(s).toBe(5_000);
    }
  });

  it("default timeout is 120s — schedule does not give up before then", async () => {
    expect(__test.DEFAULT_TIMEOUT_MS).toBe(120_000);
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      // No timeoutMs override → falls through to the 120 s default.
      platformOverride: "linux",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result.ready).toBe(false);
    expect(result.error).toContain("120000ms");
    // Final wall clock must be at or beyond 120 s.
    expect(result.durationMs).toBeGreaterThanOrEqual(120_000);
  });

  it("timeout path: spawns but health never recovers — ready=false with error", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(async () => {
        throw new Error("ECONNREFUSED");
      });
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      timeoutMs: 5_000,
      platformOverride: "linux",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result.ready).toBe(false);
    expect(result.started).toBe(true);
    expect(result.error).toContain("did not respond");
    expect(result.error).toContain("5000ms");
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("spawn failure: returns ready=false with spawn error message", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT bash");
    });
    let now = 0;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      platformOverride: "linux",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result.ready).toBe(false);
    expect(result.started).toBe(false);
    expect(result.error).toContain("spawn failed");
    expect(result.error).toContain("ENOENT bash");
  });

  it("unsupported platform: returns error without spawning", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spawnFn = vi.fn();
    let now = 0;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      platformOverride: "aix",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result.ready).toBe(false);
    expect(result.started).toBe(false);
    expect(result.error).toContain("unsupported platform: aix");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("windows: spawns powershell with media-ctl.ps1 flux start", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: "C:\\repo\\openzigs",
      timeoutMs: 100,
      platformOverride: "win32",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("powershell.exe");
    expect(args).toContain("-File");
    expect((args as string[]).some((a: string) => a.endsWith("media-ctl.ps1"))).toBe(true);
    expect(args).toContain("flux");
    expect(args).toContain("start");
    expect((opts as { detached?: boolean }).detached).toBe(true);
  });

  it("posix: spawns bash with media-ctl.sh flux start", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: "/Users/me/repo",
      timeoutMs: 100,
      platformOverride: "darwin",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const [cmd, args] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("bash");
    expect((args as string[])[0]).toContain("media-ctl.sh");
    expect(args).toContain("flux");
    expect(args).toContain("start");
  });

  it("emits a DEBUG log line per probe with attempt + elapsed + status", async () => {
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);
    let now = 1234;
    await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: (() => fakeChild()) as never,
      clock: () => now,
      sleep: async () => {
        now += 100;
      },
    });
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[Sidecars\] attempt 1, elapsed \d+ms, status ok/),
    );
    debugSpy.mockRestore();
  });

  it("non-ok health response is treated as not ready", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false } as Response);
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      timeoutMs: 100,
      platformOverride: "linux",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result.ready).toBe(false);
    // Spawn was triggered because the initial health probe was not ok.
    expect(spawnFn).toHaveBeenCalled();
  });
});
