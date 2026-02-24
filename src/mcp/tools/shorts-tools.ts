/**
 * MCP Tool: create-short
 * Issue #321: Convert a long-form video into a 30–60 second YouTube Short.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";

export interface ShortsToolsOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
}

const createShortSchema = z.object({
  source: z.string().describe("Path to source video or ID of existing library video"),
  style: z.enum(["react", "summarize", "highlight"]).optional().describe("Short style: react, summarize, or highlight"),
  target_duration: z.number().min(15).max(60).default(45).describe("Target duration in seconds (15–60)"),
  voice_profile: z.string().optional().describe("Voice profile name for TTS"),
});

export const createShortsTools = ({ copilot, voiceService }: ShortsToolsOptions): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  tools.push({
    name: "create-short",
    description:
      "Convert a long-form video into a 30-60 second YouTube Short. " +
      "Uses AI to identify the most viral/engaging segment, generates a punchy voiceover, " +
      "and outputs a 9:16 DirectorManifest ready for rendering with karaoke captions.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Path to source video or ID of existing library video" },
        style: { type: "string", enum: ["react", "summarize", "highlight"], description: "Short style" },
        target_duration: { type: "number", description: "Target duration (15–60 seconds, default 45)" },
        voice_profile: { type: "string", description: "Voice profile name for TTS" },
      },
      required: ["source"],
    },
    zodSchema: createShortSchema,
    category: "productivity",
    riskLevel: "high",
    handler: async (args) => {
      const { source, style, target_duration, voice_profile } =
        args as z.infer<typeof createShortSchema>;

      if (!voiceService) {
        return { text: "Error: VoiceService is not available. Shorts pipeline requires TTS.", isError: true };
      }

      try {
        const fsMod = await import("node:fs");
        if (!fsMod.existsSync(source)) {
          return { text: `Error: Source video not found: ${source}`, isError: true };
        }

        const { createShort } = await import("../../video/shorts/shorts-pipeline.js");
        const result = await createShort(
          {
            sourceVideo: source,
            style: style ?? "highlight",
            targetDuration: target_duration ?? 45,
            voiceProfile: voice_profile,
          },
          copilot,
          voiceService,
        );

        return {
          text: JSON.stringify({
            manifest: result.manifest,
            viralClip: result.viralClip,
            scriptText: result.scriptText,
            processingTimeMs: result.processingTimeMs,
          }, null, 2),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `Error creating Short: ${message}`, isError: true };
      }
    },
  });

  return tools;
};
