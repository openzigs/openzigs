/**
 * Media converter — extracts text from audio/video files.
 *
 * Pipeline: ffmpeg (extract PCM audio) → whisper-node (transcribe) → markdown.
 *
 * Both `ffmpeg` (system binary) and `whisper-node` (npm) are required.
 * If either is missing the converter is marked unavailable and the
 * Knowledge Manager UI offers manual conversion guidance.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ConverterRegistration } from "./types.js";

const execFileAsync = promisify(execFile);

const MEDIA_EXTENSIONS = [".mp4", ".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac"];

type WhisperSegment = { start: string; end: string; speech: string };
type WhisperFn = (wavPath: string, options?: Record<string, unknown>) => Promise<WhisperSegment[]>;

/** Check whether ffmpeg is reachable on PATH. */
async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize the Whisper model name.
 *
 * whisper-node stores models as `ggml-{modelName}.bin`. The names don't
 * always match what users expect:
 * - "large-v3" → "large" (whisper-node's `large` is actually v3)
 * - "large"    → "large" (works if ggml-large.bin exists or is symlinked)
 *
 * We keep a fallback chain so the converter can try multiple names if the
 * primary one isn't found at runtime.
 */
function resolveModelName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "large-v3") return "large";
  return trimmed || "base.en";
}

export type MediaConverterOptions = {
  modelName?: string;
};

export async function createMediaConverter(options: MediaConverterOptions = {}): Promise<ConverterRegistration> {
  const modelName = resolveModelName(options.modelName ?? "base.en");
  const hasFFmpeg = await ffmpegAvailable();

  if (!hasFFmpeg) {
    return {
      name: "media",
      extensions: MEDIA_EXTENSIONS,
      available: false,
      unavailableReason: "ffmpeg not found on PATH. Install ffmpeg to enable audio/video transcription.",
      convert: async () => ({
        text: "",
        success: false,
        converter: "media",
        error: "ffmpeg is not installed",
      }),
    };
  }

  // Check for whisper-node (optional — may not have types).
  // whisper-node requires `make` to compile whisper.cpp at module load time.
  // On Windows, this causes shelljs to call process.exit(1) — skip entirely.
  let whisperFn: WhisperFn | null = null;

  if (process.platform !== "win32") {
    try {
    // Dynamic import — module may not exist. Use string indirection to prevent
    // TypeScript from resolving the module at compile time.
    const moduleName = "whisper-node";
    const mod: unknown = await import(moduleName).catch(() => null);
    if (mod) {
      const m = mod as Record<string, unknown>;
      // whisper-node export shapes seen in the wild:
      // - default function
      // - named export: { whisper }
      // - default object containing .whisper
      const defaultExport = m.default as unknown;
      let fn: unknown = m.whisper;
      if (typeof fn !== "function") {
        fn =
          (typeof defaultExport === "function")
            ? defaultExport
            : (defaultExport as Record<string, unknown> | null)?.whisper;
      }
      if (typeof fn === "function") {
        whisperFn = fn as WhisperFn;
      }
    }
  } catch {
    // whisper-node not installed.
  }
  }

  if (!whisperFn) {
    return {
      name: "media",
      extensions: MEDIA_EXTENSIONS,
      available: false,
      unavailableReason:
        "whisper-node not available. Install: pnpm add whisper-node, then run: pnpm exec whisper-node download",
      convert: async () => ({
        text: "",
        success: false,
        converter: "media",
        error: "whisper-node is not available",
      }),
    };
  }

  const transcribe = whisperFn;

  return {
    name: "media",
    extensions: MEDIA_EXTENSIONS,
    available: true,
    convert: async (filePath: string) => {
      const os = await import("node:os");
      const fsMod = await import("node:fs/promises");
      const tmpWav = path.join(os.tmpdir(), `openzigs-${Date.now()}.wav`);

      try {
        // Extract mono 16kHz PCM audio with ffmpeg.
        await execFileAsync("ffmpeg", [
          "-i", filePath,
          "-vn",
          "-acodec", "pcm_s16le",
          "-ar", "16000",
          "-ac", "1",
          "-y",
          tmpWav,
        ]);

        // Transcribe with whisper-node.
        const segments = await transcribe(tmpWav, {
          modelName,
          whisperOptions: { language: "en" },
        });

        if (!Array.isArray(segments)) {
          throw new Error(
            "whisper-node returned an unexpected response. " +
            "Run `pnpm exec whisper-node download` to ensure models are installed."
          );
        }

        const fileName = path.basename(filePath);
        const header = `# Transcript: ${fileName}\n\n`;
        const body = segments
          .map((s: WhisperSegment) => `**[${s.start} → ${s.end}]** ${s.speech}`)
          .join("\n\n");

        return {
          text: header + body,
          success: true,
          converter: "media",
          metadata: {
            segmentCount: segments.length,
            sourceFile: fileName,
          },
        };
      } finally {
        // Clean up temp WAV.
        try {
          await fsMod.unlink(tmpWav);
        } catch {
          // Ignore cleanup errors.
        }
      }
    },
  };
}
