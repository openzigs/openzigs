/**
 * Talking-Head Pipeline — Tests
 * Issue #802: TTS → Video → Lip Sync pipeline orchestration.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createTalkingHeadPipeline,
  handleStageCompletion,
  handleStageFailure,
  markLipsyncSkipped,
  getPipelineState,
  getFinalStageResult,
  PIPELINE_STAGES,
} from "./talking-head-pipeline.js";

describe("talking-head-pipeline", () => {
  describe("createTalkingHeadPipeline", () => {
    it("creates a pipeline and returns first TTS job", () => {
      const { pipelineId, firstJob } = createTalkingHeadPipeline({
        text: "Hello, world!",
        voice: "af_heart",
      });

      expect(pipelineId).toMatch(/^thp-/);
      expect(firstJob.type).toBe("tts");
      expect(firstJob.payload.prompt).toBe("Hello, world!");
      expect(firstJob.payload.voice).toBe("af_heart");
      expect(firstJob.payload.pipeline_id).toBe(pipelineId);
      expect(firstJob.payload.pipeline_stage).toBe("speech");
      expect(firstJob.payload.pipeline_type).toBe("talking-head");
      expect(firstJob.model).toBe("f5-tts");
      expect(firstJob.targetNode).toBe("m2-pro");
    });

    it("stores pipeline state", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Test text",
      });

      const state = getPipelineState(pipelineId);
      expect(state).toBeDefined();
      expect(state!.currentStage).toBe(0);
      expect(state!.config.text).toBe("Test text");
    });
  });

  describe("handleStageCompletion", () => {
    let pipelineId: string;

    beforeEach(() => {
      const result = createTalkingHeadPipeline({
        text: "Test speech",
        videoPrompt: "A talking person",
        lipsyncModelVersion: "v1.6",
        inferenceSteps: 25,
      });
      pipelineId = result.pipelineId;
    });

    it("advances from speech to video stage", () => {
      const { nextJob, done } = handleStageCompletion(pipelineId, "job-tts-1", {
        media_base64: "audio_base64_data",
        media_type: "audio/wav",
      });

      expect(done).toBe(false);
      expect(nextJob).not.toBeNull();
      expect(nextJob!.type).toBe("txt2video");
      expect(nextJob!.payload.pipeline_stage).toBe("video");
      expect(nextJob!.payload.prompt).toBe("A talking person");
      expect(nextJob!.payload.pipeline_id).toBe(pipelineId);
    });

    it("advances from video to lipsync stage with previous outputs", () => {
      // Complete speech stage
      handleStageCompletion(pipelineId, "job-tts-1", {
        media_base64: "audio_data",
        media_type: "audio/wav",
      });

      // Complete video stage
      const { nextJob, done } = handleStageCompletion(
        pipelineId,
        "job-video-1",
        {
          media_base64: "video_data",
          media_type: "video/mp4",
        },
      );

      expect(done).toBe(false);
      expect(nextJob).not.toBeNull();
      expect(nextJob!.type).toBe("lipsync");
      expect(nextJob!.payload.pipeline_stage).toBe("lipsync");
      expect(nextJob!.payload.audio_data).toBe("audio_data");
      expect(nextJob!.payload.video_data).toBe("video_data");
      expect(nextJob!.payload.model_version).toBe("v1.6");
      expect(nextJob!.payload.inference_steps).toBe(25);
    });

    it("completes after lipsync stage", () => {
      // Complete all three stages
      handleStageCompletion(pipelineId, "job-tts-1", {
        media_base64: "audio",
        media_type: "audio/wav",
      });
      handleStageCompletion(pipelineId, "job-video-1", {
        media_base64: "video",
        media_type: "video/mp4",
      });
      const { nextJob, done } = handleStageCompletion(
        pipelineId,
        "job-lipsync-1",
        {
          media_base64: "lipsync_video",
          media_type: "video/mp4",
        },
      );

      expect(done).toBe(true);
      expect(nextJob).toBeNull();
      // Pipeline should be cleaned up
      expect(getPipelineState(pipelineId)).toBeUndefined();
    });

    it("returns done for unknown pipeline", () => {
      const { nextJob, done } = handleStageCompletion(
        "unknown-pipeline",
        "job-1",
        {},
      );
      expect(done).toBe(true);
      expect(nextJob).toBeNull();
    });
  });

  describe("markLipsyncSkipped", () => {
    it("skips lipsync stage when marked", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Test",
      });

      // Complete speech
      handleStageCompletion(pipelineId, "job-tts", {
        media_base64: "audio",
        media_type: "audio/wav",
      });

      // Mark lipsync as skipped
      markLipsyncSkipped(pipelineId);

      // Complete video — should complete pipeline (skip lipsync)
      const { nextJob, done } = handleStageCompletion(pipelineId, "job-video", {
        media_base64: "video",
        media_type: "video/mp4",
      });

      expect(done).toBe(true);
      expect(nextJob).toBeNull();
    });
  });

  describe("handleStageFailure", () => {
    it("cleans up pipeline and returns failed stage", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Test",
      });

      const result = handleStageFailure(pipelineId, "TTS sidecar error");
      expect(result.stage).toBe("speech");
      expect(result.error).toBe("TTS sidecar error");
      expect(getPipelineState(pipelineId)).toBeUndefined();
    });

    it("returns unknown stage for missing pipeline", () => {
      const result = handleStageFailure("missing-pipeline", "error");
      expect(result.stage).toBe("unknown");
    });
  });

  describe("getFinalStageResult", () => {
    it("returns lipsync result when available", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Test",
      });

      // Complete all stages
      handleStageCompletion(pipelineId, "tts", {
        media_base64: "audio",
        media_type: "audio/wav",
      });
      handleStageCompletion(pipelineId, "video", {
        media_base64: "video",
        media_type: "video/mp4",
      });

      // Get state before lipsync completes it
      const state = getPipelineState(pipelineId);
      // Pipeline is now at lipsync stage — add result manually for testing
      if (state) {
        state.stageResults["lipsync"] = {
          media_base64: "lipsync_video",
          media_type: "video/mp4",
        };
        const final = getFinalStageResult(pipelineId, state);
        expect(final?.media_base64).toBe("lipsync_video");
      }
    });

    it("falls back to video result when no lipsync", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Test",
      });

      handleStageCompletion(pipelineId, "tts", {
        media_base64: "audio",
        media_type: "audio/wav",
      });

      const state = getPipelineState(pipelineId);
      if (state) {
        state.stageResults["video"] = {
          media_base64: "video_only",
          media_type: "video/mp4",
        };
        const final = getFinalStageResult(pipelineId, state);
        expect(final?.media_base64).toBe("video_only");
      }
    });
  });

  describe("PIPELINE_STAGES", () => {
    it("has correct stage order", () => {
      expect(PIPELINE_STAGES).toEqual(["speech", "video", "lipsync"]);
    });
  });

  describe("pipeline config defaults", () => {
    it("uses default voice when not specified", () => {
      const { firstJob } = createTalkingHeadPipeline({
        text: "Hello",
      });
      expect(firstJob.payload.voice).toBe("af_heart");
    });

    it("generates video prompt from text when not specified", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "This is a test sentence for lip sync.",
      });

      // Advance to video stage
      const { nextJob } = handleStageCompletion(pipelineId, "tts-1", {
        media_base64: "audio",
        media_type: "audio/wav",
      });

      expect(nextJob!.payload.prompt).toContain("A person speaking");
    });

    it("uses custom video prompt when specified", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Hello",
        videoPrompt: "A news anchor speaking in a studio",
      });

      const { nextJob } = handleStageCompletion(pipelineId, "tts-1", {
        media_base64: "audio",
        media_type: "audio/wav",
      });

      expect(nextJob!.payload.prompt).toBe(
        "A news anchor speaking in a studio",
      );
    });

    it("respects max duration limit", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Hello",
        maxDurationSec: 60, // exceeds 30s cap
      });

      const { nextJob } = handleStageCompletion(pipelineId, "tts-1", {
        media_base64: "audio",
        media_type: "audio/wav",
      });

      expect(nextJob!.payload.video_duration).toBe(30); // capped at 30
    });

    it("passes lipsync config through", () => {
      const { pipelineId } = createTalkingHeadPipeline({
        text: "Hello",
        lipsyncModelVersion: "v1.6",
        inferenceSteps: 30,
        guidanceScale: 2.0,
        enableDeepCache: false,
      });

      // Advance through speech and video
      handleStageCompletion(pipelineId, "tts-1", {
        media_base64: "audio",
        media_type: "audio/wav",
      });
      const { nextJob } = handleStageCompletion(pipelineId, "vid-1", {
        media_base64: "video",
        media_type: "video/mp4",
      });

      expect(nextJob!.payload.model_version).toBe("v1.6");
      expect(nextJob!.payload.inference_steps).toBe(30);
      expect(nextJob!.payload.guidance_scale_lipsync).toBe(2.0);
      expect(nextJob!.payload.enable_deepcache).toBe(false);
    });
  });
});
