/**
 * Talking-Head Pipeline Orchestration
 * Issue #802: TTS → Video → Lip Sync multi-stage pipeline.
 *
 * Chains three sidecar calls: F5-TTS (audio) → LTX (video) → LatentSync (lip sync)
 * with memory coordination between LTX and LatentSync on the shared M2 Pro.
 */

import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import type {
  MediaJobPayload,
  MediaJobType,
} from "./types.js";
import {
  targetNodeForJobType,
  defaultModelForJobType,
} from "./types.js";

// ── Pipeline Types ───────────────────────────────────────────

export interface TalkingHeadPipelineConfig {
  /** Text to speak */
  text: string;
  /** Voice name for TTS (default: "af_heart") */
  voice?: string;
  /** Reference audio for voice cloning (base64 or path) */
  referenceAudio?: string;
  /** Prompt for video generation */
  videoPrompt?: string;
  /** Reference image for video (base64) */
  referenceImage?: string;
  /** LTX model to use (default: "ltx-2") */
  videoModel?: string;
  /** LatentSync model version: "v1.5" or "v1.6" */
  lipsyncModelVersion?: string;
  /** LatentSync inference steps (default: 20) */
  inferenceSteps?: number;
  /** LatentSync guidance scale (default: 1.5) */
  guidanceScale?: number;
  /** Enable DeepCache (default: true) */
  enableDeepCache?: boolean;
  /** Max video duration in seconds (default: 10) */
  maxDurationSec?: number;
  /** Project ID for grouping */
  projectId?: string;
  /** Job priority */
  priority?: number;
}

export type PipelineStage = "speech" | "video" | "lipsync";

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  "speech",
  "video",
  "lipsync",
] as const;

export interface PipelineState {
  pipelineId: string;
  config: TalkingHeadPipelineConfig;
  /** Current stage index */
  currentStage: number;
  /** Map of stage → completed job ID */
  completedStages: Record<string, string>;
  /** Map of stage → result data (base64 media, file paths, etc.) */
  stageResults: Record<string, { media_base64?: string; media_type?: string; file_path?: string }>;
  /** Whether the lipsync stage should be skipped (sidecar unavailable) */
  skipLipsync: boolean;
}

// ── In-Memory Pipeline Registry ──────────────────────────────

const activePipelines = new Map<string, PipelineState>();

/**
 * Create a new talking-head pipeline. Returns the pipeline ID and the
 * first job configuration (TTS) to be enqueued.
 */
export function createTalkingHeadPipeline(
  config: TalkingHeadPipelineConfig,
): { pipelineId: string; firstJob: { type: MediaJobType; payload: MediaJobPayload; model: string; targetNode: string } } {
  const pipelineId = `thp-${nanoid(12)}`;

  const state: PipelineState = {
    pipelineId,
    config,
    currentStage: 0,
    completedStages: {},
    stageResults: {},
    skipLipsync: false,
  };

  activePipelines.set(pipelineId, state);

  const firstJob = buildStageJob(state, "speech");

  logger.info(
    `[TalkingHeadPipeline] Created pipeline ${pipelineId}: text="${config.text.slice(0, 50)}..." voice=${config.voice ?? "default"}`,
  );

  return { pipelineId, firstJob };
}

/**
 * Handle a stage completion. Returns the next job to enqueue, or null if the pipeline is done.
 */
export function handleStageCompletion(
  pipelineId: string,
  jobId: string,
  stageResult: { media_base64?: string; media_type?: string; file_path?: string },
): { nextJob: { type: MediaJobType; payload: MediaJobPayload; model: string; targetNode: string } | null; done: boolean; pipelineId: string } {
  const state = activePipelines.get(pipelineId);
  if (!state) {
    logger.warn(`[TalkingHeadPipeline] Unknown pipeline: ${pipelineId}`);
    return { nextJob: null, done: true, pipelineId };
  }

  const currentStageName = PIPELINE_STAGES[state.currentStage];
  state.completedStages[currentStageName] = jobId;
  state.stageResults[currentStageName] = stageResult;

  logger.info(
    `[TalkingHeadPipeline] Pipeline ${pipelineId}: stage "${currentStageName}" complete (job ${jobId})`,
  );

  // Advance to next stage
  state.currentStage++;

  // If we should skip lipsync and that's the next stage, we're done
  if (state.currentStage >= PIPELINE_STAGES.length) {
    activePipelines.delete(pipelineId);
    return { nextJob: null, done: true, pipelineId };
  }

  const nextStageName = PIPELINE_STAGES[state.currentStage];

  // Skip lipsync if marked
  if (nextStageName === "lipsync" && state.skipLipsync) {
    logger.info(
      `[TalkingHeadPipeline] Pipeline ${pipelineId}: skipping lipsync (sidecar unavailable)`,
    );
    activePipelines.delete(pipelineId);
    return { nextJob: null, done: true, pipelineId };
  }

  const nextJob = buildStageJob(state, nextStageName);
  return { nextJob, done: false, pipelineId };
}

/**
 * Mark the lipsync stage as skipped for a pipeline (sidecar unavailable).
 */
export function markLipsyncSkipped(pipelineId: string): void {
  const state = activePipelines.get(pipelineId);
  if (state) {
    state.skipLipsync = true;
  }
}

/**
 * Handle a stage failure. Cleans up the pipeline and returns the failed stage.
 */
export function handleStageFailure(
  pipelineId: string,
  error: string,
): { stage: string; error: string } {
  const state = activePipelines.get(pipelineId);
  const stage = state
    ? PIPELINE_STAGES[state.currentStage]
    : "unknown";
  activePipelines.delete(pipelineId);
  logger.warn(
    `[TalkingHeadPipeline] Pipeline ${pipelineId} failed at stage "${stage}": ${error}`,
  );
  return { stage, error };
}

/**
 * Get the current pipeline state (for progress reporting).
 */
export function getPipelineState(pipelineId: string): PipelineState | undefined {
  return activePipelines.get(pipelineId);
}

/**
 * Get the final result of a completed pipeline.
 * Returns the last stage's result (lipsync if available, otherwise video).
 */
export function getFinalStageResult(
  _pipelineId: string,
  state: PipelineState,
): { media_base64?: string; media_type?: string; file_path?: string } | undefined {
  // Return lipsync result if available, otherwise video
  return state.stageResults["lipsync"] ?? state.stageResults["video"];
}

// ── Internal Helpers ─────────────────────────────────────────

function buildStageJob(
  state: PipelineState,
  stage: PipelineStage,
): { type: MediaJobType; payload: MediaJobPayload; model: string; targetNode: string } {
  const { config, pipelineId } = state;

  switch (stage) {
    case "speech": {
      const type: MediaJobType = "tts";
      return {
        type,
        payload: {
          prompt: config.text,
          voice: config.voice ?? "af_heart",
          pipeline_id: pipelineId,
          pipeline_stage: "speech",
          pipeline_type: "talking-head",
          reference_audio: config.referenceAudio,
        },
        model: defaultModelForJobType(type),
        targetNode: targetNodeForJobType(type),
      };
    }

    case "video": {
      const type: MediaJobType = "txt2video";
      return {
        type,
        payload: {
          prompt: config.videoPrompt ?? `A person speaking: "${config.text.slice(0, 100)}"`,
          init_image: config.referenceImage,
          model: config.videoModel ?? defaultModelForJobType("txt2video"),
          video_duration: Math.min(config.maxDurationSec ?? 10, 30),
          pipeline_id: pipelineId,
          pipeline_stage: "video",
          pipeline_type: "talking-head",
        },
        model: config.videoModel ?? defaultModelForJobType("txt2video"),
        targetNode: targetNodeForJobType(type),
      };
    }

    case "lipsync": {
      const type: MediaJobType = "lipsync";
      // Get audio and video from previous stage results
      const speechResult = state.stageResults["speech"];
      const videoResult = state.stageResults["video"];

      return {
        type,
        payload: {
          prompt: "",
          audio_data: speechResult?.media_base64,
          audio_path: speechResult?.file_path,
          video_data: videoResult?.media_base64,
          video_path: videoResult?.file_path,
          model_version: config.lipsyncModelVersion ?? "v1.5",
          inference_steps: config.inferenceSteps ?? 20,
          guidance_scale_lipsync: config.guidanceScale ?? 1.5,
          enable_deepcache: config.enableDeepCache ?? true,
          pipeline_id: pipelineId,
          pipeline_stage: "lipsync",
          pipeline_type: "talking-head",
        },
        model: defaultModelForJobType(type),
        targetNode: targetNodeForJobType(type),
      };
    }
  }
}
