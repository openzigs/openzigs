/**
 * Media Queue Types — Tests
 * Issue #389: Verify remix job type routing and defaults.
 */

import { describe, it, expect } from "vitest";
import {
  targetNodeForJobType,
  defaultModelForJobType,
  AUDIO_JOB_TYPES,
  VALID_PIPELINE_TYPES,
  VALID_TILING_MODES,
  LTX_MODEL_CATALOG,
  VALID_VIDEO_DURATIONS,
} from "./types.js";

describe("targetNodeForJobType", () => {
  it("routes image jobs to mac-mini", () => {
    expect(targetNodeForJobType("txt2img")).toBe("mac-mini");
    expect(targetNodeForJobType("img2img")).toBe("mac-mini");
  });

  it("routes video/audio jobs to m2-pro", () => {
    expect(targetNodeForJobType("txt2video")).toBe("m2-pro");
    expect(targetNodeForJobType("tts")).toBe("m2-pro");
  });

  it("routes music-studio jobs to local", () => {
    expect(targetNodeForJobType("voice2voice")).toBe("local");
    expect(targetNodeForJobType("remix_analyze")).toBe("local");
    expect(targetNodeForJobType("remix_replace")).toBe("local");
    expect(targetNodeForJobType("remix_master")).toBe("local");
  });
});

describe("defaultModelForJobType", () => {
  it("returns htdemucs_6s for remix_analyze", () => {
    expect(defaultModelForJobType("remix_analyze")).toBe("htdemucs_6s");
  });

  it("returns basic-pitch for remix_replace", () => {
    expect(defaultModelForJobType("remix_replace")).toBe("basic-pitch");
  });

  it("returns matchering for remix_master", () => {
    expect(defaultModelForJobType("remix_master")).toBe("matchering");
  });

  it("returns seed-vc for voice2voice", () => {
    expect(defaultModelForJobType("voice2voice")).toBe("seed-vc");
  });
});

describe("AUDIO_JOB_TYPES", () => {
  it("includes all audio/music types handled by dedicated dispatchers", () => {
    expect(AUDIO_JOB_TYPES.has("txt2music")).toBe(true);
    expect(AUDIO_JOB_TYPES.has("voice2voice")).toBe(true);
    expect(AUDIO_JOB_TYPES.has("remix_analyze")).toBe(true);
    expect(AUDIO_JOB_TYPES.has("remix_replace")).toBe(true);
    expect(AUDIO_JOB_TYPES.has("remix_master")).toBe(true);
  });

  it("excludes video and image job types", () => {
    expect(AUDIO_JOB_TYPES.has("txt2video")).toBe(false);
    expect(AUDIO_JOB_TYPES.has("img2video")).toBe(false);
    expect(AUDIO_JOB_TYPES.has("txt2img")).toBe(false);
    expect(AUDIO_JOB_TYPES.has("img2img")).toBe(false);
  });
});

describe("VALID_PIPELINE_TYPES", () => {
  it("contains the four LTX pipeline types", () => {
    expect(VALID_PIPELINE_TYPES).toContain("distilled");
    expect(VALID_PIPELINE_TYPES).toContain("dev");
    expect(VALID_PIPELINE_TYPES).toContain("dev-two-stage");
    expect(VALID_PIPELINE_TYPES).toContain("dev-two-stage-hq");
    expect(VALID_PIPELINE_TYPES).toHaveLength(4);
  });
});

describe("VALID_TILING_MODES", () => {
  it("contains the five tiling modes", () => {
    expect(VALID_TILING_MODES).toContain("auto");
    expect(VALID_TILING_MODES).toContain("none");
    expect(VALID_TILING_MODES).toContain("default");
    expect(VALID_TILING_MODES).toContain("aggressive");
    expect(VALID_TILING_MODES).toContain("conservative");
    expect(VALID_TILING_MODES).toHaveLength(5);
  });
});

describe("LTX_MODEL_CATALOG", () => {
  it("contains at least one model entry", () => {
    expect(LTX_MODEL_CATALOG.length).toBeGreaterThanOrEqual(1);
  });

  it("every entry has required fields", () => {
    for (const model of LTX_MODEL_CATALOG) {
      expect(model.id).toBeTruthy();
      expect(model.repo).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.memoryGB).toBeGreaterThan(0);
      expect(model.downloadGB).toBeGreaterThan(0);
      expect(model.version).toBeTruthy();
    }
  });

  it("includes the default LTX-2 distilled Q4 model", () => {
    const defaultModel = LTX_MODEL_CATALOG.find(
      (m) => m.id === "ltx-2-distilled-q4",
    );
    expect(defaultModel).toBeDefined();
    expect(defaultModel!.repo).toBe("AITRADER/ltx2-distilled-4bit-mlx");
  });

  it("includes CUDA models for 12GB VRAM GPUs", () => {
    const cudaModels = LTX_MODEL_CATALOG.filter((m) => m.backend === "cuda");
    expect(cudaModels.length).toBeGreaterThanOrEqual(1);
    const distilled = cudaModels.find((m) => m.id === "ltxv-13b-097-distilled");
    expect(distilled).toBeDefined();
    expect(distilled!.repo).toBe("Lightricks/LTX-Video-0.9.7-distilled");
  });

  it("includes MLX and CUDA backend entries", () => {
    const mlx = LTX_MODEL_CATALOG.filter((m) => m.backend === "mlx");
    const cuda = LTX_MODEL_CATALOG.filter((m) => m.backend === "cuda");
    expect(mlx.length).toBeGreaterThanOrEqual(1);
    expect(cuda.length).toBeGreaterThanOrEqual(1);
  });
});

describe("VALID_VIDEO_DURATIONS", () => {
  it("contains the four valid durations", () => {
    expect(VALID_VIDEO_DURATIONS).toEqual([4, 8, 12, 16]);
  });

  it("includes 4s (single segment)", () => {
    expect(VALID_VIDEO_DURATIONS).toContain(4);
  });

  it("includes 16s (maximum multi-segment)", () => {
    expect(VALID_VIDEO_DURATIONS).toContain(16);
  });
});
