import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { MediaQueueRepository } from "../../queue/media-queue-repository.js";

const remixSessionSchema = z.object({
  action: z.enum(["analyze", "replace_stem", "master", "get_session"]),
  source_audio_asset_id: z.string().optional().describe("Gallery asset ID of source audio (required for 'analyze')"),
  analyze_job_id: z.string().optional().describe("Job ID from analyze step (required for 'replace_stem' and 'master')"),
  stem_name: z.enum(["vocals", "bass", "drums", "guitar", "piano", "other"]).optional().describe("Stem to replace"),
  target_instrument: z
    .enum([
      "acoustic_guitar", "electric_guitar", "piano", "synth_pad",
      "strings", "brass", "flute", "organ", "marimba", "steel_drum",
    ])
    .optional()
    .describe("Replacement instrument"),
  vibe: z.enum(["punchy_pop", "warm_lofi", "cinematic_wide", "raw"]).optional().describe("Mastering vibe preset"),
  reference_track_path: z.string().optional().describe("Reference audio path for mastering tonal matching"),
  notify_via_telegram: z.boolean().optional().describe("Send a Telegram notification when the job completes or fails"),
  telegram_chat_id: z.string().optional().describe("Telegram chat ID to notify (uses configured admin chat ID if omitted)"),
});

export type RemixToolsOptions = {
  mediaQueueRepo: MediaQueueRepository;
};

export const createRemixTools = ({ mediaQueueRepo }: RemixToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "remix-session-manager",
      description:
        "Orchestrate multi-step Smart Remix Lab sessions. Manages the stateful pipeline: analyze (6-stem split + BPM/key) → replace instruments → auto-master. Each step's output feeds the next.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["analyze", "replace_stem", "master", "get_session"] },
          source_audio_asset_id: { type: "string" },
          analyze_job_id: { type: "string" },
          stem_name: { type: "string", enum: ["vocals", "bass", "drums", "guitar", "piano", "other"] },
          target_instrument: {
            type: "string",
            enum: [
              "acoustic_guitar", "electric_guitar", "piano", "synth_pad",
              "strings", "brass", "flute", "organ", "marimba", "steel_drum",
            ],
          },
          vibe: { type: "string", enum: ["punchy_pop", "warm_lofi", "cinematic_wide", "raw"] },
          reference_track_path: { type: "string" },
          notify_via_telegram: { type: "boolean", description: "Send a Telegram notification when the job completes or fails" },
          telegram_chat_id: { type: "string", description: "Telegram chat ID to notify (uses configured admin chat ID if omitted)" },
        },
        required: ["action"],
      },
      zodSchema: remixSessionSchema,
      category: "productivity",
      riskLevel: "high",
      handler: async (args) => {
        try {
          const input = remixSessionSchema.parse(args);

          switch (input.action) {
            case "analyze": {
              if (!input.source_audio_asset_id) {
                return { text: "source_audio_asset_id is required for 'analyze'.", isError: true };
              }
              const asset = mediaQueueRepo.getAsset(input.source_audio_asset_id);
              if (!asset) {
                return { text: `Asset '${input.source_audio_asset_id}' not found in gallery.`, isError: true };
              }
              const job = mediaQueueRepo.createJob({
                type: "remix_analyze",
                payload: {
                  prompt: "",
                  source_asset_id: input.source_audio_asset_id,
                  device: "cpu",
                },
                model: "htdemucs_6s",
                notifyViaTelegram: input.notify_via_telegram,
                telegramChatId: input.telegram_chat_id,
              });
              return {
                text: JSON.stringify({ job_id: job.id, status: job.status, action: "analyze" }),
              };
            }

            case "replace_stem": {
              if (!input.analyze_job_id) {
                return { text: "analyze_job_id is required for 'replace_stem'.", isError: true };
              }
              if (!input.stem_name || !input.target_instrument) {
                return { text: "stem_name and target_instrument are required for 'replace_stem'.", isError: true };
              }
              const analyzeJob = mediaQueueRepo.getJob(input.analyze_job_id);
              if (!analyzeJob) {
                return { text: `Analyze job '${input.analyze_job_id}' not found.`, isError: true };
              }
              if (analyzeJob.status !== "complete") {
                return {
                  text: `Analyze job is '${analyzeJob.status}', not complete. Wait for completion before replacing stems.`,
                  isError: true,
                };
              }
              const meta = analyzeJob.resultMetadata as Record<string, unknown> | null;
              const stems = (meta?.stems ?? {}) as Record<string, string>;
              const stemPath = stems[input.stem_name];
              if (!stemPath) {
                return {
                  text: `Stem '${input.stem_name}' not found in analysis results. Available: ${Object.keys(stems).join(", ")}`,
                  isError: true,
                };
              }

              const replaceJob = mediaQueueRepo.createJob({
                type: "remix_replace",
                payload: {
                  prompt: "",
                  source_stem_url: stemPath,
                  target_instrument_id: input.target_instrument,
                  original_bpm: meta?.bpm as number | undefined,
                  original_key: meta?.key as string | undefined,
                },
                model: "basic-pitch",
                notifyViaTelegram: input.notify_via_telegram,
                telegramChatId: input.telegram_chat_id,
              });
              return {
                text: JSON.stringify({
                  job_id: replaceJob.id,
                  status: replaceJob.status,
                  action: "replace_stem",
                  stem: input.stem_name,
                  instrument: input.target_instrument,
                }),
              };
            }

            case "master": {
              if (!input.analyze_job_id) {
                return { text: "analyze_job_id is required for 'master'.", isError: true };
              }
              const analyzeJob = mediaQueueRepo.getJob(input.analyze_job_id);
              if (!analyzeJob || analyzeJob.status !== "complete") {
                return { text: "Analyze job must be complete before mastering.", isError: true };
              }
              const meta = analyzeJob.resultMetadata as Record<string, unknown> | null;
              const stems = (meta?.stems ?? {}) as Record<string, string>;

              const masterJob = mediaQueueRepo.createJob({
                type: "remix_master",
                payload: {
                  prompt: "",
                  stem_paths: stems,
                  vibe: input.vibe ?? "raw",
                },
                model: "matchering",
                notifyViaTelegram: input.notify_via_telegram,
                telegramChatId: input.telegram_chat_id,
              });
              return {
                text: JSON.stringify({
                  job_id: masterJob.id,
                  status: masterJob.status,
                  action: "master",
                  vibe: input.vibe ?? "raw",
                }),
              };
            }

            case "get_session": {
              if (!input.analyze_job_id) {
                return { text: "analyze_job_id is required for 'get_session'.", isError: true };
              }
              const job = mediaQueueRepo.getJob(input.analyze_job_id);
              if (!job) return { text: `Job '${input.analyze_job_id}' not found.`, isError: true };
              return {
                text: JSON.stringify({
                  analyze_job: {
                    id: job.id,
                    status: job.status,
                    result_metadata: job.resultMetadata,
                    error: job.error,
                  },
                }),
              };
            }

            default:
              return { text: `Unknown action: ${input.action}`, isError: true };
          }
        } catch (err) {
          return { text: `Remix error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
