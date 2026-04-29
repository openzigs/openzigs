/**
 * Tests for sub-issue #1010 sidecar auto-start.
 *
 * Coverage targets:
 *   1. Fast path \u2014 health endpoint already responds, no spawn.
 *   2. Cold path \u2014 endpoint refused, spawn fired, eventually ready.
 *   3. Timeout path \u2014 endpoint never responds, spawn fired, error reported.
 *   4. Spawn failure \u2014 spawn throws, error reported.
 *   5. Unsupported platform \u2014 returns error without spawning.
 *   6. Windows command resolution \u2014 powershell + media-ctl.ps1.
 *   7. POSIX command resolution \u2014 bash + media-ctl.sh.
 */
import { describe, it, expect, vi } from "vitest";
import { ensureSidecarsRunning } from "./sidecar-autostart.js";

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
    expect(spawnFn).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cold path: spawns start script and reports ready after a few polls", async () => {
    let probeCount = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      probeCount += 1;
      // Initial probe fails (cold), 3rd probe (after 2 sleeps) succeeds.
      if (probeCount < 3) throw new Error("ECONNREFUSED");
      return { ok: true } as Response;
    });
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      timeoutMs: 60_000,
      pollIntervalMs: 1000,
      platformOverride: "linux",
      fetchFn: fetchFn as unknown as typeof fetch,
      spawnFn: spawnFn as never,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result.ready).toBe(true);
    expect(result.started).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    // 1 initial probe + 2 polling probes = 3 fetches.
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("timeout path: spawns but health never recovers \u2014 ready=false with error", async () => {
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
      pollIntervalMs: 1000,
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
      pollIntervalMs: 50,
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
      pollIntervalMs: 50,
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

  it("non-ok health response is treated as not ready", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false } as Response);
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    let now = 0;
    const result = await ensureSidecarsRunning({
      healthUrl: HEALTH_URL,
      repoRoot: REPO_ROOT,
      timeoutMs: 100,
      pollIntervalMs: 50,
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
