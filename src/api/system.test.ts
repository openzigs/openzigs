import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";

import { createSystemRouter } from "./system.js";
import type { GpuProfile } from "../system/gpu-profile.js";

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

describe("system router", () => {
  it("GET /gpu returns the profile", async () => {
    const app = express();
    app.use("/api/system", createSystemRouter({ loadProfile: async () => fakeProfile }));
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
});
