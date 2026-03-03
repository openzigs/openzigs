import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
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

  it("detects named tunnel connection and uses hostname", async () => {
    const proc = new FakeProcess();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
    const tunnel = new CloudflareTunnel({
      mode: "named",
      namedTunnel: {
        credentialsFile: "/tmp/creds.json",
        hostname: "app.example.com"
      },
      spawn,
      connectTimeoutMs: 5000
    });

    const startPromise = tunnel.start(3000);
    proc.stderr.emit("data", Buffer.from("Registered tunnel connection"));

    await expect(startPromise).resolves.toBe("https://app.example.com");
    expect(tunnel.getPublicUrl()).toBe("https://app.example.com");
    expect(spawn).toHaveBeenCalledWith(
      "cloudflared",
      [
        "tunnel",
        "--url",
        "http://localhost:3000",
        "--credentials-file",
        "/tmp/creds.json",
        "--hostname",
        "app.example.com"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  });

  it("restarts after an unexpected exit", async () => {
    const procOne = new FakeProcess();
    const procTwo = new FakeProcess();
    const spawn = vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValueOnce(procOne as unknown as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValueOnce(procTwo as unknown as any);

    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000,
      reconnectDelayMs: 1000
    });

    // 1. Initial success
    const startPromise = tunnel.start(3000);
    procOne.stderr.emit("data", Buffer.from("https://reconnect-test.trycloudflare.com"));
    await expect(startPromise).resolves.toBe("https://reconnect-test.trycloudflare.com");

    // 2. Unexpected die
    procOne.emit("exit", 1, null);

    // 3. Wait for reconnect delay
    await vi.advanceTimersByTimeAsync(1000);

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("stop() kills process and clears URL", async () => {
    const proc = new FakeProcess();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000
    });

    const startPromise = tunnel.start(3000);
    proc.stderr.emit("data", Buffer.from("https://stop-test.trycloudflare.com"));
    await startPromise;

    expect(tunnel.getPublicUrl()).toBe("https://stop-test.trycloudflare.com");
    await tunnel.stop();
    expect(tunnel.getPublicUrl()).toBeNull();
    expect(proc.kill).toHaveBeenCalled();
  });

  it("returns existing URL when already connected", async () => {
    const proc = new FakeProcess();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000
    });

    const p1 = tunnel.start(3000);
    proc.stderr.emit("data", Buffer.from("https://existing.trycloudflare.com"));
    await p1;

    // Second start returns immediately
    const url = await tunnel.start(3000);
    expect(url).toBe("https://existing.trycloudflare.com");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects when process exits before connecting", async () => {
    const proc = new FakeProcess();
    proc.kill = vi.fn(); // Don't auto-emit exit on kill
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000
    });

    const startPromise = tunnel.start(3000);
    proc.emit("exit", 1, null);

    await expect(startPromise).rejects.toThrow("Tunnel exited before connection was established");
  });

  it("rejects when process emits error during initial connect", async () => {
    const proc = new FakeProcess();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000
    });

    const startPromise = tunnel.start(3000);
    proc.emit("error", new Error("ENOENT"));

    await expect(startPromise).rejects.toThrow("ENOENT");
  });

  it("stop() rejects pending connect promise", async () => {
    const proc = new FakeProcess();
    proc.kill = vi.fn(); // Don't auto-emit exit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawn = vi.fn(() => proc as unknown as any);
    const tunnel = new CloudflareTunnel({
      mode: "quick",
      spawn,
      connectTimeoutMs: 5000
    });

    const startPromise = tunnel.start(3000);
    await tunnel.stop();

    await expect(startPromise).rejects.toThrow("Tunnel stopped");
  });
});
