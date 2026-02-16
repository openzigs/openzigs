/**
 * Director Mode — Audio Extractor
 * Issue #237: Extract audio from video files using fluent-ffmpeg.
 * Outputs 16kHz mono WAV suitable for whisper-node transcription.
 */

import path from "node:path";
import { logger } from "../../logging/logger.js";

/**
 * Extract audio track from a video file as 16kHz mono WAV.
 * Returns the output file path, or null if the video has no audio track.
 */
export async function extractAudio(videoPath: string, outputDir: string): Promise<string | null> {
  const basename = path.basename(videoPath, path.extname(videoPath));
  const outputPath = path.join(outputDir, `${basename}.wav`);

  try {
    const ffmpeg = (await import("fluent-ffmpeg")).default;

    return new Promise<string | null>((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec("pcm_s16le")
        .audioFrequency(16000)
        .audioChannels(1)
        .output(outputPath)
        .on("end", () => {
          logger.info(`[AudioExtractor] Extracted audio: ${outputPath}`);
          resolve(outputPath);
        })
        .on("error", (err: Error) => {
          // Check if the error indicates no audio stream
          if (err.message.includes("does not contain any stream") || err.message.includes("no audio")) {
            logger.warn(`[AudioExtractor] No audio track in: ${videoPath}`);
            resolve(null);
          } else {
            reject(err);
          }
        })
        .run();
    });
  } catch (error) {
    // fluent-ffmpeg not installed — return null gracefully
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[AudioExtractor] ffmpeg unavailable: ${msg}`);
    return null;
  }
}

/**
 * Get the duration of an audio file in seconds using ffprobe.
 */
export async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const ffmpeg = (await import("fluent-ffmpeg")).default;

    return new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err: Error | null, metadata: { format?: { duration?: number } }) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(metadata?.format?.duration ?? 0);
      });
    });
  } catch {
    return 0;
  }
}
