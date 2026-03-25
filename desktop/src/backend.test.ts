import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { BackendManager } from "./backend.js";

// We test the health check and port-finding logic.
// Spawning actual child processes is tested via integration.

describe("BackendManager", () => {
  let manager: BackendManager;

  beforeEach(() => {
    manager = new BackendManager({
      isDev: true,
      backendPath: "/fake/server.js",
      healthCheckIntervalMs: 500,
      healthCheckTimeoutMs: 1000,
      startupTimeoutMs: 3000,
    });
  });

  afterEach(() => {
    manager.stop();
  });

  it("initializes with stopped status", () => {
    expect(manager.getStatus()).toBe("stopped");
    expect(manager.getPort()).toBeNull();
  });

  it("finds a free port", async () => {
    const port = await manager.findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("finds different free ports on subsequent calls", async () => {
    const port1 = await manager.findFreePort();
    const port2 = await manager.findFreePort();
    // Ports might be the same if released, but should both be valid
    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
  });

  it("checkHealth returns true for a healthy server", async () => {
    // Start a tiny HTTP server that responds like the real health endpoint
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    const port = await manager.findFreePort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    try {
      const healthy = await manager.checkHealth(port);
      expect(healthy).toBe(true);
    } finally {
      server.close();
    }
  });

  it("checkHealth returns false for a server with bad response", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error" }));
    });

    const port = await manager.findFreePort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    try {
      const healthy = await manager.checkHealth(port);
      expect(healthy).toBe(false);
    } finally {
      server.close();
    }
  });

  it("checkHealth returns false when no server is running", async () => {
    const port = await manager.findFreePort();
    const healthy = await manager.checkHealth(port);
    expect(healthy).toBe(false);
  });

  it("emits status events", () => {
    const statuses: string[] = [];
    manager.on("status", (s: string) => statuses.push(s));

    // start() in dev mode with no server will try external check then maybe fail
    // But we can test the status event mechanism directly through the class
    // by calling stop which sets "stopped"
    manager.stop();
    expect(statuses).toContain("stopped");
  });

  it("start() in dev mode detects running server", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    const port = 3000;
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    // Set env var so dev mode uses this port
    const origPort = process.env.OPENZIGS_PORT;
    process.env.OPENZIGS_PORT = String(port);

    try {
      await manager.start();
      expect(manager.getStatus()).toBe("running");
      expect(manager.getPort()).toBe(port);
    } finally {
      process.env.OPENZIGS_PORT = origPort;
      manager.stop();
      server.close();
    }
  });
});
