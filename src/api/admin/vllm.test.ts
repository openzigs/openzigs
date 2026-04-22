import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import { GpuCoordinator } from "../../gpu/gpu-coordinator.js";
import { createVllmAdminRouter, parsePrometheus } from "./vllm.js";

function startApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/gpu/vllm", router);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

interface MockChild {
  on: (event: string, cb: (arg?: unknown) => void) => MockChild;
}

function mockSpawnSuccess(): MockChild {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const child: MockChild = {
    on(event, cb) {
      handlers[event] = cb;
      if (event === "exit") {
        // Defer so `.on("error",...)` chain can register first.
        queueMicrotask(() => cb(0));
      }
      return child;
    },
  };
  return child;
}

function mockSpawnFailure(): MockChild {
  const child: MockChild = {
    on(event, cb) {
      if (event === "exit") queueMicrotask(() => cb(1));
      return child;
    },
  };
  return child;
}

let inMemDb: Database.Database;
let coordinator: GpuCoordinator;

beforeEach(() => {
  inMemDb = new Database(":memory:");
  coordinator = new GpuCoordinator({ db: inMemDb });
});

afterEach(() => {
  inMemDb.close();
});

describe("vLLM admin router", () => {
  it("GET /status returns reachable=false when vLLM is unreachable", async () => {
    const router = createVllmAdminRouter({
      coordinator,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const { server, baseUrl } = startApp(router);
    try {
      const resp = await fetch(`${baseUrl}/api/admin/gpu/vllm/status`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        reachable: boolean;
        claim: unknown;
        allowedModels: unknown[];
      };
      expect(body.reachable).toBe(false);
      expect(body.claim).toBeNull();
      expect(body.allowedModels.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("POST /start rejects an unknown model with 400", async () => {
    const router = createVllmAdminRouter({
      coordinator,
      spawnImpl: vi.fn() as unknown as typeof import("node:child_process").spawn,
    });
    const { server, baseUrl } = startApp(router);
    try {
      const resp = await fetch(`${baseUrl}/api/admin/gpu/vllm/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "evil/totally-not-allowed" }),
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toBe("invalid_model");
    } finally {
      server.close();
    }
  });

  it("POST /start returns 409 when FLUX already holds the GPUs", async () => {
    coordinator.register("flux", [0, 1]);
    const spawnSpy = vi.fn();
    const router = createVllmAdminRouter({
      coordinator,
      spawnImpl: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    const { server, baseUrl } = startApp(router);
    try {
      const resp = await fetch(`${baseUrl}/api/admin/gpu/vllm/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "Qwen/Qwen2.5-14B-Instruct-AWQ" }),
      });
      expect(resp.status).toBe(409);
      const body = (await resp.json()) as {
        error: string;
        conflictWith: string;
        gpus: number[];
      };
      expect(body.error).toBe("gpu_conflict");
      expect(body.conflictWith).toBe("flux");
      expect(body.gpus).toEqual([0, 1]);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("POST /start succeeds and registers a vLLM claim", async () => {
    const spawnSpy = vi.fn(() => mockSpawnSuccess());
    const router = createVllmAdminRouter({
      coordinator,
      spawnImpl: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    const { server, baseUrl } = startApp(router);
    try {
      const resp = await fetch(`${baseUrl}/api/admin/gpu/vllm/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "Qwen/Qwen2.5-14B-Instruct-AWQ" }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { ok: boolean; model: string };
      expect(body.ok).toBe(true);
      expect(body.model).toBe("Qwen/Qwen2.5-14B-Instruct-AWQ");
      expect(coordinator.currentClaims()).toEqual([
        { workload: "vllm", gpus: [0, 1], startedAt: expect.any(Number) },
      ]);
    } finally {
      server.close();
    }
  });

  it("POST /start rolls back the claim when docker fails", async () => {
    const spawnSpy = vi.fn(() => mockSpawnFailure());
    const router = createVllmAdminRouter({
      coordinator,
      spawnImpl: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    const { server, baseUrl } = startApp(router);
    try {
      const resp = await fetch(`${baseUrl}/api/admin/gpu/vllm/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "Qwen/Qwen2.5-14B-Instruct-AWQ" }),
      });
      expect(resp.status).toBe(500);
      expect(coordinator.currentClaims()).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("POST /start enforces 1-request-per-minute rate limit", async () => {
    const t = 1_000_000;
    const spawnSpy = vi.fn(() => mockSpawnSuccess());
    const router = createVllmAdminRouter({
      coordinator,
      spawnImpl: spawnSpy as unknown as typeof import("node:child_process").spawn,
      now: () => t,
    });
    const { server, baseUrl } = startApp(router);
    try {
      const ok = await fetch(`${baseUrl}/api/admin/gpu/vllm/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "Qwen/Qwen2.5-14B-Instruct-AWQ" }),
      });
      expect(ok.status).toBe(200);
      // Same logical second → rate-limit kicks in.
      coordinator.unregister("vllm");
      const ratelimited = await fetch(
        `${baseUrl}/api/admin/gpu/vllm/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "Qwen/Qwen2.5-14B-Instruct-AWQ" }),
        },
      );
      expect(ratelimited.status).toBe(429);
      expect(ratelimited.headers.get("retry-after")).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it("POST /stop unregisters the vLLM claim", async () => {
    coordinator.register("vllm", [0, 1]);
    const spawnSpy = vi.fn(() => mockSpawnSuccess());
    const router = createVllmAdminRouter({
      coordinator,
      spawnImpl: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    const { server, baseUrl } = startApp(router);
    try {
      const resp = await fetch(`${baseUrl}/api/admin/gpu/vllm/stop`, {
        method: "POST",
      });
      expect(resp.status).toBe(200);
      expect(coordinator.currentClaims()).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe("parsePrometheus", () => {
  it("parses vLLM-style metrics with labels", () => {
    const body = `
# HELP vllm:num_requests_running
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="Qwen/Qwen2.5-14B-Instruct-AWQ"} 3
vllm:gpu_cache_usage_perc 0.42
vllm:e2e_request_latency_seconds_count 17
`;
    const parsed = parsePrometheus(body);
    expect(parsed).toContainEqual({
      name: "vllm:num_requests_running",
      value: 3,
      labels: { model_name: "Qwen/Qwen2.5-14B-Instruct-AWQ" },
    });
    expect(parsed).toContainEqual({
      name: "vllm:gpu_cache_usage_perc",
      value: 0.42,
      labels: {},
    });
    expect(parsed).toContainEqual({
      name: "vllm:e2e_request_latency_seconds_count",
      value: 17,
      labels: {},
    });
  });

  it("ignores comments, blanks, and unparseable lines", () => {
    expect(parsePrometheus("# comment\n\nbad line no value\n")).toEqual([]);
  });
});
