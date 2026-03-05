/**
 * Media Queue Types — Tests
 * Issue #389: Verify remix job type routing and defaults.
 */

import { describe, it, expect } from "vitest";
import { targetNodeForJobType, defaultModelForJobType, AUDIO_JOB_TYPES } from "./types.js";

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
