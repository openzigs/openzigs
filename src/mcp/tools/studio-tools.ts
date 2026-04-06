/**
 * MCP Studio Tools — trim-video + analyze-video-redundancy.
 * Issue #442 + #444.
 */

import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ToolDefinition } from "../tool-registry.js";
import type { TrimWorker } from "../../video/trim-worker.js";
import type { AnalyzeWorker } from "../../video/analyze-worker.js";
import type { MediaQueueRepository } from "../../queue/media-queue-repository.js";

// ── Schemas ─────────────────────────────────────────────────

const trimVideoSchema = z.object({
  asset_id: z.string().describe("Gallery asset ID of the video to trim"),
  start_time: z.number().min(0).describe("Start time in seconds"),
  end_time: z.number().positive().describe("End time in seconds"),
});

const analyzeVideoSchema = z.object({
  asset_id: z
    .string()
    .describe("Gallery asset ID of the video to analyze for redundancy"),
});

// ── Factory ─────────────────────────────────────────────────

export interface StudioToolsOptions {
  trimWorker: TrimWorker;
  analyzeWorker: AnalyzeWorker;
  mediaQueueRepo: MediaQueueRepository;
}

export const createStudioTools = ({
  trimWorker,
  analyzeWorker,
  mediaQueueRepo,
}: StudioToolsOptions): ToolDefinition[] => {
  const galleryDir = path.join(os.homedir(), ".openzigs", "gallery");

  return [
    {
      name: "trim-video",
      description:
        "Trim a video asset losslessly using FFmpeg stream copy. Provide a gallery asset ID and start/end times. Returns the job ID to track progress and a new gallery asset for the trimmed clip.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: {
            type: "string",
            description: "Gallery asset ID of the video to trim",
          },
          start_time: { type: "number", description: "Start time in seconds" },
          end_time: { type: "number", description: "End time in seconds" },
        },
        required: ["asset_id", "start_time", "end_time"],
      },
      zodSchema: trimVideoSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = trimVideoSchema.parse(args);

          if (input.end_time <= input.start_time) {
            return {
              text: "end_time must be greater than start_time",
              isError: true,
            };
          }

          const asset = mediaQueueRepo.getAsset(input.asset_id);
          if (!asset) {
            return {
              text: `Asset '${input.asset_id}' not found in gallery`,
              isError: true,
            };
          }

          const inputPath = asset.file_path as string;
          if (!fs.existsSync(inputPath)) {
            return {
              text: `Asset file not found on disk: ${inputPath}`,
              isError: true,
            };
          }

          const ext = path.extname(inputPath);
          const baseName = path.basename(inputPath, ext);
          const outputFilename = `${baseName}_trimmed_${Date.now()}${ext}`;
          fs.mkdirSync(galleryDir, { recursive: true });
          const outputPath = path.join(galleryDir, outputFilename);

          const jobId = await trimWorker.submit({
            inputPath,
            outputPath,
            startTime: input.start_time,
            endTime: input.end_time,
          });

          // Wait for completion (up to 2 minutes)
          try {
            await trimWorker.waitForCompletion(jobId, 120_000);
            const stat = fs.statSync(outputPath);
            const newAssetId = mediaQueueRepo.createAsset({
              type: "video",
              filename: outputFilename,
              filePath: outputPath,
              mimeType: ext === ".webm" ? "video/webm" : "video/mp4",
              fileSizeBytes: stat.size,
              durationSeconds: input.end_time - input.start_time,
              source: "uploaded",
              tags: ["trimmed", `source:${input.asset_id}`],
            });

            return {
              text: JSON.stringify(
                {
                  status: "complete",
                  trimJobId: jobId,
                  newAssetId,
                  filename: outputFilename,
                  duration: `${input.end_time - input.start_time}s`,
                  size: stat.size,
                },
                null,
                2,
              ),
            };
          } catch (waitErr) {
            return {
              text: JSON.stringify(
                {
                  status: "submitted",
                  trimJobId: jobId,
                  message:
                    "Trim job submitted but did not complete within timeout. Check status via GET /api/studio/trim/:jobId",
                },
                null,
                2,
              ),
            };
          }
        } catch (err) {
          return {
            text: `Error trimming video: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "analyze-video-redundancy",
      description:
        "Analyze a video for redundant segments using AI vision. Extracts frames at 1fps, optionally transcribes audio, then uses a Vision LLM to detect repeated takes, stumbles, dead space, and other removable content. Returns suggested cut points.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: {
            type: "string",
            description: "Gallery asset ID of the video to analyze",
          },
        },
        required: ["asset_id"],
      },
      zodSchema: analyzeVideoSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = analyzeVideoSchema.parse(args);

          const asset = mediaQueueRepo.getAsset(input.asset_id);
          if (!asset) {
            return {
              text: `Asset '${input.asset_id}' not found in gallery`,
              isError: true,
            };
          }

          const inputPath = asset.file_path as string;
          if (!fs.existsSync(inputPath)) {
            return {
              text: `Asset file not found on disk: ${inputPath}`,
              isError: true,
            };
          }

          const jobId = await analyzeWorker.submit({
            assetId: input.asset_id,
            inputPath,
          });

          // Wait for completion (up to 5 minutes — analysis is slow)
          try {
            const job = await analyzeWorker.waitForCompletion(jobId, 300_000);
            return {
              text: JSON.stringify(
                {
                  status: "complete",
                  analyzeJobId: jobId,
                  suggestedCuts: job.suggestedCuts,
                  totalCuts: job.suggestedCuts.length,
                },
                null,
                2,
              ),
            };
          } catch (waitErr) {
            return {
              text: JSON.stringify(
                {
                  status: "submitted",
                  analyzeJobId: jobId,
                  message:
                    "Analysis submitted but did not complete within timeout. Check status via GET /api/studio/analyze/:jobId",
                },
                null,
                2,
              ),
            };
          }
        } catch (err) {
          return {
            text: `Error analyzing video: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
