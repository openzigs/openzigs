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
  SEGMENT_DURATION_SEC,
  computeSegmentCount,
  computeAggregateProgress,
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

  it("includes LTX-2.3 models", () => {
    const v23Models = LTX_MODEL_CATALOG.filter((m) => m.version === "2.3");
    expect(v23Models.length).toBeGreaterThanOrEqual(1);
  });
});

describe("VALID_VIDEO_DURATIONS", () => {
  it("contains 4, 8, 12, 16", () => {
    expect([...VALID_VIDEO_DURATIONS]).toEqual([4, 8, 12, 16]);
  });
});

describe("computeSegmentCount", () => {
  it("returns 1 for durations <= 4s", () => {
    expect(computeSegmentCount(1)).toBe(1);
    expect(computeSegmentCount(4)).toBe(1);
    expect(computeSegmentCount(SEGMENT_DURATION_SEC)).toBe(1);
  });

  it("returns 2 for 8s", () => {
    expect(computeSegmentCount(8)).toBe(2);
  });

  it("returns 3 for 12s", () => {
    expect(computeSegmentCount(12)).toBe(3);
  });

  it("returns 4 for 16s", () => {
    expect(computeSegmentCount(16)).toBe(4);
  });

  it("rounds up for non-exact multiples", () => {
    expect(computeSegmentCount(5)).toBe(2);
    expect(computeSegmentCount(9)).toBe(3);
  });
});

describe("computeAggregateProgress", () => {
  it("returns 0 for 0 total segments", () => {
    expect(computeAggregateProgress(0, 0, 0)).toBe(0);
  });

  it("returns 100 when all segments are complete", () => {
    expect(computeAggregateProgress(4, 4, 0)).toBe(100);
  });

  it("computes weighted average correctly", () => {
    // 4 segments, 1 complete, current at 50% → (100 + 50) / 4 = 37.5
    expect(computeAggregateProgress(4, 1, 50)).toBe(37.5);
  });

  it("returns 25 for 4 segments with first at 100%", () => {
    expect(computeAggregateProgress(4, 1, 0)).toBe(25);
  });

  it("returns 50 for 2 segments with one complete and second at 0%", () => {
    expect(computeAggregateProgress(2, 1, 0)).toBe(50);
  });

  it("clamps current segment progress to 0-100", () => {
    expect(computeAggregateProgress(2, 0, 150)).toBe(50);
    expect(computeAggregateProgress(2, 0, -50)).toBe(0);
  });
});
