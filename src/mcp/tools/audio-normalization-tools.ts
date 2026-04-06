/**
 * MCP Tool: Audio Normalization via FFmpeg loudnorm filter.
 * Issue #771: Normalize audio loudness to broadcast standards using a two-pass approach.
 */

import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../tool-registry.js";
import { logger } from "../../logging/logger.js";

const execFileAsync = promisify(execFile);
const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const normalizeAudioSchema = z.object({
  file_path: z
    .string()
    .describe("Path to the audio file (mp3, wav, m4a, flac, ogg)"),
  target_lufs: z
    .number()
    .min(-36)
    .max(-5)
    .optional()
    .default(-14)
    .describe("Target loudness in LUFS (default: -14, broadcast standard)"),
  target_tp: z
    .number()
    .min(-9)
    .max(0)
    .optional()
    .default(-1)
    .describe("True peak maximum in dBTP (default: -1)"),
  format: z
    .enum(["mp3", "wav", "flac", "m4a"])
    .optional()
    .describe("Output format (default: same as input)"),
});

function resolveAudioPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const galleryPath = path.join(GALLERY_DIR, filePath);
  if (fs.existsSync(galleryPath)) return galleryPath;
  return filePath;
}

async function checkFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export const createAudioNormalizationTools = (): ToolDefinition[] => {
  return [
    {
      name: "normalize-audio",
      description:
        "Normalize audio loudness to broadcast standards using FFmpeg's loudnorm filter (EBU R128). " +
        "Two-pass process: first measures loudness, then applies correction. Default target is -14 LUFS " +
        "(standard for streaming platforms). Supports mp3, wav, m4a, flac, ogg input.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the audio file" },
          target_lufs: {
            type: "number",
            description: "Target loudness in LUFS (default: -14)",
          },
          target_tp: {
            type: "number",
            description: "True peak max in dBTP (default: -1)",
          },
          format: {
            type: "string",
            enum: ["mp3", "wav", "flac", "m4a"],
            description: "Output format",
          },
        },
        required: ["file_path"],
      },
      zodSchema: normalizeAudioSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = normalizeAudioSchema.parse(args);

          const hasFfmpeg = await checkFfmpeg();
          if (!hasFfmpeg) {
            return {
              text: "FFmpeg is not installed. Please install FFmpeg to use audio normalization.",
              isError: true,
            };
          }

          const sourcePath = path.resolve(resolveAudioPath(input.file_path));
          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }

          const outputExt = input.format
            ? `.${input.format}`
            : path.extname(sourcePath);
          fs.mkdirSync(GALLERY_DIR, { recursive: true });
          const baseName = path.basename(sourcePath, path.extname(sourcePath));
          const outputPath = path.join(
            GALLERY_DIR,
            `${baseName}_normalized_${Date.now()}${outputExt}`,
          );

          // Pass 1: Measure loudness
          const { stderr: pass1Output } = await execFileAsync(
            "ffmpeg",
            [
              "-i",
              sourcePath,
              "-af",
              `loudnorm=I=${input.target_lufs}:TP=${input.target_tp}:LRA=11:print_format=json`,
              "-f",
              "null",
              "-",
            ],
            { timeout: 60_000 },
          );

          // Parse loudnorm JSON from stderr
          const jsonMatch = pass1Output.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
          if (!jsonMatch) {
            return {
              text: "Failed to parse loudness measurement from FFmpeg output.",
              isError: true,
            };
          }
          const measured = JSON.parse(jsonMatch[0]) as Record<string, string>;

          // Pass 2: Apply normalization with measured values
          await execFileAsync(
            "ffmpeg",
            [
              "-i",
              sourcePath,
              "-af",
              [
                `loudnorm=I=${input.target_lufs}:TP=${input.target_tp}:LRA=11`,
                `measured_I=${measured.input_i}`,
                `measured_LRA=${measured.input_lra}`,
                `measured_TP=${measured.input_tp}`,
                `measured_thresh=${measured.input_thresh}`,
                `offset=${measured.target_offset}`,
                "linear=true",
              ].join(":"),
              "-y",
              outputPath,
            ],
            { timeout: 120_000 },
          );

          const stat = fs.statSync(outputPath);
          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              targetLufs: input.target_lufs,
              measuredLufs: parseFloat(measured.input_i),
              measuredPeak: parseFloat(measured.input_tp),
              sizeBytes: stat.size,
            }),
          };
        } catch (err) {
          logger.error("normalize-audio error", { error: String(err) });
          return {
            text: `Error normalizing audio: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
