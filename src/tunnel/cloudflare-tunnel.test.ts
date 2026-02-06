import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CloudflareTunnel } from "./cloudflare-tunnel.js";

class FakeProcess extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    this.emit("exit", 0, null);
    return true;
  });
}

describe("CloudflareTunnel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses the public URL from stderr", async () => {
    const proc = new FakeProcess();
    const spawn = vi.fn(() => proc as unknown as ChildProcess);
    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000
    });

    const startPromise = tunnel.start(3000);
    proc.stderr.emit("data", Buffer.from("connected https://demo.trycloudflare.com"));

    await expect(startPromise).resolves.toBe("https://demo.trycloudflare.com");
    expect(tunnel.getPublicUrl()).toBe("https://demo.trycloudflare.com");
    expect(spawn).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://localhost:3000"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  });

  it("rejects if the tunnel does not connect in time", async () => {
    const proc = new FakeProcess();
    const spawn = vi.fn(() => proc as unknown as ChildProcess);
    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 1000
    });

    const startPromise = tunnel.start(3000);
    const rejection = expect(startPromise).rejects.toThrow("Tunnel timeout");
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
  });

  it("restarts after an unexpected exit", async () => {
    const procOne = new FakeProcess();
    const procTwo = new FakeProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(procOne as unknown as ChildProcess)
      .mockReturnValueOnce(procTwo as unknown as ChildProcess);

    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000,
      reconnectDelayMs: 1000
    });

    const startPromise = tunnel.start(3000);
    const rejection = expect(startPromise).rejects.toThrow("Tunnel exited before connection");
    procOne.emit("exit", 1, null);

    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
