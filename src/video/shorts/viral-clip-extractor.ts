/**
 * Director Mode — Viral Clip Extractor
 * Issue #321: LLM-powered identification of the most engaging 30–60s segment
 * from a long-form video using dense vision frames + Whisper transcript.
 */

import { logger } from "../../logging/logger.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { ClipAnalysis, KeyframeInfo } from "../ingestion/types.js";

export interface ViralClipResult {
  startSeconds: number;
  endSeconds: number;
  rationale: string;
  suggestedHook: string;
}

export interface ViralClipOptions {
  targetDuration?: number;
  style?: "react" | "summarize" | "highlight";
  model?: string;
}

/**
 * Use an LLM to identify the most viral/engaging contiguous segment.
 * Sends batched base64 thumbnails + transcript timestamps for analysis.
 */
export async function extractViralClip(
  clip: ClipAnalysis,
  copilot: CopilotWrapper,
  options: ViralClipOptions = {},
): Promise<ViralClipResult> {
  const { targetDuration = 45, style = "highlight", model } = options;

  // Prepare keyframe descriptions (sample up to 40 for context window)
  const sampledFrames = sampleKeyframes(clip.keyframes, 40);
  const frameDescriptions = sampledFrames
    .map((kf, i) => {
      const desc = kf.description ?? `Frame at ${kf.timestamp.toFixed(1)}s`;
      return `  ${i + 1}. [${kf.timestamp.toFixed(1)}s] ${desc}`;
    })
    .join("\n");

  // Prepare transcript segments
  const transcriptText = clip.transcript
    .slice(0, 100) // cap at 100 segments
    .map((seg) => `  [${seg.start} → ${seg.end}] ${seg.speech}`)
    .join("\n");

  const styleInstructions: Record<string, string> = {
    react:
      "Find the most reaction-worthy, surprising, or controversial moment.",
    summarize:
      "Find the segment that best summarizes the core message or key insight.",
    highlight:
      "Find the most visually dynamic, emotionally engaging, or peak-action moment.",
  };

  const prompt = `You are a viral content editor specializing in YouTube Shorts.

SOURCE VIDEO: ${clip.duration.toFixed(1)} seconds total, ${clip.resolution.width}x${clip.resolution.height}

VISUAL KEYFRAMES:
${frameDescriptions}

TRANSCRIPT:
${transcriptText || "  (no speech detected)"}

TASK: Identify the single most engaging contiguous segment of ${targetDuration} seconds (±10s, between 15–60s).
STYLE: ${styleInstructions[style] ?? styleInstructions.highlight}

Requirements:
- The segment must be contiguous (no jump cuts from different parts)
- startSeconds + duration must not exceed ${clip.duration.toFixed(1)}
- Prefer segments with both visual interest AND speech
- AVOID sections that are title cards, intro cards, or outro cards with large text overlays — these crop poorly when converted to 9:16 vertical format
- Write a punchy 1-sentence hook that could open the Short

Respond with ONLY valid JSON (no markdown):
{
  "startSeconds": <number>,
  "endSeconds": <number>,
  "rationale": "<why this segment is engaging>",
  "suggestedHook": "<opening line for the Short>"
}`;

  const chunks: string[] = [];
  const stream = copilot.chat(prompt, {
    tools: [],
    ...(model ? { model } : {}),
  });
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const responseText = chunks.join("");
  const rawJson = responseText
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const startSeconds = Number(parsed.startSeconds);
    const endSeconds = Number(parsed.endSeconds);
    const rationale = String(parsed.rationale ?? "");
    const suggestedHook = String(parsed.suggestedHook ?? "");

    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      endSeconds <= startSeconds
    ) {
      throw new Error("Invalid time range");
    }

    // Clamp to video bounds
    const clampedStart = Math.max(0, startSeconds);
    const clampedEnd = Math.min(clip.duration, endSeconds);
    const duration = clampedEnd - clampedStart;

    if (duration < 10 || duration > 90) {
      logger.warn(
        `[ViralClipExtractor] Duration ${duration.toFixed(1)}s outside expected range — using anyway`,
      );
    }

    return {
      startSeconds: clampedStart,
      endSeconds: clampedEnd,
      rationale,
      suggestedHook,
    };
  } catch (parseErr) {
    logger.warn(
      `[ViralClipExtractor] LLM response could not be parsed — using center segment`,
    );
    // Fallback: take the center segment of target duration
    const center = clip.duration / 2;
    const halfDur = Math.min(targetDuration / 2, clip.duration / 2);
    return {
      startSeconds: Math.max(0, center - halfDur),
      endSeconds: Math.min(clip.duration, center + halfDur),
      rationale: "Fallback: center segment selected due to LLM parse failure",
      suggestedHook: "You won't believe what happens next.",
    };
  }
}

/** Uniformly sample N keyframes from a larger set. */
function sampleKeyframes(
  keyframes: KeyframeInfo[],
  maxCount: number,
): KeyframeInfo[] {
  if (keyframes.length <= maxCount) return keyframes;
  const step = keyframes.length / maxCount;
  const sampled: KeyframeInfo[] = [];
  for (let i = 0; i < maxCount; i++) {
    sampled.push(keyframes[Math.floor(i * step)]);
  }
  return sampled;
}
