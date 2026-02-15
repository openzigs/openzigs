/**
 * Director Mode — Transcriber
 * Issue #237: CPU-based transcription using whisper-node.
 * Produces timestamped transcript segments from audio files.
 */

import { logger } from "../../logging/logger.js";
import type { TranscriptSegment } from "./types.js";

/**
 * Transcribe an audio file using whisper-node.
 *
 * @param audioPath - Path to 16kHz mono WAV file
 * @param clipIndex - Index of the clip this audio belongs to
 * @param modelName - Whisper model to use (default: "base.en")
 * @returns Array of timestamped transcript segments
 */
export async function transcribe(
  audioPath: string,
  clipIndex: number,
  modelName = "base.en",
): Promise<TranscriptSegment[]> {
  try {
    const whisper = (await import("whisper-node")).default;

    const transcript = await whisper(audioPath, {
      modelName,
      whisperOptions: {
        language: "auto",
        word_timestamps: true,
      },
    });

    if (!transcript || !Array.isArray(transcript)) {
      logger.warn(`[Transcriber] Empty transcript for clip ${clipIndex}: ${audioPath}`);
      return [];
    }

    return transcript.map((line: { start: string; end: string; speech: string }) => ({
      start: line.start,
      end: line.end,
      speech: (line.speech ?? "").trim(),
      clipIndex,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Model not downloaded — provide actionable error
    if (msg.includes("model") || msg.includes("download")) {
      logger.warn(`[Transcriber] Whisper model '${modelName}' not found — will be downloaded on first use`);
    } else {
      logger.warn(`[Transcriber] Transcription failed for clip ${clipIndex}: ${msg}`);
    }

    return [];
  }
}
