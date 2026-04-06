/**
 * MCP Tool: transcribe-audio — Transcribe an audio file to text using the audio sidecar's Whisper STT.
 * Accepts a file path to an audio file (mp3, wav, m4a, etc.) and returns the transcribed text
 * with segment-level timestamps.
 */

import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import { logger } from "../../logging/logger.js";
import type { KnowledgeIngestionService } from "../../knowledge/knowledge-service.js";

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const transcribeAudioSchema = z.object({
  file_path: z
    .string()
    .describe(
      "Path to the audio file to transcribe. Can be an absolute path or a gallery filename returned by ingest-youtube.",
    ),
});

type TranscribeArgs = z.infer<typeof transcribeAudioSchema>;

export interface TranscribeAudioToolsOptions {
  /** Base URL of the audio sidecar, e.g. "http://localhost:5006" */
  audioSidecarUrl: string;
  /** Optional knowledge service for auto-ingesting transcripts. */
  knowledgeService?: KnowledgeIngestionService;
}

export const createTranscribeAudioTools = ({
  audioSidecarUrl,
  knowledgeService,
}: TranscribeAudioToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "transcribe-audio",
      description:
        "Transcribe an audio file to text using Whisper speech-to-text. " +
        "Accepts mp3, wav, m4a, webm, ogg, or flac files. Returns the full transcript " +
        "with segment-level timestamps. Use after downloading audio with ingest-youtube to " +
        "extract spoken content for research and article writing.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Path to the audio file. Can be an absolute path or a filename from the gallery (as returned by ingest-youtube).",
          },
        },
        required: ["file_path"],
      },
      zodSchema: transcribeAudioSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { file_path } = args as TranscribeArgs;

        // Resolve bare filenames to the gallery directory
        let resolvedPath = file_path;
        if (!path.isAbsolute(file_path)) {
          resolvedPath = path.join(GALLERY_DIR, file_path);
        }

        // Validate the file exists
        try {
          await fs.access(resolvedPath);
        } catch {
          return {
            text: `Audio file not found: ${resolvedPath}`,
            isError: true,
          };
        }

        // Validate extension
        const ext = path.extname(resolvedPath).toLowerCase();
        const validExts = new Set([
          ".mp3",
          ".wav",
          ".m4a",
          ".webm",
          ".ogg",
          ".flac",
          ".mp4",
        ]);
        if (!validExts.has(ext)) {
          return {
            text: `Unsupported audio format: ${ext}. Accepted: mp3, wav, m4a, webm, ogg, flac`,
            isError: true,
          };
        }

        // Read file and send to audio sidecar
        try {
          const fileData = await fs.readFile(resolvedPath);
          const filename = path.basename(resolvedPath);

          // Build multipart form data
          const formData = new FormData();
          const blob = new Blob([fileData], {
            type: mimeForExt(ext),
          });
          formData.append("audio", blob, filename);

          const url = `${audioSidecarUrl.replace(/\/$/, "")}/transcribe`;
          logger.info(
            `transcribe-audio: sending ${filename} (${fileData.length} bytes) to ${url}`,
          );

          const response = await fetch(url, {
            method: "POST",
            body: formData,
            signal: AbortSignal.timeout(300_000), // 5 min timeout
          });

          if (!response.ok) {
            const body = await response.text();
            logger.error(
              `transcribe-audio: sidecar returned ${response.status}: ${body}`,
            );
            return {
              text: `Transcription failed (${response.status}): ${body}`,
              isError: true,
            };
          }

          const result = (await response.json()) as {
            text: string;
            language: string;
            segments: Array<{
              start: number;
              end: number;
              text: string;
            }>;
            duration_seconds: number;
          };

          // Format output with timestamps
          const lines: string[] = [
            `## Transcript`,
            `**Language**: ${result.language || "unknown"}`,
            `**Duration**: ${formatDuration(result.duration_seconds)}`,
            `**Source**: ${filename}`,
            "",
            result.text,
            "",
          ];

          if (result.segments && result.segments.length > 0) {
            lines.push("### Timestamped Segments");
            for (const seg of result.segments) {
              lines.push(
                `[${formatTimestamp(seg.start)} → ${formatTimestamp(seg.end)}] ${seg.text}`,
              );
            }
          }

          logger.info(
            `transcribe-audio: transcribed ${result.duration_seconds}s of audio — ${result.text.length} chars`,
          );

          // Save transcript as physical file to ~/.openzigs/knowledge/
          const KNOWLEDGE_DIR = path.join(
            os.homedir(),
            ".openzigs",
            "knowledge",
          );
          const transcriptBaseName = filename.replace(/\.[^.]+$/, "");
          const transcriptFilePath = path.join(
            KNOWLEDGE_DIR,
            `${transcriptBaseName}.transcript.txt`,
          );
          try {
            await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
            await fs.writeFile(transcriptFilePath, result.text, "utf-8");
            lines.push("", `> Transcript file saved to: ${transcriptFilePath}`);
            logger.info(
              `transcribe-audio: saved transcript file to ${transcriptFilePath}`,
            );
          } catch (fileErr) {
            logger.warn(
              `transcribe-audio: failed to save transcript file: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
            );
          }

          // Auto-ingest transcript into the Knowledge vector store
          if (knowledgeService && result.text.length > 0) {
            try {
              const docId = `transcript:${transcriptBaseName}`;
              const title = `YouTube Transcript: ${filename
                .replace(/^\d+-/, "")
                .replace(/\.[^.]+$/, "")
                .replace(/[_-]+/g, " ")}`;
              await knowledgeService.ingestText(docId, title, result.text, {
                category: "media",
                visibility: "internal",
              });
              lines.push(`> Transcript indexed in Knowledge as "${title}"`);
              logger.info(
                `transcribe-audio: ingested transcript into Knowledge as ${docId}`,
              );
            } catch (kErr) {
              logger.warn(
                `transcribe-audio: knowledge ingestion failed: ${kErr instanceof Error ? kErr.message : String(kErr)}`,
              );
            }
          }

          return { text: lines.join("\n") };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`transcribe-audio: ${msg}`);
          return {
            text: `Transcription failed: ${msg}`,
            isError: true,
          };
        }
      },
    },
  ];
};

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".mp4": "audio/mp4",
  };
  return map[ext] ?? "application/octet-stream";
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}
