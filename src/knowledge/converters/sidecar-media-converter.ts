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
 * Falls back to the existing whisper-node media converter if the sidecar
 * is unreachable.
 *
 * Pipeline: ffmpeg (extract audio) → POST /transcribe to sidecar → markdown with timestamps
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { ConverterRegistration } from "./types.js";

const execFileAsync = promisify(execFile);

const MEDIA_EXTENSIONS = [".mp4", ".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac"];

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

export type SidecarMediaConverterOptions = {
  /** Audio sidecar URL (default: http://localhost:5006) */
  sidecarUrl?: string;
};

/**
 * Create a media converter that uses the audio sidecar for STT.
 * Requires ffmpeg on PATH and a reachable audio sidecar.
 */
export async function createSidecarMediaConverter(
  options: SidecarMediaConverterOptions = {},
): Promise<ConverterRegistration> {
  const sidecarUrl = (options.sidecarUrl ?? "http://localhost:5006").replace(/\/$/, "");
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

        // Step 3: Format as markdown with timestamps
        const fileName = path.basename(filePath);
        const header = `# Transcript: ${fileName}\n\n`;
        const meta = [
          `- **Duration:** ${formatTimestamp(result.duration_seconds)}`,
          `- **Language:** ${result.language || "auto-detected"}`,
          `- **Segments:** ${result.segments.length}`,
          `- **Engine:** Audio Sidecar (Whisper MLX)`,
          "",
        ].join("\n");

        const body = result.segments
          .map((s) => `**[${formatTimestamp(s.start)} → ${formatTimestamp(s.end)}]** ${s.text.trim()}`)
          .join("\n\n");

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
          },
        };
      } finally {
        try {
          await fs.unlink(tmpWav);
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}
