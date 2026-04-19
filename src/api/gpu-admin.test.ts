import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import type { GpuProfile } from "../system/gpu-profile.js";

/**
 * Minimal integration tests for the GPU admin endpoints
 * (POST /gpu/pooling, POST /gpu/pinning, GET /gpu/ollama/*).
 *
 * These test the route handlers in isolation using a stripped-down
 * Express app rather than the full admin router (which has ~20 deps).
 */

const fakeProfile: GpuProfile = {
  detected: true,
  gpus: [
    { index: 0, name: "RTX 3060", total_mb: 12288, free_mb: 11500 },
    { index: 1, name: "RTX 3060", total_mb: 12288, free_mb: 12100 },
  ],
  total_vram_gb: 24,
  largest_gpu_gb: 12,
  recommended_tier: "medium",
  recommended_tier_pooled: "ultra",
  pooling_supported: true,
  same_arch: true,
  pinning: { "image-gen": 0, audio: 0, worker: 1, lipsync: 1, sadtalker: 1 },
  detected_at: "2026-04-19T00:00:00.000Z",
};

/* ── Minimal route handler that mirrors admin.ts logic ─────────────── */

import { z } from "zod";
import { Router } from "express";

function buildTestRouter(opts: {
  readConfig: () => Promise<Record<string, unknown>>;
  writeConfig: (data: Record<string, unknown>) => Promise<void>;
  getProfile: () => Promise<GpuProfile>;
  ollamaFetch?: (url: string) => Promise<Response>;
}) {
  const router = Router();
  router.use(express.json());

  router.post("/gpu/pooling", async (req, res) => {
    const schema = z.object({ mode: z.enum(["manual-flux", "off"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid pooling mode" });
    }
    const userConfig = await opts.readConfig();
    const gpu =
      userConfig.gpu && typeof userConfig.gpu === "object"
        ? (userConfig.gpu as Record<string, unknown>)
        : {};
    gpu.poolingMode = parsed.data.mode;
    userConfig.gpu = gpu;
    await opts.writeConfig(userConfig);
    const profile = await opts.getProfile();
    return res.json(profile);
  });

  router.post("/gpu/pinning", async (req, res) => {
    const schema = z.object({
      pinning: z.record(z.string(), z.number().int().min(0)),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid pinning map" });
    }
    const userConfig = await opts.readConfig();
    const gpu =
      userConfig.gpu && typeof userConfig.gpu === "object"
        ? (userConfig.gpu as Record<string, unknown>)
        : {};
    gpu.pinning = parsed.data.pinning;
    userConfig.gpu = gpu;
    await opts.writeConfig(userConfig);
    const profile = await opts.getProfile();
    return res.json(profile);
  });

  router.get("/gpu/ollama/tags", async (_req, res) => {
    try {
      const resp = opts.ollamaFetch
        ? await opts.ollamaFetch("http://localhost:11434/api/tags")
        : await fetch("http://localhost:11434/api/tags", {
            signal: AbortSignal.timeout(5000),
          });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: `Ollama responded ${resp.status}` });
      }
      return res.json(await resp.json());
    } catch {
      return res.status(503).json({ error: "Ollama not reachable" });
    }
  });

  router.get("/gpu/ollama/ps", async (_req, res) => {
    try {
      const resp = opts.ollamaFetch
        ? await opts.ollamaFetch("http://localhost:11434/api/ps")
        : await fetch("http://localhost:11434/api/ps", {
            signal: AbortSignal.timeout(5000),
          });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: `Ollama responded ${resp.status}` });
      }
      return res.json(await resp.json());
    } catch {
      return res.status(503).json({ error: "Ollama not reachable" });
    }
  });

  return router;
}

describe("GPU admin endpoints", () => {
  let configStore: Record<string, unknown>;
  let app: express.Express;
  let ollamaFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configStore = {};
    ollamaFetchMock = vi.fn();
    app = express();
    app.use(
      "/api/admin",
      buildTestRouter({
        readConfig: async () => ({ ...configStore }),
        writeConfig: async (data) => {
          configStore = data;
        },
        getProfile: async () => fakeProfile,
        ollamaFetch: ollamaFetchMock,
      }),
    );
  });

  // ── Pooling ──

  describe("POST /gpu/pooling", () => {
    it("accepts manual-flux mode and returns profile", async () => {
      const res = await request(app)
        .post("/api/admin/gpu/pooling")
        .send({ mode: "manual-flux" });
      expect(res.status).toBe(200);
      expect(res.body.detected).toBe(true);
      expect(res.body.pooling_supported).toBe(true);
      expect(configStore.gpu).toBeDefined();
      expect(
        (configStore.gpu as Record<string, unknown>).poolingMode,
      ).toBe("manual-flux");
    });

    it("accepts off mode", async () => {
      const res = await request(app)
        .post("/api/admin/gpu/pooling")
        .send({ mode: "off" });
      expect(res.status).toBe(200);
      expect(
        (configStore.gpu as Record<string, unknown>).poolingMode,
      ).toBe("off");
    });

    it("rejects invalid mode with 400", async () => {
      const res = await request(app)
        .post("/api/admin/gpu/pooling")
        .send({ mode: "turbo" });
      expect(res.status).toBe(400);
    });

    it("rejects missing body with 400", async () => {
      const res = await request(app)
        .post("/api/admin/gpu/pooling")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // ── Pinning ──

  describe("POST /gpu/pinning", () => {
    it("saves a valid pinning map and returns profile", async () => {
      const pinning = { "image-gen": 1, audio: 0, worker: 0 };
      const res = await request(app)
        .post("/api/admin/gpu/pinning")
        .send({ pinning });
      expect(res.status).toBe(200);
      expect(res.body.gpus).toHaveLength(2);
      expect(
        (configStore.gpu as Record<string, unknown>).pinning,
      ).toEqual(pinning);
    });

    it("rejects negative GPU index with 400", async () => {
      const res = await request(app)
        .post("/api/admin/gpu/pinning")
        .send({ pinning: { "image-gen": -1 } });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer GPU index with 400", async () => {
      const res = await request(app)
        .post("/api/admin/gpu/pinning")
        .send({ pinning: { "image-gen": 0.5 } });
      expect(res.status).toBe(400);
    });

    it("rejects missing pinning field with 400", async () => {
      const res = await request(app)
        .post("/api/admin/gpu/pinning")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // ── Ollama proxy ──

  describe("GET /gpu/ollama/tags", () => {
    it("proxies Ollama tags response", async () => {
      ollamaFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: "gemma4:26b", size: 18000000000 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const res = await request(app).get("/api/admin/gpu/ollama/tags");
      expect(res.status).toBe(200);
      expect(res.body.models).toHaveLength(1);
      expect(res.body.models[0].name).toBe("gemma4:26b");
    });

    it("returns 503 when Ollama is not reachable", async () => {
      ollamaFetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const res = await request(app).get("/api/admin/gpu/ollama/tags");
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not reachable/i);
    });
  });

  describe("GET /gpu/ollama/ps", () => {
    it("proxies Ollama running models", async () => {
      ollamaFetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: "gemma4:26b", size: 18000000000, size_vram: 17500000000 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const res = await request(app).get("/api/admin/gpu/ollama/ps");
      expect(res.status).toBe(200);
      expect(res.body.models[0].name).toBe("gemma4:26b");
    });

    it("returns 503 when Ollama is down", async () => {
      ollamaFetchMock.mockRejectedValueOnce(new Error("timeout"));
      const res = await request(app).get("/api/admin/gpu/ollama/ps");
      expect(res.status).toBe(503);
    });
  });
});
