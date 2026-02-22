/**
 * Director Mode — Shorts Voice Pipeline
 * Issue #321: LLM script generation + TTS + audio ducking for Shorts.
 *
 * 1. LLM writes a punchy script summarizing/reacting to the viral clip
 * 2. Script → PacingTranslator → VoiceService.synthesize() → TTS audio
 * 3. Returns voiceover path and ducked original volume for the manifest
 */

import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { logger } from "../../logging/logger.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";
import type { TranscriptSegment } from "../ingestion/types.js";
import type { ViralClipResult } from "./viral-clip-extractor.js";

export interface ShortsVoiceResult {
  /** Path to the generated voiceover WAV/MP3 */
  voiceoverPath: string;
  /** The generated script text */
  scriptText: string;
  /** Recommended volume for the original video audio (ducked) */
  originalAudioVolume: number;
}

export interface ShortsVoiceOptions {
  style?: "react" | "summarize" | "highlight";
  voiceProfile?: string;
  model?: string;
  outputDir: string;
}

/**
 * Generate a voiceover script via LLM, synthesize it, and return audio config.
 */
export async function generateShortsVoiceover(
  viralClip: ViralClipResult,
  transcript: TranscriptSegment[],
  _clipDuration: number,
  voiceService: VoiceService,
  copilot: CopilotWrapper,
  options: ShortsVoiceOptions,
): Promise<ShortsVoiceResult> {
  const { style = "highlight", model, outputDir } = options;

  // Filter transcript to the viral clip window
  const clipTranscript = filterTranscriptToWindow(
    transcript,
    viralClip.startSeconds,
    viralClip.endSeconds,
  );

  const transcriptText = clipTranscript.length > 0
    ? clipTranscript.map((s) => s.speech).join(" ")
    : "(no speech in selected segment)";

  const segmentDuration = viralClip.endSeconds - viralClip.startSeconds;

  const styleInstructions: Record<string, string> = {
    react: "Write an energetic, reaction-style commentary. Be expressive and opinionated.",
    summarize: "Write a clear, concise summary. Focus on the key insight or takeaway.",
    highlight: "Write engaging narration that builds excitement. Highlight the most impressive moments.",
  };

  const prompt = `You are a YouTube Shorts voiceover writer. Write a punchy, fast-paced script for a ${segmentDuration.toFixed(0)}-second Short.

HOOK (suggested opening): "${viralClip.suggestedHook}"
CONTEXT: "${viralClip.rationale}"

ORIGINAL TRANSCRIPT FROM THIS SEGMENT:
${transcriptText}

STYLE: ${styleInstructions[style] ?? styleInstructions.highlight}

Requirements:
- Script MUST be speakable in under ${segmentDuration.toFixed(0)} seconds
- Open with the hook (or a variation of it)
- Use [PAUSE: 0.5s] for dramatic pauses between key points
- Use *emphasis* on key words for TTS emphasis
- Keep it under 120 words (Shorts need to be snappy)
- Do NOT include stage directions or speaker labels

Respond with ONLY the script text (no JSON, no markdown).`;

  const chunks: string[] = [];
  const stream = copilot.chat(prompt, {
    tools: [],
    ...(model ? { model } : {}),
  });
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const scriptText = chunks.join("").trim();
  logger.info(`[ShortsVoice] Generated script: ${scriptText.length} chars`);

  // Synthesize TTS
  await fs.mkdir(outputDir, { recursive: true });

  if (!voiceService.isReady()) {
    await voiceService.initialize();
  }

  const voiceoverPath = path.join(outputDir, `shorts-vo-${nanoid(8)}.mp3`);
  const ttsResult = await voiceService.synthesize(scriptText);
  await fs.writeFile(voiceoverPath, ttsResult.audio);

  logger.info(`[ShortsVoice] Voiceover synthesized: ${voiceoverPath}`);

  return {
    voiceoverPath,
    scriptText,
    originalAudioVolume: 0.1, // Duck original audio to 10%
  };
}

/**
 * Filter transcript segments to those overlapping a time window.
 */
function filterTranscriptToWindow(
  transcript: TranscriptSegment[],
  startSec: number,
  endSec: number,
): TranscriptSegment[] {
  return transcript.filter((seg) => {
    const segStart = parseTimestamp(seg.start);
    const segEnd = parseTimestamp(seg.end);
    return segEnd > startSec && segStart < endSec;
  });
}

/**
 * Parse "HH:MM:SS.mmm" timestamp to seconds.
 */
function parseTimestamp(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(ts) || 0;
}
