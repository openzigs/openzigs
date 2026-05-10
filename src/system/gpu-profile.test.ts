import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  detectGpuProfile,
  tierForVram,
  defaultPinning,
  _resetGpuProfileCache,
  getGpuProfile,
} from "./gpu-profile.js";

beforeEach(() => {
  _resetGpuProfileCache();
});

describe("tierForVram", () => {
  it("classifies VRAM into tiers", () => {
    expect(tierForVram(8)).toBe("low");
    expect(tierForVram(11)).toBe("medium");
    expect(tierForVram(12)).toBe("medium");
    expect(tierForVram(16)).toBe("high");
    expect(tierForVram(24)).toBe("ultra");
    expect(tierForVram(48)).toBe("ultra");
  });
});

describe("defaultPinning", () => {
  it("pins everything to GPU 0 on single-GPU hosts", () => {
    expect(defaultPinning(1)).toEqual({
      "image-gen": 0,
      audio: 0,
      worker: 0,
      lipsync: 0,
      sadtalker: 0,
    });
  });
  it("splits pipelines across two GPUs", () => {
    const pin = defaultPinning(2);
    expect(pin["image-gen"]).toBe(0);
    expect(pin.audio).toBe(0);
    expect(pin.worker).toBe(1);
    expect(pin.lipsync).toBe(1);
  });
  it("zero GPUs falls back to single-GPU layout", () => {
    expect(defaultPinning(0)["image-gen"]).toBe(0);
  });
});

describe("detectGpuProfile", () => {
  it("parses dual RTX 3060 nvidia-smi output", async () => {
    const profile = await detectGpuProfile({
      platform: "linux",
      exec: async () => ({
        stdout:
          "0, NVIDIA GeForce RTX 3060, 12288, 11762\n1, NVIDIA GeForce RTX 3060, 12288, 12100\n",
      }),
    });
    expect(profile.detected).toBe(true);
    expect(profile.gpus).toHaveLength(2);
    expect(profile.gpus[0].name).toBe("NVIDIA GeForce RTX 3060");
    expect(profile.total_vram_gb).toBe(24);
    expect(profile.largest_gpu_gb).toBe(12);
    expect(profile.recommended_tier).toBe("medium");
    expect(profile.pinning.worker).toBe(1);
    // Pooling: 2x same-arch → supported, aggregate 24GB → ultra tier (advisory).
    expect(profile.pooling_supported).toBe(true);
    expect(profile.same_arch).toBe(true);
    expect(profile.recommended_tier_pooled).toBe("ultra");
  });

  it("flags mixed-arch hosts as not pool-supported", async () => {
    const profile = await detectGpuProfile({
      platform: "linux",
      exec: async () => ({
        stdout:
          "0, NVIDIA GeForce RTX 3060, 12288, 11700\n1, NVIDIA GeForce RTX 4090, 24576, 24000\n",
      }),
    });
    expect(profile.gpus).toHaveLength(2);
    expect(profile.same_arch).toBe(false);
    expect(profile.pooling_supported).toBe(false);
    expect(profile.recommended_tier_pooled).toBeUndefined();
    // Tier still bound by largest single card.
    expect(profile.recommended_tier).toBe("ultra");
  });

  it("returns detected:false when nvidia-smi is missing", async () => {
    const profile = await detectGpuProfile({
      platform: "linux",
      exec: async () => {
        throw new Error("ENOENT: nvidia-smi not found");
      },
    });
    expect(profile.detected).toBe(false);
    expect(profile.gpus).toHaveLength(0);
    expect(profile.recommended_tier).toBe("low");
  });

  it("recommends ultra for a single 24GB card", async () => {
    const profile = await detectGpuProfile({
      platform: "linux",
      exec: async () => ({
        stdout: "0, NVIDIA GeForce RTX 4090, 24576, 23000\n",
      }),
    });
    expect(profile.largest_gpu_gb).toBe(24);
    expect(profile.recommended_tier).toBe("ultra");
    expect(profile.pinning.worker).toBe(0);
    // Single card → no pooling.
    expect(profile.pooling_supported).toBe(false);
    expect(profile.recommended_tier_pooled).toBeUndefined();
    expect(profile.same_arch).toBe(true);
  });

  it("ignores malformed rows", async () => {
    const profile = await detectGpuProfile({
      platform: "linux",
      exec: async () => ({
        stdout: "0, RTX 3060, 12288, 11762\nbroken row\n",
      }),
    });
    expect(profile.gpus).toHaveLength(1);
  });

  it("on darwin, skips nvidia-smi entirely and reports an Apple Silicon Metal device", async () => {
    const exec = vi.fn(async () => {
      throw new Error("nvidia-smi must not be invoked on darwin");
    });
    const GB = 1024 * 1024 * 1024;
    const profile = await detectGpuProfile({
      platform: "darwin",
      totalMemoryBytes: 24 * GB,
      exec,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(profile.detected).toBe(false);
    expect(profile.gpus).toEqual([]);
    expect(profile.apple_silicon).toEqual({
      name: "Apple Silicon GPU (Metal)",
      unified: true,
      unified_memory_gb: 24,
    });
    expect(profile.total_vram_gb).toBe(0);
    expect(profile.pooling_supported).toBe(false);
  });
});

describe("getGpuProfile cache", () => {
  it("only invokes the executor once", async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      return { stdout: "0, RTX 3060, 12288, 11762\n" };
    };
    await getGpuProfile({ platform: "linux", exec });
    await getGpuProfile({ platform: "linux", exec });
    expect(calls).toBe(1);
  });
});
