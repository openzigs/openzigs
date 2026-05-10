import { describe, it, expect } from "vitest";
import {
  detectPlatformProfile,
  recommendGemma4Variant,
  type PlatformProfile,
} from "./platform-detector.js";

const GB = 1024 * 1024 * 1024;
const fixedNow = () => new Date("2026-05-08T12:00:00Z");

describe("detectPlatformProfile", () => {
  it("identifies Apple Silicon M3 Pro with unified memory", () => {
    const profile = detectPlatformProfile({
      platform: "darwin",
      arch: "arm64",
      totalMemoryBytes: 36 * GB,
      runSysctl: () => "Apple M3 Pro",
      now: fixedNow,
    });

    expect(profile.os).toBe("macos");
    expect(profile.arch).toBe("arm64");
    expect(profile.chip).toBe("Apple M3 Pro");
    expect(profile.gpuKind).toBe("apple-silicon");
    expect(profile.unifiedMemoryBytes).toBe(36 * GB);
    expect(profile.recommendedBackend).toBe("ollama-mlx");
    expect(profile.detectedAt).toBe("2026-05-08T12:00:00.000Z");
  });

  it("falls back to 'Apple Silicon' chip name when sysctl fails", () => {
    const profile = detectPlatformProfile({
      platform: "darwin",
      arch: "arm64",
      totalMemoryBytes: 16 * GB,
      runSysctl: () => "",
      now: fixedNow,
    });

    expect(profile.chip).toBe("Apple Silicon");
    expect(profile.gpuKind).toBe("apple-silicon");
  });

  it("identifies Windows + NVIDIA GPU host", () => {
    const profile = detectPlatformProfile({
      platform: "win32",
      arch: "x64",
      totalMemoryBytes: 64 * GB,
      runNvidiaSmi: () => "GPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-...)",
      now: fixedNow,
    });

    expect(profile.os).toBe("windows");
    expect(profile.arch).toBe("x64");
    expect(profile.gpuKind).toBe("nvidia");
    expect(profile.unifiedMemoryBytes).toBeNull();
    expect(profile.recommendedBackend).toBe("ollama-cuda");
  });

  it("identifies Linux + NVIDIA GPU host", () => {
    const profile = detectPlatformProfile({
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 32 * GB,
      runNvidiaSmi: () => "GPU 0: NVIDIA RTX A6000",
      now: fixedNow,
    });

    expect(profile.os).toBe("linux");
    expect(profile.gpuKind).toBe("nvidia");
    expect(profile.recommendedBackend).toBe("ollama-cuda");
  });

  it("returns gpuKind=none + ollama-cpu when nvidia-smi is missing on Linux", () => {
    const profile = detectPlatformProfile({
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 16 * GB,
      runNvidiaSmi: () => "",
      now: fixedNow,
    });

    expect(profile.gpuKind).toBe("none");
    expect(profile.recommendedBackend).toBe("ollama-cpu");
  });

  it("returns gpuKind=none when nvidia-smi output does not match GPU pattern", () => {
    const profile = detectPlatformProfile({
      platform: "win32",
      arch: "x64",
      totalMemoryBytes: 16 * GB,
      runNvidiaSmi: () => "command not recognised",
      now: fixedNow,
    });

    expect(profile.gpuKind).toBe("none");
    expect(profile.recommendedBackend).toBe("ollama-cpu");
  });

  it("does not report Apple Silicon when arch is x64 (Intel Mac)", () => {
    const profile = detectPlatformProfile({
      platform: "darwin",
      arch: "x64",
      totalMemoryBytes: 32 * GB,
      runNvidiaSmi: () => "",
      now: fixedNow,
    });

    expect(profile.os).toBe("macos");
    expect(profile.arch).toBe("x64");
    expect(profile.gpuKind).toBe("none");
    expect(profile.unifiedMemoryBytes).toBeNull();
    expect(profile.recommendedBackend).toBe("ollama-cpu");
  });

  it("normalises aarch64 → arm64", () => {
    const profile = detectPlatformProfile({
      platform: "linux",
      arch: "aarch64",
      totalMemoryBytes: 8 * GB,
      runNvidiaSmi: () => "",
      now: fixedNow,
    });
    expect(profile.arch).toBe("arm64");
  });
});

describe("recommendGemma4Variant", () => {
  const baseMacProfile = (gb: number): PlatformProfile => ({
    os: "macos",
    arch: "arm64",
    chip: "Apple M-test",
    totalMemoryBytes: gb * GB,
    unifiedMemoryBytes: gb * GB,
    gpuKind: "apple-silicon",
    recommendedBackend: "ollama-mlx",
    detectedAt: "2026-05-08T12:00:00.000Z",
  });

  const baseNvidiaProfile = (totalRamGb: number): PlatformProfile => ({
    os: "windows",
    arch: "x64",
    chip: "x64 CPU",
    totalMemoryBytes: totalRamGb * GB,
    unifiedMemoryBytes: null,
    gpuKind: "nvidia",
    recommendedBackend: "ollama-cuda",
    detectedAt: "2026-05-08T12:00:00.000Z",
  });

  it("Mac < 16 GB → e4b only", () => {
    const r = recommendGemma4Variant(baseMacProfile(8));
    expect(r.modelId).toBe("gemma4:e4b");
  });

  it("Mac 16-23 GB → 26b Q3/Q4_K_S", () => {
    const r = recommendGemma4Variant(baseMacProfile(16));
    expect(r.modelId).toBe("gemma4:26b");
    expect(r.quantisation).toContain("Q3");
  });

  it("Mac 24-35 GB → 26b Q4_K_M", () => {
    const r = recommendGemma4Variant(baseMacProfile(24));
    expect(r.modelId).toBe("gemma4:26b");
    expect(r.quantisation).toBe("Q4_K_M");
  });

  it("Mac 36-63 GB → 31b INT4", () => {
    const r = recommendGemma4Variant(baseMacProfile(48));
    expect(r.modelId).toBe("gemma4:31b");
    expect(r.quantisation).toBe("INT4");
  });

  it("Mac 64+ GB → 31b Q4_K_M / FP8", () => {
    const r = recommendGemma4Variant(baseMacProfile(128));
    expect(r.modelId).toBe("gemma4:31b");
    expect(r.quantisation).toContain("Q4_K_M");
  });

  it("NVIDIA 16-23 GB VRAM → 26b Q4", () => {
    const r = recommendGemma4Variant(baseNvidiaProfile(64), {
      largestGpuVramBytes: 16 * GB,
    });
    expect(r.modelId).toBe("gemma4:26b");
    expect(r.quantisation).toBe("Q4");
  });

  it("NVIDIA 24+ GB VRAM → 26b/31b advice", () => {
    const r = recommendGemma4Variant(baseNvidiaProfile(64), {
      largestGpuVramBytes: 24 * GB,
    });
    expect(r.modelId).toBe("gemma4:26b");
    expect(r.quantisation).toContain("31b");
  });

  it("NVIDIA < 16 GB VRAM → e4b fallback", () => {
    const r = recommendGemma4Variant(baseNvidiaProfile(32), {
      largestGpuVramBytes: 12 * GB,
    });
    expect(r.modelId).toBe("gemma4:e4b");
  });

  it("CPU-only host → e4b fallback", () => {
    const profile: PlatformProfile = {
      os: "linux",
      arch: "x64",
      chip: "x64 CPU",
      totalMemoryBytes: 16 * GB,
      unifiedMemoryBytes: null,
      gpuKind: "none",
      recommendedBackend: "ollama-cpu",
      detectedAt: "2026-05-08T12:00:00.000Z",
    };
    const r = recommendGemma4Variant(profile);
    expect(r.modelId).toBe("gemma4:e4b");
  });

  it("NVIDIA without vram info → e4b conservative fallback", () => {
    const r = recommendGemma4Variant(baseNvidiaProfile(32));
    expect(r.modelId).toBe("gemma4:e4b");
  });
});
