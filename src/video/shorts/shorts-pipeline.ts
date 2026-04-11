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
import { getAudioDuration } from "../ingestion/audio-extractor.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";
import type {
  DirectorManifest,
  VideoClipEntry,
  OverlayEntry,
  ImageSceneEntry,
} from "../manifest/manifest-types.js";

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
        logger.info(
          `[ShortsPipeline] Ingestion: ${event.phase} — ${event.message}`,
        );
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

  // ── Step 4b: Generate word-level caption timestamps ─────────
  // Probe voiceover audio duration, then distribute words evenly.
  let captionWords: Array<{ word: string; start: number; end: number }> = [];
  try {
    const voDurationSec = await getAudioDuration(voiceResult.voiceoverPath);
    const voDurationFrames =
      voDurationSec > 0 ? Math.round(voDurationSec * fps) : totalFrames;
    captionWords = estimateWordTimings(
      voiceResult.scriptText,
      voDurationFrames,
    );
    logger.info(
      `[ShortsPipeline] Generated ${captionWords.length} caption word timings over ${voDurationSec.toFixed(1)}s`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[ShortsPipeline] Could not probe voiceover duration — using clip duration: ${msg}`,
    );
    captionWords = estimateWordTimings(voiceResult.scriptText, totalFrames);
  }

  // ── Step 4c: Split into per-sentence scenes ─────────────────
  // Each sentence becomes its own scene so the user can individually
  // adjust framing, swap images, or edit each scene in the Studio timeline.
  //
  // When the source video was rendered by our system, use the ORIGINAL images
  // from the source manifest's image_scene entries. This avoids baked-in text
  // overlays and title cards that clip poorly in 9:16 crop mode.
  const sentences = splitIntoSentences(voiceResult.scriptText);
  const sourceManifest = await loadSourceManifest(sourceVideo);
  const viralFrameEnd = trimStartFrame + totalFrames;

  // Try to resolve original images from source manifest
  const imageMap = sourceManifest
    ? await resolveSourceImages(sourceManifest, trimStartFrame, viralFrameEnd)
    : null;

  const sceneEntries: Array<VideoClipEntry | ImageSceneEntry> = [];

  if (imageMap && imageMap.length > 0) {
    // ── Image-based path: use original images without baked-in overlays ───
    logger.info(
      `[ShortsPipeline] Using ${imageMap.length} original source image(s) — text overlays stripped`,
    );

    if (sentences.length > 1) {
      const totalChars = sentences.reduce((n, s) => n + s.length, 0);
      let compositionFrame = 0;
      let imageIdx = 0;

      for (const sentence of sentences) {
        const fraction = sentence.length / totalChars;
        const sceneDuration = Math.max(fps, Math.round(totalFrames * fraction));
        const actualDur = Math.min(
          sceneDuration,
          totalFrames - compositionFrame,
        );
        if (actualDur <= 0) break;

        // Cycle through available images (round-robin if more sentences than images)
        const image = imageMap[imageIdx % imageMap.length];
        imageIdx++;

        sceneEntries.push({
          type: "image_scene",
          src: image.src,
          startAtFrame: compositionFrame,
          duration: actualDur,
          scriptText: sentence,
          kenBurns: {
            scaleFrom: 1.0,
            scaleTo: 1.15,
            translateXFrom: imageIdx % 2 === 0 ? 0 : -5,
            translateXTo: imageIdx % 2 === 0 ? -10 : 5,
            translateYFrom: 0,
            translateYTo: -5,
          },
        });
        compositionFrame += actualDur;
      }
    }

    // Fallback: single scene
    if (sceneEntries.length === 0) {
      sceneEntries.push({
        type: "image_scene",
        src: imageMap[0].src,
        startAtFrame: 0,
        duration: totalFrames,
        scriptText: voiceResult.scriptText,
        kenBurns: { scaleFrom: 1.0, scaleTo: 1.15 },
      });
    }
  } else {
    // ── Video-clip path: use rendered video with title card skip logic ─────
    const usableRanges = sourceManifest
      ? buildUsableRanges(sourceManifest, trimStartFrame, viralFrameEnd)
      : [{ start: trimStartFrame, end: viralFrameEnd }];

    if (sourceManifest) {
      const totalUsable = usableRanges.reduce(
        (s, r) => s + (r.end - r.start),
        0,
      );
      const skipped = totalFrames - totalUsable;
      if (skipped > 0) {
        logger.info(
          `[ShortsPipeline] Skipping ${skipped} title-card frames ` +
            `(${(skipped / fps).toFixed(1)}s) — ${usableRanges.length} usable range(s)`,
        );
      }
    }

    if (sentences.length > 1) {
      const totalChars = sentences.reduce((n, s) => n + s.length, 0);
      let compositionFrame = 0;
      let logicalFrame = 0;

      for (const sentence of sentences) {
        const fraction = sentence.length / totalChars;
        const sceneDuration = Math.max(fps, Math.round(totalFrames * fraction));
        const actualDur = Math.min(
          sceneDuration,
          totalFrames - compositionFrame,
        );
        if (actualDur <= 0) break;

        const subClips = mapFrameRangeToClips(
          logicalFrame,
          actualDur,
          usableRanges,
        );
        for (const sub of subClips) {
          sceneEntries.push({
            type: "video_clip",
            source: sourceVideo,
            startAtFrame: compositionFrame,
            trimStart: sub.trimStart,
            duration: sub.duration,
            volume: voiceResult.originalAudioVolume,
            horizontalCropOffset: 50,
            fitMode: "cover",
            scriptText: sentence,
          });
          compositionFrame += sub.duration;
        }
        logicalFrame += actualDur;
      }
    }

    // Fallback: single clip
    if (sceneEntries.length === 0) {
      sceneEntries.push({
        type: "video_clip",
        source: sourceVideo,
        startAtFrame: 0,
        trimStart: trimStartFrame,
        duration: totalFrames,
        volume: voiceResult.originalAudioVolume,
        horizontalCropOffset: 50,
        fitMode: "cover",
        scriptText: voiceResult.scriptText,
      });
    }
  }
  logger.info(`[ShortsPipeline] Split into ${sceneEntries.length} scene(s)`);

  // Karaoke captions overlay for maximum Short engagement
  const captionsOverlay: OverlayEntry = {
    type: "overlay",
    component: "SmartCaptions",
    props: {
      words: captionWords,
      style: "karaoke",
      fontSize: 80,
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
    timeline: [...sceneEntries, captionsOverlay],
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

/**
 * Try to load the manifest that produced a source video (stored alongside renders).
 */
async function loadSourceManifest(
  sourceVideo: string,
): Promise<DirectorManifest | null> {
  try {
    const manifestPath = path.join(path.dirname(sourceVideo), "manifest.json");
    const data = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(data) as DirectorManifest;
  } catch {
    return null;
  }
}

/**
 * Extract image_scene entries from the source manifest that overlap the viral clip's
 * frame range, returning only those whose original image files still exist on disk.
 * Returns null if the manifest has no image_scene entries or none overlap.
 */
async function resolveSourceImages(
  manifest: DirectorManifest,
  clipStart: number,
  clipEnd: number,
): Promise<Array<{ src: string; start: number; end: number }> | null> {
  const imageScenes: Array<{ src: string; start: number; end: number }> = [];

  for (const entry of manifest.timeline) {
    if (entry.type !== "image_scene") continue;
    const entryEnd = entry.startAtFrame + entry.duration;
    // Check for overlap with the viral clip range
    if (entryEnd <= clipStart || entry.startAtFrame >= clipEnd) continue;
    imageScenes.push({
      src: entry.src,
      start: entry.startAtFrame,
      end: entryEnd,
    });
  }

  if (imageScenes.length === 0) return null;

  // Verify all image files still exist on disk
  const verified: Array<{ src: string; start: number; end: number }> = [];
  for (const scene of imageScenes) {
    try {
      await fs.access(scene.src);
      verified.push(scene);
    } catch {
      logger.warn(
        `[ShortsPipeline] Source image missing, skipping: ${scene.src}`,
      );
    }
  }

  return verified.length > 0 ? verified : null;
}

/**
 * Compute usable (non-title/intro/outro card) frame ranges within a clip range.
 * Also skips adjacent transition frames where card text is partially visible
 * due to crossfade blending in the source video.
 */
function buildUsableRanges(
  manifest: DirectorManifest,
  clipStart: number,
  clipEnd: number,
): Array<{ start: number; end: number }> {
  // Collect all card entries
  const cardRanges: Array<{ start: number; end: number }> = [];
  for (const entry of manifest.timeline) {
    if (
      entry.type === "title_card" ||
      entry.type === "intro_card" ||
      entry.type === "outro_card"
    ) {
      cardRanges.push({
        start: entry.startAtFrame,
        end: entry.startAtFrame + entry.duration,
      });
    }
  }

  // Extend each card range by any adjacent transition duration (crossfade bleed)
  for (const entry of manifest.timeline) {
    if (entry.type !== "transition") continue;
    const transEnd = entry.startAtFrame + (entry.duration ?? 15);
    for (const card of cardRanges) {
      // Transition just before or overlapping card start
      if (
        Math.abs(entry.startAtFrame - card.start) <= 1 ||
        Math.abs(transEnd - card.start) <= 1
      ) {
        card.start = Math.min(card.start, entry.startAtFrame);
      }
      // Transition just after or overlapping card end
      if (
        Math.abs(entry.startAtFrame - card.end) <= 1 ||
        Math.abs(transEnd - card.end) <= 1
      ) {
        card.end = Math.max(card.end, transEnd);
      }
    }
  }

  // Clip to our range and sort
  const clipped = cardRanges
    .map((r) => ({
      start: Math.max(r.start, clipStart),
      end: Math.min(r.end, clipEnd),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  // Merge overlapping ranges
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of clipped) {
    if (merged.length > 0 && r.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(
        merged[merged.length - 1].end,
        r.end,
      );
    } else {
      merged.push({ ...r });
    }
  }

  // Build usable gaps between card ranges
  const usable: Array<{ start: number; end: number }> = [];
  let cursor = clipStart;
  for (const card of merged) {
    if (card.start > cursor) {
      usable.push({ start: cursor, end: card.start });
    }
    cursor = Math.max(cursor, card.end);
  }
  if (cursor < clipEnd) {
    usable.push({ start: cursor, end: clipEnd });
  }
  return usable;
}

/**
 * Map a logical frame range to one or more source clip segments, splitting
 * at title card boundaries so rendered clips never show baked-in text overlays.
 */
function mapFrameRangeToClips(
  logicalStart: number,
  logicalDuration: number,
  usableRanges: Array<{ start: number; end: number }>,
): Array<{ trimStart: number; duration: number }> {
  const clips: Array<{ trimStart: number; duration: number }> = [];
  let remaining = logicalDuration;

  // Find which usable range contains logicalStart
  let rangeOffset = 0;
  let rangeIdx = 0;
  for (; rangeIdx < usableRanges.length; rangeIdx++) {
    const len = usableRanges[rangeIdx].end - usableRanges[rangeIdx].start;
    if (rangeOffset + len > logicalStart) break;
    rangeOffset += len;
  }

  while (remaining > 0 && rangeIdx < usableRanges.length) {
    const range = usableRanges[rangeIdx];
    const posInRange =
      logicalStart + (logicalDuration - remaining) - rangeOffset;
    const available = range.end - range.start - posInRange;
    const take = Math.min(remaining, available);

    if (take > 0) {
      clips.push({ trimStart: range.start + posInRange, duration: take });
    }

    remaining -= take;
    rangeOffset += range.end - range.start;
    rangeIdx++;
  }

  // If usable frames exhausted, extend the last clip beyond the clip range
  if (remaining > 0 && clips.length > 0) {
    clips[clips.length - 1].duration += remaining;
  } else if (remaining > 0) {
    // Fallback: no usable ranges matched, use raw start
    const fallbackStart =
      usableRanges.length > 0
        ? usableRanges[usableRanges.length - 1].end
        : logicalStart;
    clips.push({ trimStart: fallbackStart, duration: remaining });
  }

  return clips;
}

/**
 * Estimate word-level frame timestamps by distributing words proportionally
 * across the total voiceover duration. Longer words get slightly more time.
 * Strips pacing directives (e.g. [PAUSE: 0.5s]) and emphasis markers (*word*).
 */
function estimateWordTimings(
  scriptText: string,
  totalFrames: number,
): Array<{ word: string; start: number; end: number }> {
  // Strip pacing directives like [PAUSE: 0.5s] and emphasis markers
  const cleaned = scriptText
    .replace(/\[PAUSE:\s*[\d.]+s?\]/gi, "")
    .replace(/\*/g, "");

  const rawWords = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (rawWords.length === 0) return [];

  // Weight each word by character length (longer words = more time).
  // Two-pass: first compute raw durations, then normalise so the total
  // exactly equals totalFrames (avoiding the overshoot caused by the
  // per-word minimum floor).
  const totalChars = rawWords.reduce((sum, w) => sum + w.length, 0);
  const MIN_FRAMES = 4; // ~133 ms at 30 fps

  // First pass: raw durations with a floor
  const rawDurations = rawWords.map((w) =>
    Math.max(MIN_FRAMES, Math.round(totalFrames * (w.length / totalChars))),
  );
  const rawTotal = rawDurations.reduce((a, b) => a + b, 0);

  // Second pass: scale durations so they sum to exactly totalFrames
  const scale = totalFrames / rawTotal;
  const durations = rawDurations.map((d) =>
    Math.max(MIN_FRAMES, Math.round(d * scale)),
  );

  // Distribute any residual rounding error into the last word
  const durSum = durations.reduce((a, b) => a + b, 0);
  durations[durations.length - 1] += totalFrames - durSum;

  const results: Array<{ word: string; start: number; end: number }> = [];
  let currentFrame = 0;

  for (let i = 0; i < rawWords.length; i++) {
    const endFrame = Math.min(currentFrame + durations[i], totalFrames);
    results.push({ word: rawWords[i], start: currentFrame, end: endFrame });
    currentFrame = endFrame;
  }

  return results;
}

/**
 * Split narration script text into sentences for per-scene segmentation.
 * Handles common abbreviations and pacing directives.
 */
function splitIntoSentences(text: string): string[] {
  // Strip pacing directives for splitting, but preserve text
  const cleaned = text
    .replace(/\[PAUSE:\s*[\d.]+s?\]/gi, "")
    .replace(/\*/g, "");
  // Split on sentence-ending punctuation followed by whitespace
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Merge very short fragments (< 20 chars) with the previous sentence
  const merged: string[] = [];
  for (const s of sentences) {
    if (merged.length > 0 && s.length < 20) {
      merged[merged.length - 1] += " " + s;
    } else {
      merged.push(s);
    }
  }
  return merged.length > 0 ? merged : [text];
}
