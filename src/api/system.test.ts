import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";

import { createSystemRouter } from "./system.js";
import type { GpuProfile } from "../system/gpu-profile.js";
import { GpuCoordinator } from "../gpu/gpu-coordinator.js";

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
  pooling_mode: "off",
  pinning: { "image-gen": 0, audio: 0, worker: 1, lipsync: 1, sadtalker: 1 },
  detected_at: "2026-04-19T00:00:00.000Z",
};

describe("system router", () => {
  it("GET /gpu returns the profile", async () => {
    const app = express();
    app.use(
      "/api/system",
      createSystemRouter({ loadProfile: async () => fakeProfile }),
    );
    const res = await request(app).get("/api/system/gpu");
    expect(res.status).toBe(200);
    expect(res.body.detected).toBe(true);
    expect(res.body.gpus).toHaveLength(2);
    expect(res.body.recommended_tier).toBe("medium");
    expect(res.body.pinning.worker).toBe(1);
    // Pooling fields surface through the API so the UI can advertise opt-in tiers.
    expect(res.body.pooling_supported).toBe(true);
    expect(res.body.same_arch).toBe(true);
    expect(res.body.recommended_tier_pooled).toBe("ultra");
  });

  it("GET /gpu returns 500 if loader throws", async () => {
    const app = express();
    app.use(
      "/api/system",
      createSystemRouter({
        loadProfile: async () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await request(app).get("/api/system/gpu");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/GPU profile/i);
  });

  // Issue #917 (Epic #888): coordinator state must be merged into the
  // /api/system/gpu response so the UI can render conflicts + serving_mode.
  describe("coordinator state merge", () => {
    const buildApp = (coordinator: GpuCoordinator) => {
      const app = express();
      app.use(
        "/api/system",
        createSystemRouter({
          loadProfile: async () => fakeProfile,
          coordinator,
        }),
      );
      return app;
    };

    it("returns serving_mode=idle and empty conflicts when no claims", async () => {
      const db = new Database(":memory:");
      const coord = new GpuCoordinator({ db });
      const res = await request(buildApp(coord)).get("/api/system/gpu");
      expect(res.status).toBe(200);
      expect(res.body.serving_mode).toBe("idle");
      expect(res.body.conflicts).toEqual([]);
      // Original profile fields still present.
      expect(res.body.detected).toBe(true);
      expect(res.body.gpus).toHaveLength(2);
    });

    it("returns serving_mode=vllm-tp2 when only vLLM is claimed", async () => {
      const db = new Database(":memory:");
      const coord = new GpuCoordinator({ db });
      const result = coord.register("vllm", [0, 1]);
      expect(result.ok).toBe(true);
      const res = await request(buildApp(coord)).get("/api/system/gpu");
      expect(res.status).toBe(200);
      expect(res.body.serving_mode).toBe("vllm-tp2");
      expect(res.body.conflicts).toEqual([]);
    });

    it("returns serving_mode=mixed and conflicts when vLLM + diffusion overlap", async () => {
      // vLLM holds [0,1] (exclusive), then non-exclusive sadtalker claims [1].
      // The coordinator rejects the second claim, so to *exercise* the
      // conflict-summary path we register a non-exclusive workload first
      // and then promote vLLM — which is also rejected. Instead, test by
      // injecting two claims directly via separate exclusive workloads on
      // disjoint GPUs is meaningless; the realistic conflict the UI cares
      // about is exclusive ↔ non-exclusive overlap that slipped through
      // (e.g. stale claim races). Use a fake coordinator that returns
      // pre-built claims to cover the summarisation contract.
      const fakeCoordinator = {
        currentClaims: () => [
          { workload: "vllm" as const, gpus: [0, 1], startedAt: 0 },
          { workload: "sadtalker" as const, gpus: [1], startedAt: 0 },
        ],
      };
      const app = express();
      app.use(
        "/api/system",
        createSystemRouter({
          loadProfile: async () => fakeProfile,
          coordinator: fakeCoordinator,
        }),
      );
      const res = await request(app).get("/api/system/gpu");
      expect(res.status).toBe(200);
      expect(res.body.serving_mode).toBe("mixed");
      expect(res.body.conflicts.length).toBeGreaterThan(0);
      expect(res.body.conflicts[0]).toMatch(/vllm/);
      expect(res.body.conflicts[0]).toMatch(/sadtalker/);
    });
  });

  // Issue #1063 (Epic #1053): platform endpoint for the System Requirements
  // card and offline setup wizard.
  describe("GET /platform", () => {
    const macProfile = {
      os: "macos" as const,
      arch: "arm64" as const,
      chip: "Apple M4 Max",
      totalMemoryBytes: 64 * 1024 * 1024 * 1024,
      unifiedMemoryBytes: 64 * 1024 * 1024 * 1024,
      gpuKind: "apple-silicon" as const,
      recommendedBackend: "ollama-mlx" as const,
      detectedAt: "2026-05-08T00:00:00.000Z",
    };

    it("returns the detected platform + recommended Gemma 4 variant", async () => {
      const app = express();
      app.use(
        "/api/system",
        createSystemRouter({
          loadProfile: async () => fakeProfile,
          loadPlatform: () => macProfile,
        }),
      );
      const res = await request(app).get("/api/system/platform");
      expect(res.status).toBe(200);
      expect(res.body.platform.os).toBe("macos");
      expect(res.body.platform.gpuKind).toBe("apple-silicon");
      expect(res.body.recommended.modelId).toBe("gemma4:31b");
      expect(res.body.unifiedMemoryGb).toBe(64);
      // largestGpuVramGb comes from fakeProfile.largest_gpu_gb=12 → 12 GB
      expect(res.body.largestGpuVramGb).toBeCloseTo(12, 1);
    });

    it("survives GPU detection failure and still returns recommendation", async () => {
      const app = express();
      app.use(
        "/api/system",
        createSystemRouter({
          loadProfile: async () => {
            throw new Error("nvidia-smi missing");
          },
          loadPlatform: () => macProfile,
        }),
      );
      const res = await request(app).get("/api/system/platform");
      expect(res.status).toBe(200);
      expect(res.body.recommended.modelId).toBe("gemma4:31b");
      expect(res.body.largestGpuVramGb).toBeNull();
    });

    it("returns 500 if the platform detector throws", async () => {
      const app = express();
      app.use(
        "/api/system",
        createSystemRouter({
          loadProfile: async () => fakeProfile,
          loadPlatform: () => {
            throw new Error("kapow");
          },
        }),
      );
      const res = await request(app).get("/api/system/platform");
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/platform/i);
    });

    // Admin parity bug #1077-A: Apple Silicon hosts must report vLLM as
    // unsupported so the admin Local LLM Provider combobox + Local vLLM
    // panel can render the same "⛔" affordance the wizard already shows.
    it("reports vllmSupported=false with reason on Apple Silicon", async () => {
      const app = express();
      app.use(
        "/api/system",
        createSystemRouter({
          loadProfile: async () => fakeProfile,
          loadPlatform: () => macProfile,
        }),
      );
      const res = await request(app).get("/api/system/platform");
      expect(res.status).toBe(200);
      expect(res.body.vllmSupported).toBe(false);
      expect(res.body.vllmUnsupportedReason).toMatch(/Apple Silicon/);
      expect(res.body.vllmUnsupportedReason).toMatch(/Ollama \+ MLX/);
    });

    it("reports vllmSupported=true with null reason on NVIDIA hosts", async () => {
      const linuxNvidiaProfile = {
        os: "linux" as const,
        arch: "x64" as const,
        chip: "x86_64 CPU",
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        unifiedMemoryBytes: null,
        gpuKind: "nvidia" as const,
        recommendedBackend: "ollama-cuda" as const,
        detectedAt: "2026-05-08T00:00:00.000Z",
      };
      const app = express();
      app.use(
        "/api/system",
        createSystemRouter({
          loadProfile: async () => fakeProfile,
          loadPlatform: () => linuxNvidiaProfile,
        }),
      );
      const res = await request(app).get("/api/system/platform");
      expect(res.status).toBe(200);
      expect(res.body.vllmSupported).toBe(true);
      expect(res.body.vllmUnsupportedReason).toBeNull();
    });
  });
});
