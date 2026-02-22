/**
 * Director Mode — Shorts Pipeline Orchestrator
 * Issue #321: End-to-end pipeline: ingest → extract viral clip → dub → build manifest.
 *
 * Converts a long-form horizontal video into a 30–60 second YouTube Short
 * with new voiceover, karaoke captions, and 9:16 vertical framing.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { logger } from "../../logging/logger.js";
import { ingest } from "../ingestion/index.js";
import { extractViralClip } from "./viral-clip-extractor.js";
import { generateShortsVoiceover } from "./shorts-voice-pipeline.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";
import type { DirectorManifest, VideoClipEntry, OverlayEntry } from "../manifest/manifest-types.js";

export interface ShortsPipelineInput {
  /** Path to the source video */
  sourceVideo: string;
  /** Shorts style: react, summarize, or highlight */
  style?: "react" | "summarize" | "highlight";
  /** Target duration in seconds (15–60, default 45) */
  targetDuration?: number;
  /** Voice profile name (optional) */
  voiceProfile?: string;
  /** LLM model override */
  model?: string;
}

export interface ShortsPipelineResult {
  /** The completed DirectorManifest for 9:16 rendering */
  manifest: DirectorManifest;
  /** Viral clip extraction result */
  viralClip: {
    startSeconds: number;
    endSeconds: number;
    rationale: string;
    suggestedHook: string;
  };
  /** Generated voiceover script */
  scriptText: string;
  /** Processing time in ms */
  processingTimeMs: number;
}

/**
 * Run the full Shorts pipeline.
 *
 * 1. Dense ingestion (1 frame/sec) + Whisper transcript
 * 2. LLM viral clip extraction
 * 3. Voiceover script generation + TTS synthesis
 * 4. Build 9:16 DirectorManifest (ContentCreator template)
 */
export async function createShort(
  input: ShortsPipelineInput,
  copilot: CopilotWrapper,
  voiceService: VoiceService,
): Promise<ShortsPipelineResult> {
  const startTime = Date.now();
  const {
    sourceVideo,
    style = "highlight",
    targetDuration = 45,
    model,
  } = input;

  const outputDir = path.join(os.homedir(), ".openzigs", "director", "shorts");
  await fs.mkdir(outputDir, { recursive: true });

  // ── Step 1: Dense Ingestion ─────────────────────────────────
  logger.info(`[ShortsPipeline] Starting dense ingestion: ${sourceVideo}`);

  const ingestionResult = await ingest(
    { clips: [sourceVideo], mode: "highlight" },
    {
      copilot,
      visionAnalysis: { maxKeyframes: 40, delayMs: 1000, model },
      mode: "dense",
      onProgress: (event) => {
        logger.info(`[ShortsPipeline] Ingestion: ${event.phase} — ${event.message}`);
      },
    },
  );

  const clip = ingestionResult.clips[0];
  if (!clip) {
    throw new Error("Ingestion produced no clip analysis");
  }

  logger.info(
    `[ShortsPipeline] Ingested: ${clip.keyframes.length} keyframes, ` +
    `${clip.transcript.length} transcript segments, ${clip.duration.toFixed(1)}s`,
  );

  // ── Step 2: Viral Clip Extraction ───────────────────────────
  logger.info("[ShortsPipeline] Extracting viral clip via LLM…");

  const viralClip = await extractViralClip(clip, copilot, {
    targetDuration,
    style,
    model,
  });

  logger.info(
    `[ShortsPipeline] Viral clip: ${viralClip.startSeconds.toFixed(1)}s → ` +
    `${viralClip.endSeconds.toFixed(1)}s (${(viralClip.endSeconds - viralClip.startSeconds).toFixed(1)}s)`,
  );

  // ── Step 3: Voiceover Generation ────────────────────────────
  logger.info("[ShortsPipeline] Generating voiceover…");

  const voiceResult = await generateShortsVoiceover(
    viralClip,
    clip.transcript,
    clip.duration,
    voiceService,
    copilot,
    { style, model, outputDir },
  );

  // ── Step 4: Build 9:16 Manifest ─────────────────────────────
  logger.info("[ShortsPipeline] Building 9:16 manifest…");

  const fps = 30;
  const clipDuration = viralClip.endSeconds - viralClip.startSeconds;
  const totalFrames = Math.round(clipDuration * fps);
  const trimStartFrame = Math.round(viralClip.startSeconds * fps);

  const videoClip: VideoClipEntry = {
    type: "video_clip",
    source: sourceVideo,
    startAtFrame: 0,
    trimStart: trimStartFrame,
    duration: totalFrames,
    volume: voiceResult.originalAudioVolume,
    horizontalCropOffset: 50, // Center crop; adjustable in Studio
  };

  // Karaoke captions overlay for maximum Short engagement
  const captionsOverlay: OverlayEntry = {
    type: "overlay",
    component: "SmartCaptions",
    props: {
      style: "karaoke",
      fontSize: 56,
      fontColor: "#ffffff",
      position: "bottom",
    },
    startAtFrame: 0,
    duration: totalFrames,
  };

  const manifest: DirectorManifest = {
    projectTitle: `Short — ${viralClip.suggestedHook.slice(0, 60)}`,
    templateId: "ContentCreator",
    composition: {
      width: 1080,
      height: 1920,
      fps,
    },
    audioLayer: {
      music: null,
      voiceover: {
        source: voiceResult.voiceoverPath,
        volume: 1.0,
        startAtFrame: 0,
      },
    },
    timeline: [videoClip, captionsOverlay],
    metadata: {
      generatedAt: new Date().toISOString(),
      llmModel: model ?? "copilot",
      llmTokensUsed: 0,
      productionMode: "highlight",
      sourceClips: [sourceVideo],
      estimatedRenderTime: clipDuration,
    },
  };

  const processingTimeMs = Date.now() - startTime;
  logger.info(`[ShortsPipeline] Complete in ${processingTimeMs}ms`);

  return {
    manifest,
    viralClip: {
      startSeconds: viralClip.startSeconds,
      endSeconds: viralClip.endSeconds,
      rationale: viralClip.rationale,
      suggestedHook: viralClip.suggestedHook,
    },
    scriptText: voiceResult.scriptText,
    processingTimeMs,
  };
}
