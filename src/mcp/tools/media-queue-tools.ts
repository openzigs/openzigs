import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { MediaQueueRepository } from "../../queue/media-queue-repository.js";
import type { QueueMaster } from "../../queue/queue-master.js";
import {
  type MediaJobType,
  targetNodeForJobType,
  defaultModelForJobType,
} from "../../queue/types.js";

const VALID_JOB_TYPES: MediaJobType[] = [
  "txt2img", "img2img", "txt2video", "img2video",
  "tts", "txt2music", "voice2voice",
  "remix_analyze", "remix_replace", "remix_master",
];

const submitMediaJobSchema = z.object({
  type: z.enum(VALID_JOB_TYPES as [MediaJobType, ...MediaJobType[]]),
  prompt: z.string().optional().describe("Generation prompt (required for most types)"),
  model: z.string().optional().describe("Model override (auto-selected if omitted)"),
  width: z.number().optional(),
  height: z.number().optional(),
  steps: z.number().optional(),
  guidance: z.number().optional(),
  seed: z.number().optional(),
  negative_prompt: z.string().optional(),
  source_audio_asset_id: z.string().optional(),
  voice_model: z.string().optional(),
  target_instrument_id: z.string().optional(),
  vibe: z.enum(["punchy_pop", "warm_lofi", "cinematic_wide", "raw"]).optional(),
  priority: z.number().optional().describe("Job priority (higher = processed first)"),
  project_id: z.string().optional().describe("Group jobs under a project"),
  duration_seconds: z.number().optional().describe("Duration in seconds (music generation)"),
  lyrics: z.string().optional().describe("Lyrics for vocal music generation"),
  instrumental: z.boolean().optional().describe("Generate instrumental-only music"),
  notify_via_telegram: z.boolean().optional().describe("Send a Telegram notification when the job completes or fails"),
  telegram_chat_id: z.string().optional().describe("Telegram chat ID to notify (uses configured admin chat ID if omitted)"),
});

const getJobStatusSchema = z.object({
  job_id: z.string().optional().describe("Job ID to check status for"),
  include_node_status: z.boolean().optional().describe("Include hardware worker node health"),
});

export type MediaQueueToolsOptions = {
  mediaQueueRepo: MediaQueueRepository;
  queueMaster: QueueMaster;
};

export const createMediaQueueTools = ({
  mediaQueueRepo,
  queueMaster,
}: MediaQueueToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "submit-media-job",
      description:
        "Submit a media job to the OpenZigs queue. Supports image (txt2img, img2img), video, TTS, music (txt2music), voice conversion, and remix. Jobs are routed to the correct worker node.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: VALID_JOB_TYPES },
          prompt: { type: "string" },
          model: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
          steps: { type: "number" },
          guidance: { type: "number" },
          seed: { type: "number" },
          negative_prompt: { type: "string" },
          source_audio_asset_id: { type: "string" },
          voice_model: { type: "string" },
          target_instrument_id: { type: "string" },
          vibe: { type: "string", enum: ["punchy_pop", "warm_lofi", "cinematic_wide", "raw"] },
          priority: { type: "number" },
          project_id: { type: "string" },
          duration_seconds: { type: "number" },
          lyrics: { type: "string" },
          instrumental: { type: "boolean" },
          notify_via_telegram: { type: "boolean", description: "Send a Telegram notification when the job completes or fails" },
          telegram_chat_id: { type: "string", description: "Telegram chat ID to notify (uses configured admin chat ID if omitted)" },
        },
        required: ["type"],
      },
      zodSchema: submitMediaJobSchema,
      category: "productivity",
      riskLevel: "high",
      handler: async (args) => {
        try {
          const input = submitMediaJobSchema.parse(args);
          const model = input.model ?? defaultModelForJobType(input.type);
          const targetNode = targetNodeForJobType(input.type);

          const job = mediaQueueRepo.createJob({
            type: input.type,
            payload: {
              prompt: input.prompt ?? "",
              width: input.width,
              height: input.height,
              steps: input.steps,
              guidance_scale: input.guidance,
              seed: input.seed,
              negative_prompt: input.negative_prompt,
              model,
              source_asset_id: input.source_audio_asset_id,
              voice_model: input.voice_model,
              target_instrument_id: input.target_instrument_id,
              vibe: input.vibe,
              duration_seconds: input.duration_seconds,
              lyrics: input.lyrics,
              instrumental: input.instrumental,
            },
            model,
            projectId: input.project_id,
            priority: input.priority ?? 0,
            notifyViaTelegram: input.notify_via_telegram,
            telegramChatId: input.telegram_chat_id,
          });

          return {
            text: JSON.stringify({
              job_id: job.id,
              type: job.type,
              target_node: targetNode,
              model,
              status: job.status,
            }),
          };
        } catch (err) {
          return { text: `Error submitting job: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
    {
      name: "get-job-status",
      description:
        "Check the status of a media generation job or get all worker node health. Returns job status (pending/dispatched/processing/complete/failed), result URL, error messages, and worker node health.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID to check. Omit for node statuses only." },
          include_node_status: { type: "boolean", description: "Include worker node health" },
        },
      },
      zodSchema: getJobStatusSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = getJobStatusSchema.parse(args);
          const result: Record<string, unknown> = {};

          if (input.job_id) {
            const job = mediaQueueRepo.getJob(input.job_id);
            if (!job) return { text: `Job '${input.job_id}' not found.`, isError: true };
            result.job = {
              id: job.id,
              type: job.type,
              status: job.status,
              model: job.requiredModel,
              target_node: job.targetNode,
              result_url: job.resultUrl,
              result_metadata: job.resultMetadata,
              error: job.error,
              created_at: job.createdAt.toISOString(),
              completed_at: job.completedAt?.toISOString() ?? null,
            };
          }

          if (input.include_node_status) {
            const nodes = await queueMaster.getNodeStatuses();
            result.nodes = nodes;
          }

          return { text: JSON.stringify(result, null, 2) };
        } catch (err) {
          return { text: `Error checking status: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
