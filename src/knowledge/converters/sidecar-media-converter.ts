/**
 * Sidecar Media Converter — transcribes audio/video files via the local Audio Sidecar.
 *
 * Issue #262: Video/Audio Ingestion Pipeline
 *
 * Uses the audio sidecar (Whisper on Apple Silicon via MLX) for transcription
 * instead of whisper-node, providing:
 * - Faster transcription on Apple Silicon (MPS acceleration)
 * - Segment-level timestamps with precise boundaries
 * - No local whisper model download required (sidecar manages models)
 *
 * For video files, additionally extracts keyframes via ffmpeg and describes
 * them using Copilot SDK vision (GPT-5 mini) — no Ollama/VLM required.
 *
 * Falls back to the existing whisper-node media converter if the sidecar
 * is unreachable.
 *
 * Pipeline:
 *   Audio: ffmpeg (extract audio) → POST /transcribe to sidecar → markdown with timestamps
 *   Video: ffmpeg (extract audio + keyframes) → sidecar transcribe + Copilot vision → combined markdown
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { ConverterRegistration } from "./types.js";
import type { CopilotWrapper, SdkAttachment } from "../../copilot/copilot-wrapper.js";
import { logger } from "../../logging/logger.js";

const execFileAsync = promisify(execFile);

const MEDIA_EXTENSIONS = [".mp4", ".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac"];

/** Extensions that could contain video streams. */
const VIDEO_CAPABLE_EXTENSIONS = new Set([".mp4", ".webm"]);

/** Default keyframe extraction interval in seconds. */
const KEYFRAME_INTERVAL_SECONDS = 10;

/** Maximum keyframes to extract per video. */
const DEFAULT_MAX_KEYFRAMES = 20;

/** Maximum frames to send in a single vision batch request. */
const VISION_BATCH_SIZE = 10;

/** Check whether ffmpeg is reachable on PATH. */
async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Check whether the audio sidecar is reachable. */
async function sidecarAvailable(sidecarUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${sidecarUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Format seconds to HH:MM:SS.mmm */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
  }
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * Check whether a media file contains a video stream using ffprobe.
 * Returns false for audio-only files (.mp3, .wav, .m4a, etc.).
 */
export async function hasVideoStream(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_CAPABLE_EXTENSIONS.has(ext)) return false;

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      filePath,
    ]);
    return stdout.trim() === "video";
  } catch {
    return false;
  }
}

/** Info about an extracted keyframe image. */
export type ExtractedKeyframe = {
  /** Absolute path to the extracted JPEG. */
  framePath: string;
  /** Timestamp in seconds where this frame was extracted. */
  timestamp: number;
};

/**
 * Extract keyframes from a video at regular intervals using ffmpeg.
 * Returns an array of extracted frame paths + timestamps.
 * Caller is responsible for cleaning up the temp directory.
 */
export async function extractKeyframes(
  filePath: string,
  options: { intervalSeconds?: number; maxFrames?: number } = {},
): Promise<{ frames: ExtractedKeyframe[]; tempDir: string }> {
  const interval = options.intervalSeconds ?? KEYFRAME_INTERVAL_SECONDS;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_KEYFRAMES;

  const tempDir = path.join(os.tmpdir(), `openzigs-keyframes-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const outputPattern = path.join(tempDir, "frame_%04d.jpg");

  // Extract frames at the specified interval
  await execFileAsync("ffmpeg", [
    "-i", filePath,
    "-vf", `fps=1/${interval}`,
    "-q:v", "2",
    "-frames:v", String(maxFrames),
    "-y",
    outputPattern,
  ]);

  // Read extracted frames and compute timestamps
  const files = await fs.readdir(tempDir);
  const frameFiles = files
    .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
    .sort();

  const frames: ExtractedKeyframe[] = frameFiles.map((f, i) => ({
    framePath: path.join(tempDir, f),
    timestamp: i * interval,
  }));

  return { frames, tempDir };
}

/**
 * Build a vision prompt for batch keyframe description.
 * Adapted from Director Mode's keyframe-analyzer pattern.
 */
function buildKeyframeVisionPrompt(labels: string[]): string {
  const listing = labels.map((l, i) => `  ${i + 1}. ${l}`).join("\n");
  return `You are analyzing ${labels.length} keyframe images from a video being ingested into a knowledge base.

For EACH attached image, write a 1-2 sentence description of what is visible.

Focus on:
- Key subjects (people, objects, text, diagrams, code on screen)
- Composition (close-up, wide shot, screen recording, presentation slide)
- Any readable text or data shown

FORMAT: Respond with EXACTLY one line per image, prefixed by its number.
Do NOT add any preamble, headers, or extra text.

Images (in order):
${listing}

Now describe all ${labels.length} images:`;
}

/**
 * Parse a numbered-list response from the batch vision call.
 * Returns descriptions aligned 1:1 with the input frames.
 */
export function parseVisionBatchResponse(raw: string, expectedCount: number): string[] {
  const results: string[] = new Array(expectedCount).fill("");
  const linePattern = /^(\d+)[.):-]\s*/;
  const lines = raw.split("\n");

  let currentIndex = -1;
  let currentParts: string[] = [];

  const flush = () => {
    if (currentIndex >= 0 && currentIndex < expectedCount) {
      results[currentIndex] = currentParts.join(" ").trim();
    }
    currentParts = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(linePattern);
    if (match) {
      flush();
      currentIndex = parseInt(match[1], 10) - 1;
      currentParts.push(trimmed.replace(linePattern, ""));
    } else if (currentIndex >= 0) {
      currentParts.push(trimmed);
    }
  }
  flush();

  return results;
}

/**
 * Describe keyframe images using the Copilot SDK vision.
 * Sends frames in batches to limit token usage per request.
 */
async function describeKeyframes(
  frames: ExtractedKeyframe[],
  copilot: CopilotWrapper,
): Promise<string[]> {
  const allDescriptions: string[] = new Array(frames.length).fill("");

  for (let batchStart = 0; batchStart < frames.length; batchStart += VISION_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + VISION_BATCH_SIZE, frames.length);
    const batch = frames.slice(batchStart, batchEnd);

    const attachments: SdkAttachment[] = [];
    const labels: string[] = [];

    for (const frame of batch) {
      const label = `frame at ${formatTimestamp(frame.timestamp)}`;
      labels.push(label);
      attachments.push({
        type: "file",
        path: frame.framePath,
        displayName: label,
      });
    }

    const prompt = buildKeyframeVisionPrompt(labels);

    try {
      const chunks: string[] = [];
      const stream = copilot.chat(prompt, { tools: [], attachments });

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const raw = chunks.join("").trim();
      const batchDescriptions = parseVisionBatchResponse(raw, batch.length);

      for (let i = 0; i < batchDescriptions.length; i++) {
        allDescriptions[batchStart + i] = batchDescriptions[i];
      }

      logger.info(
        `[SidecarMedia] Described keyframes ${batchStart + 1}-${batchEnd} of ${frames.length}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[SidecarMedia] Vision batch failed (${msg}), skipping frames ${batchStart + 1}-${batchEnd}`);
    }
  }

  return allDescriptions;
}

export type SidecarMediaConverterOptions = {
  /** Audio sidecar URL (default: http://localhost:5006) */
  sidecarUrl?: string;
  /** CopilotWrapper for vision-based keyframe description (video files). */
  copilot?: CopilotWrapper;
  /** Maximum keyframes to extract per video (default: 20). */
  maxKeyframes?: number;
  /** Keyframe extraction interval in seconds (default: 10). */
  keyframeIntervalSeconds?: number;
};

/**
 * Create a media converter that uses the audio sidecar for STT.
 * Requires ffmpeg on PATH and a reachable audio sidecar.
 * Optionally uses Copilot SDK vision for video keyframe description.
 */
export async function createSidecarMediaConverter(
  options: SidecarMediaConverterOptions = {},
): Promise<ConverterRegistration> {
  const sidecarUrl = (options.sidecarUrl ?? "http://localhost:5006").replace(/\/$/, "");
  const copilot = options.copilot;
  const maxKeyframes = options.maxKeyframes ?? DEFAULT_MAX_KEYFRAMES;
  const keyframeInterval = options.keyframeIntervalSeconds ?? KEYFRAME_INTERVAL_SECONDS;
  const hasFFmpeg = await ffmpegAvailable();

  if (!hasFFmpeg) {
    return {
      name: "media-sidecar",
      extensions: MEDIA_EXTENSIONS,
      available: false,
      unavailableReason: "ffmpeg not found on PATH. Install ffmpeg to enable audio/video transcription.",
      convert: async () => ({
        text: "",
        success: false,
        converter: "media-sidecar",
        error: "ffmpeg is not installed",
      }),
    };
  }

  const hasSidecar = await sidecarAvailable(sidecarUrl);

  if (!hasSidecar) {
    return {
      name: "media-sidecar",
      extensions: MEDIA_EXTENSIONS,
      available: false,
      unavailableReason: `Audio sidecar not reachable at ${sidecarUrl}. Start the sidecar: cd sidecars/audio && python server.py`,
      convert: async () => ({
        text: "",
        success: false,
        converter: "media-sidecar",
        error: `Audio sidecar not reachable at ${sidecarUrl}`,
      }),
    };
  }

  return {
    name: "media-sidecar",
    extensions: MEDIA_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const tmpWav = path.join(os.tmpdir(), `openzigs-sidecar-${Date.now()}.wav`);
      let keyframeTempDir: string | undefined;

      try {
        // Step 1: Extract audio as WAV using ffmpeg
        // Use 24kHz to match the sidecar's native sample rate
        await execFileAsync("ffmpeg", [
          "-i", filePath,
          "-vn",
          "-acodec", "pcm_s16le",
          "-ar", "24000",
          "-ac", "1",
          "-y",
          tmpWav,
        ]);

        // Step 2: Send WAV to audio sidecar for transcription
        const wavData = await fs.readFile(tmpWav);
        const formData = new FormData();
        const blob = new Blob([wavData], { type: "audio/wav" });
        formData.append("audio", blob, path.basename(filePath).replace(/\.\w+$/, ".wav"));

        const resp = await fetch(`${sidecarUrl}/transcribe`, {
          method: "POST",
          body: formData,
        });

        if (!resp.ok) {
          const errorBody = await resp.text().catch(() => "");
          throw new Error(`Sidecar transcription failed (${resp.status}): ${errorBody}`);
        }

        const result = (await resp.json()) as {
          text: string;
          language: string;
          segments: Array<{ start: number; end: number; text: string }>;
          duration_seconds: number;
        };

        // Step 3: Check for video stream and extract keyframes if applicable
        const isVideo = await hasVideoStream(filePath);
        let frameDescriptions: Array<{ timestamp: number; description: string }> = [];

        if (isVideo && copilot) {
          logger.info(`[SidecarMedia] Video detected — extracting keyframes for vision analysis`);

          try {
            const { frames, tempDir } = await extractKeyframes(filePath, {
              intervalSeconds: keyframeInterval,
              maxFrames: maxKeyframes,
            });
            keyframeTempDir = tempDir;

            if (frames.length > 0) {
              const descriptions = await describeKeyframes(frames, copilot);
              frameDescriptions = frames
                .map((f, i) => ({
                  timestamp: f.timestamp,
                  description: descriptions[i] || "",
                }))
                .filter((d) => d.description.length > 0);

              logger.info(
                `[SidecarMedia] Described ${frameDescriptions.length} of ${frames.length} keyframes`,
              );
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn(`[SidecarMedia] Keyframe extraction/vision failed: ${msg}`);
            // Continue with transcript only — keyframe failure is non-fatal
          }
        } else if (isVideo && !copilot) {
          logger.info(`[SidecarMedia] Video detected but no CopilotWrapper — skipping keyframe vision`);
        }

        // Step 4: Format as markdown with timestamps + visual descriptions
        const fileName = path.basename(filePath);
        const header = `# Transcript: ${fileName}\n\n`;
        const meta = [
          `- **Duration:** ${formatTimestamp(result.duration_seconds)}`,
          `- **Language:** ${result.language || "auto-detected"}`,
          `- **Segments:** ${result.segments.length}`,
          `- **Engine:** Audio Sidecar (Whisper MLX)`,
          ...(frameDescriptions.length > 0
            ? [`- **Visual Descriptions:** ${frameDescriptions.length} keyframes (Copilot SDK Vision)`]
            : []),
          "",
        ].join("\n");

        // Interleave transcript segments with visual descriptions by timestamp
        const body = buildInterleavedBody(result.segments, frameDescriptions);

        return {
          text: header + meta + "\n" + body,
          success: true,
          converter: "media-sidecar",
          metadata: {
            segmentCount: result.segments.length,
            durationSeconds: result.duration_seconds,
            language: result.language,
            sourceFile: fileName,
            segments: result.segments,
            isVideo,
            keyframeDescriptions: frameDescriptions.length > 0 ? frameDescriptions : undefined,
          },
        };
      } finally {
        // Clean up temp files
        try {
          await fs.unlink(tmpWav);
        } catch {
          // Ignore cleanup errors
        }
        if (keyframeTempDir) {
          try {
            await fs.rm(keyframeTempDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    },
  };
}

/**
 * Build the markdown body interleaving transcript segments with visual descriptions.
 * Visual descriptions are inserted at the chronologically appropriate position.
 */
export function buildInterleavedBody(
  segments: Array<{ start: number; end: number; text: string }>,
  frameDescriptions: Array<{ timestamp: number; description: string }>,
): string {
  if (frameDescriptions.length === 0) {
    // No visual descriptions — just transcript
    return segments
      .map((s) => `**[${formatTimestamp(s.start)} → ${formatTimestamp(s.end)}]** ${s.text.trim()}`)
      .join("\n\n");
  }

  // Merge transcript segments and frame descriptions by timestamp
  type TimelineEntry =
    | { kind: "transcript"; start: number; end: number; text: string }
    | { kind: "visual"; timestamp: number; description: string };

  const timeline: TimelineEntry[] = [
    ...segments.map((s) => ({ kind: "transcript" as const, start: s.start, end: s.end, text: s.text })),
    ...frameDescriptions.map((f) => ({ kind: "visual" as const, timestamp: f.timestamp, description: f.description })),
  ];

  // Sort by timestamp (transcript uses start, visual uses timestamp)
  timeline.sort((a, b) => {
    const timeA = a.kind === "transcript" ? a.start : a.timestamp;
    const timeB = b.kind === "transcript" ? b.start : b.timestamp;
    if (timeA !== timeB) return timeA - timeB;
    // Visual descriptions come before transcript at the same timestamp
    return a.kind === "visual" ? -1 : 1;
  });

  return timeline
    .map((entry) => {
      if (entry.kind === "transcript") {
        return `**[${formatTimestamp(entry.start)} → ${formatTimestamp(entry.end)}]** ${entry.text.trim()}`;
      }
      return `**[Visual @ ${formatTimestamp(entry.timestamp)}]** _${entry.description}_`;
    })
    .join("\n\n");
}
