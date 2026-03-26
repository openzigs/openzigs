import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { VoiceService } from "../../voice/voice-service.js";

const synthesizeSpeechSchema = z.object({
  action: z.enum(["synthesize", "list_voices", "health", "switch_engine"]),
  text: z.string().optional().describe("Text to synthesize (for synthesize)"),
  voice: z.string().optional().describe("Voice preset ID (e.g., 'af_heart', 'am_adam')"),
  engine: z.enum(["kokoro", "f5tts"]).optional().describe("TTS engine (for switch_engine)"),
});

export type VoiceToolsOptions = {
  voiceService: VoiceService;
};

export const createVoiceTools = ({ voiceService }: VoiceToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "synthesize-speech",
      description:
        "Text-to-speech synthesis with 54+ voice presets across Kokoro and F5-TTS engines. List available voices, check sidecar health, or generate speech audio.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["synthesize", "list_voices", "health", "switch_engine"] },
          text: { type: "string" },
          voice: { type: "string" },
          engine: { type: "string", enum: ["kokoro", "f5tts"] },
        },
        required: ["action"],
      },
      zodSchema: synthesizeSpeechSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = synthesizeSpeechSchema.parse(args);

          switch (input.action) {
            case "synthesize": {
              if (!input.text) return { text: "'text' is required for synthesis.", isError: true };
              if (!voiceService.isReady()) {
                return { text: "TTS sidecar is not ready. Check audio sidecar status.", isError: true };
              }
              const result = await voiceService.synthesize(input.text, input.voice);
              return {
                text: JSON.stringify({
                  success: true,
                  cached: result.cached,
                  duration_ms: result.durationMs,
                  content_type: result.contentType ?? "audio/wav",
                  size_bytes: result.audio.length,
                }),
              };
            }
            case "list_voices": {
              return { text: "Use the audio sidecar /voices endpoint to list available voice presets." };
            }
            case "health": {
              const health = await voiceService.getSidecarHealth();
              return { text: JSON.stringify(health, null, 2) };
            }
            case "switch_engine": {
              if (!input.engine) return { text: "'engine' is required for switch_engine.", isError: true };
              return { text: `Engine switch to '${input.engine}' requested. Use the audio sidecar /switch_engine endpoint.` };
            }
            default:
              return { text: `Unknown action: ${input.action}`, isError: true };
          }
        } catch (err) {
          return { text: `TTS error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
