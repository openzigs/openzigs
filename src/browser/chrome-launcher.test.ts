import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module
const mockSpawn = vi.fn();
const mockExec = vi.fn((cmd, cb) => {
  if (typeof cb === "function") {
    cb(null, "", "");
  } else if (typeof cmd === "function") {
    // handle case where just callback is passed? unlikely for exec
  }
  return { unref: vi.fn(), kill: vi.fn() }; // return pseudo child process
});

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
  exec: mockExec
}));

// Mock fs.existsSync
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync
}));

// Mock logger
vi.mock("../logging/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("chrome-launcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockFetch.mockRejectedValue(new Error("connection refused"));
  });

  it("returns false when no Chrome binary is found", async () => {
    mockExistsSync.mockReturnValue(false);

    const { launchChrome } = await import("./chrome-launcher.js");
    const result = await launchChrome({ host: "localhost", port: 9222 });

    expect(result).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips launch when Chrome is already reachable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { launchChrome } = await import("./chrome-launcher.js");
    const result = await launchChrome({
      host: "localhost",
      port: 9222,
      reuseExisting: true
    });

    expect(result).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("launches Chrome when binary is found and port is not reachable", async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p.includes("Chrome") || p.includes("chrome")
    );

    // First fetch (reuse check) fails, then subsequent probes succeed
    mockFetch
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue({ ok: true });

    const fakeProcess = {
      unref: vi.fn(),
      on: vi.fn(),
      kill: vi.fn(),
      exitCode: null
    };
    mockSpawn.mockReturnValue(fakeProcess);

    const { launchChrome } = await import("./chrome-launcher.js");
    const result = await launchChrome({ host: "localhost", port: 9222 });

    expect(result).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--no-first-run");
    // unref() removed in recent changes
    // expect(fakeProcess.unref).toHaveBeenCalled();
  });

  it("killChrome is safe when no process was launched", async () => {
    const { killChrome } = await import("./chrome-launcher.js");
    expect(() => killChrome()).not.toThrow();
  });
});
