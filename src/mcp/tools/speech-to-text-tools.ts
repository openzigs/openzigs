/**
 * MCP Tool: Speech-to-Text (Whisper MLX) — Transcription with enhanced output.
 * Issue #775: Uses existing distil-large-v3 model in mlx_models/ via the audio sidecar.
 * Extends the existing transcribe-audio tool pattern.
 */

import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ToolDefinition } from "../tool-registry.js";
import { logger } from "../../logging/logger.js";
import { normalizeSidecarError } from "../../sidecars/error-normalizer.js";

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const speechToTextSchema = z.object({
  file_path: z
    .string()
    .describe(
      "Path to the audio file to transcribe (mp3, wav, m4a, webm, ogg, flac)",
    ),
  language: z
    .string()
    .optional()
    .describe(
      "Language code (e.g., 'en', 'es', 'fr'). Auto-detected if omitted.",
    ),
  output_format: z
    .enum(["text", "srt", "vtt", "json"])
    .optional()
    .default("text")
    .describe(
      "Output format: text (plain transcript), srt (subtitles), vtt (web subtitles), json (segments)",
    ),
  word_timestamps: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include word-level timestamps in output"),
});

export interface SpeechToTextToolsOptions {
  audioSidecarUrl: string;
}

function resolveFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const galleryPath = path.join(GALLERY_DIR, filePath);
  if (fs.existsSync(galleryPath)) return galleryPath;
  return filePath;
}

function segmentsToSrt(
  segments: Array<{ start: number; end: number; text: string }>,
): string {
  return segments
    .map((seg, i) => {
      const formatTime = (t: number) => {
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = Math.floor(t % 60);
        const ms = Math.round((t % 1) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
      };
      return `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text.trim()}\n`;
    })
    .join("\n");
}

function segmentsToVtt(
  segments: Array<{ start: number; end: number; text: string }>,
): string {
  const srt = segmentsToSrt(segments);
  return "WEBVTT\n\n" + srt.replace(/,/g, ".");
}

export const createSpeechToTextTools = ({
  audioSidecarUrl,
}: SpeechToTextToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "speech-to-text",
      description:
        "Transcribe audio to text using Whisper MLX (distil-large-v3 model). Supports multiple output " +
        "formats: plain text, SRT subtitles, VTT web subtitles, or JSON with segment timestamps. " +
        "Accepts mp3, wav, m4a, webm, ogg, or flac files. Auto-detects language unless specified.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the audio file" },
          language: {
            type: "string",
            description: "Language code (auto-detected if omitted)",
          },
          output_format: {
            type: "string",
            enum: ["text", "srt", "vtt", "json"],
          },
          word_timestamps: {
            type: "boolean",
            description: "Include word-level timestamps",
          },
        },
        required: ["file_path"],
      },
      zodSchema: speechToTextSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = speechToTextSchema.parse(args);
          const sourcePath = path.resolve(resolveFilePath(input.file_path));

          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }

          // Send file to audio sidecar as multipart form
          const fileBuffer = fs.readFileSync(sourcePath);
          const formData = new FormData();
          formData.append(
            "file",
            new Blob([fileBuffer]),
            path.basename(sourcePath),
          );
          if (input.language) {
            formData.append("language", input.language);
          }
          if (input.word_timestamps) {
            formData.append("word_timestamps", "true");
          }

          const response = await fetch(`${audioSidecarUrl}/transcribe`, {
            method: "POST",
            body: formData,
            signal: AbortSignal.timeout(300_000), // 5 min for long audio
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "");
            const { userMessage } = normalizeSidecarError(
              errText,
              response.status,
            );
            return {
              text: `Transcription sidecar error (${response.status}): ${userMessage}`,
              isError: true,
            };
          }

          const result = (await response.json()) as {
            text: string;
            language: string;
            segments: Array<{ start: number; end: number; text: string }>;
          };

          // Format output based on requested format
          switch (input.output_format) {
            case "srt": {
              const srtContent = segmentsToSrt(result.segments);
              const srtPath = path.join(
                GALLERY_DIR,
                `${path.basename(sourcePath, path.extname(sourcePath))}_transcript.srt`,
              );
              fs.mkdirSync(GALLERY_DIR, { recursive: true });
              fs.writeFileSync(srtPath, srtContent);
              return {
                text: JSON.stringify({
                  format: "srt",
                  language: result.language,
                  filePath: srtPath,
                  segmentCount: result.segments.length,
                }),
              };
            }
            case "vtt": {
              const vttContent = segmentsToVtt(result.segments);
              const vttPath = path.join(
                GALLERY_DIR,
                `${path.basename(sourcePath, path.extname(sourcePath))}_transcript.vtt`,
              );
              fs.mkdirSync(GALLERY_DIR, { recursive: true });
              fs.writeFileSync(vttPath, vttContent);
              return {
                text: JSON.stringify({
                  format: "vtt",
                  language: result.language,
                  filePath: vttPath,
                  segmentCount: result.segments.length,
                }),
              };
            }
            case "json":
              return {
                text: JSON.stringify({
                  format: "json",
                  language: result.language,
                  text: result.text,
                  segments: result.segments,
                }),
              };
            default:
              return {
                text: JSON.stringify({
                  format: "text",
                  language: result.language,
                  text: result.text,
                  segmentCount: result.segments.length,
                }),
              };
          }
        } catch (err) {
          logger.error("speech-to-text error", { error: String(err) });
          return {
            text: `Error transcribing audio: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
