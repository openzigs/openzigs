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
  /** F5-TTS clips for voice cloning (pre-resolved from profile) */
  f5ttsClips?: Array<{ emotion: string; ref_audio_path: string; ref_text: string }>;
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
  // ── SadTalker parameters ───────────────────────────────────
  /** Use SadTalker pipeline (image + audio → talking head directly).
   *  When true and referenceImage is set, skips LTX video + LatentSync
   *  and uses SadTalker for the entire video generation. */
  useSadTalker?: boolean;
  /** SadTalker face render size: 256 or 512 (default: 512) */
  sadTalkerSize?: number;
  /** SadTalker preprocess mode: crop|extcrop|resize|full|extfull */
  sadTalkerPreprocess?: string;
  /** SadTalker face enhancer: gfpgan|RestoreFormer|empty for none */
  sadTalkerEnhancer?: string;
  /** SadTalker still mode — reduces head motion for more natural result */
  sadTalkerStill?: boolean;
  /** SadTalker expression scale (0.1–3.0, default: 1.0) */
  sadTalkerExpressionScale?: number;
  /** SadTalker pose style (0–45, default: 0) */
  sadTalkerPoseStyle?: number;
}

export type PipelineStage = "speech" | "video" | "lipsync" | "sadtalker";

/** Classic pipeline: TTS → LTX Video → LatentSync Lipsync */
export const PIPELINE_STAGES_CLASSIC: readonly PipelineStage[] = [
  "speech",
  "video",
  "lipsync",
] as const;

/** SadTalker pipeline: TTS → SadTalker (image + audio → talking head) */
export const PIPELINE_STAGES_SADTALKER: readonly PipelineStage[] = [
  "speech",
  "sadtalker",
] as const;

/** @deprecated Use PIPELINE_STAGES_CLASSIC or PIPELINE_STAGES_SADTALKER */
export const PIPELINE_STAGES = PIPELINE_STAGES_CLASSIC;

export interface PipelineState {
  pipelineId: string;
  config: TalkingHeadPipelineConfig;
  /** Current stage index */
  currentStage: number;
  /** Ordered stages for this pipeline instance */
  stages: readonly PipelineStage[];
  /** Map of stage → completed job ID */
  completedStages: Record<string, string>;
  /** Map of stage → result data (base64 media, file paths, etc.) */
  stageResults: Record<string, { media_base64?: string; media_type?: string; file_path?: string }>;
  /** Whether the lipsync stage should be skipped (sidecar unavailable) */
  skipLipsync: boolean;
  /** Audio duration in seconds (computed after TTS stage completes) */
  audioDurationSec?: number;
}

// ── In-Memory Pipeline Registry ──────────────────────────────

const activePipelines = new Map<string, PipelineState>();

/**
 * Create a new talking-head pipeline. Returns the pipeline ID and the
 * first job configuration (TTS) to be enqueued.
 */
export function createTalkingHeadPipeline(
  config: TalkingHeadPipelineConfig,
): { pipelineId: string; stages: readonly string[]; firstJob: { type: MediaJobType; payload: MediaJobPayload; model: string; targetNode: string } } {
  const pipelineId = `thp-${nanoid(12)}`;

  // Pick pipeline variant: SadTalker (2-stage) or classic (3-stage)
  const useSadTalker = config.useSadTalker !== false && !!config.referenceImage;
  const stages = useSadTalker ? PIPELINE_STAGES_SADTALKER : PIPELINE_STAGES_CLASSIC;

  const state: PipelineState = {
    pipelineId,
    config,
    currentStage: 0,
    stages,
    completedStages: {},
    stageResults: {},
    skipLipsync: false,
  };

  activePipelines.set(pipelineId, state);

  const firstJob = buildStageJob(state, "speech");

  logger.info(
    `[TalkingHeadPipeline] Created pipeline ${pipelineId} (${useSadTalker ? "sadtalker" : "classic"}): text="${config.text.slice(0, 50)}..." voice=${config.voice ?? "default"}`,
  );

  return { pipelineId, stages, firstJob };
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

  const currentStageName = state.stages[state.currentStage];
  state.completedStages[currentStageName] = jobId;
  state.stageResults[currentStageName] = stageResult;

  logger.info(
    `[TalkingHeadPipeline] Pipeline ${pipelineId}: stage "${currentStageName}" complete (job ${jobId})`,
  );

  // Advance to next stage
  state.currentStage++;

  // If we should skip lipsync and that's the next stage, we're done
  if (state.currentStage >= state.stages.length) {
    activePipelines.delete(pipelineId);
    return { nextJob: null, done: true, pipelineId };
  }

  const nextStageName = state.stages[state.currentStage];

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
    ? state.stages[state.currentStage]
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
  // Return the final stage result: sadtalker > lipsync > video
  return state.stageResults["sadtalker"] ?? state.stageResults["lipsync"] ?? state.stageResults["video"];
}

/**
 * Set audio duration on the pipeline state (called after TTS stage completes).
 * Used to determine how many video segments to generate.
 */
export function setAudioDuration(pipelineId: string, durationSec: number): void {
  const state = activePipelines.get(pipelineId);
  if (state) {
    state.audioDurationSec = durationSec;
    logger.info(
      `[TalkingHeadPipeline] Pipeline ${pipelineId}: audio duration = ${durationSec.toFixed(1)}s`,
    );
  }
}

/**
 * Compute duration in seconds from a base64-encoded WAV buffer.
 * Reads the WAV header: sample rate (bytes 24-27), bits per sample (bytes 34-35),
 * channels (bytes 22-23), and data chunk size to compute duration.
 * Returns undefined if the buffer is not a valid WAV.
 */
export function computeWavDuration(base64Wav: string): number | undefined {
  try {
    const buf = Buffer.from(base64Wav, "base64");
    // Minimum WAV header is 44 bytes
    if (buf.length < 44) return undefined;

    // Verify RIFF header
    const riff = buf.toString("ascii", 0, 4);
    const wave = buf.toString("ascii", 8, 12);
    if (riff !== "RIFF" || wave !== "WAVE") return undefined;

    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);

    if (sampleRate === 0 || channels === 0 || bitsPerSample === 0) return undefined;

    // Find the 'data' chunk to get actual audio data size
    let offset = 12; // after "RIFF" + size + "WAVE"
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === "data") {
        const bytesPerSample = bitsPerSample / 8;
        const bytesPerSecond = sampleRate * channels * bytesPerSample;
        return chunkSize / bytesPerSecond;
      }
      offset += 8 + chunkSize;
      // Word-align
      if (chunkSize % 2 !== 0) offset++;
    }

    // Fallback: estimate from total file size minus header
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    return Math.max(0, (buf.length - 44) / bytesPerSecond);
  } catch {
    return undefined;
  }
}

/**
 * Estimate speech duration from text using character-per-second heuristics.
 * Based on research: ~14 CPS for Kokoro, ~12 CPS for F5-TTS, ±20% margin.
 * Returns duration in seconds.
 */
export function estimateSpeechDuration(text: string): number {
  const wordCount = text.trim().split(/\s+/).length;
  // ~150 words per minute = 2.5 words per second
  return Math.max(1, wordCount / 2.5);
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
          f5tts_clips: config.f5ttsClips,
        },
        model: defaultModelForJobType(type),
        targetNode: targetNodeForJobType(type),
      };
    }

    case "video": {
      // Use img2video when a reference image is provided so the worker
      // conditions on the init_image; otherwise fall back to txt2video.
      const type: MediaJobType = config.referenceImage ? "img2video" : "txt2video";
      // Use audio duration when available (audio-first pipeline),
      // otherwise fall back to config max. Round up to nearest 4s for clean segmentation.
      const rawDuration = state.audioDurationSec
        ?? config.maxDurationSec
        ?? 10;
      const cappedDuration = Math.min(rawDuration, 30);
      // Round up to nearest 4s boundary for multi-segment alignment
      const videoDuration = Math.ceil(cappedDuration / 4) * 4;
      return {
        type,
        payload: {
          prompt: config.videoPrompt ?? `A person speaking: "${config.text.slice(0, 100)}"`,
          init_image: config.referenceImage,
          image_strength: config.referenceImage ? 0.85 : undefined,
          model: config.videoModel ?? defaultModelForJobType("txt2video"),
          video_duration: videoDuration,
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

    case "sadtalker": {
      const type: MediaJobType = "sadtalker";
      const speechResult = state.stageResults["speech"];

      return {
        type,
        payload: {
          prompt: "",
          // SadTalker takes reference image + TTS audio → talking head video
          init_image: config.referenceImage,
          audio_data: speechResult?.media_base64,
          audio_path: speechResult?.file_path,
          sadtalker_size: config.sadTalkerSize ?? 512,
          sadtalker_preprocess: config.sadTalkerPreprocess ?? "crop",
          sadtalker_enhancer: config.sadTalkerEnhancer ?? "gfpgan",
          sadtalker_still: config.sadTalkerStill ?? true,
          sadtalker_expression_scale: config.sadTalkerExpressionScale ?? 1.0,
          sadtalker_pose_style: config.sadTalkerPoseStyle ?? 0,
          pipeline_id: pipelineId,
          pipeline_stage: "sadtalker",
          pipeline_type: "talking-head",
        },
        model: "sadtalker",
        targetNode: targetNodeForJobType(type),
      };
    }
  }
}
