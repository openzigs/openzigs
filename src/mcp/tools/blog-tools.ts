/**
 * MCP Tool: blog-to-video
 * Issue #319: Convert a blog post URL into a draft video manifest.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";

export interface BlogToolsOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
}

const blogToVideoSchema = z.object({
  url: z.string().url().describe("Blog post URL to convert into a video"),
  template: z.enum(["Minimalist", "ContentCreator", "Corporate", "TechDemo"]).optional()
    .describe("Video template (default: Minimalist)"),
  style_hint: z.string().optional()
    .describe("Visual style hint (e.g. 'corporate', 'playful', 'technical')"),
  image_provider: z.enum(["cloud", "local", "auto"]).optional()
    .describe("Image generation provider (default: auto)"),
  image_model: z.enum(["flux", "flux-schnell", "sdxl-turbo"]).optional()
    .describe("Local sidecar model to use"),
  music_track: z.string().optional()
    .describe("Path to background music file"),
  target_duration: z.number().min(30).max(600).optional()
    .describe("Target video duration in seconds (30–600, default: auto from text length)"),
});

export const createBlogTools = ({ copilot, voiceService }: BlogToolsOptions): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  tools.push({
    name: "blog-to-video",
    description:
      "Convert a blog post URL into a narrated video draft. " +
      "Fetches the article, rewrites as narration via LLM, generates a storyboard " +
      "with AI scene images and per-scene TTS voiceover. Returns a DirectorManifest " +
      "saved as a draft that can be edited in the Director Studio.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Blog post URL to convert" },
        template: {
          type: "string",
          enum: ["Minimalist", "ContentCreator", "Corporate", "TechDemo"],
          description: "Video template",
        },
        style_hint: { type: "string", description: "Visual style hint" },
        image_provider: {
          type: "string",
          enum: ["cloud", "local", "auto"],
          description: "Image provider",
        },
        image_model: {
          type: "string",
          enum: ["flux", "flux-schnell", "sdxl-turbo"],
          description: "Local image model",
        },
        music_track: { type: "string", description: "Background music path" },
        target_duration: { type: "number", description: "Target duration (30–600s)" },
      },
      required: ["url"],
    },
    zodSchema: blogToVideoSchema,
    category: "productivity",
    riskLevel: "high",
    handler: async (args) => {
      const {
        url,
        template,
        style_hint,
        image_provider,
        image_model,
        music_track,
        target_duration,
      } = args as z.infer<typeof blogToVideoSchema>;

      try {
        const { blogToVideo } = await import("../../video/blog/blog-to-video-pipeline.js");
        const result = await blogToVideo(
          {
            url,
            template: template ?? "Minimalist",
            styleHint: style_hint,
            imageProvider: image_provider ?? "auto",
            imageModel: image_model,
            musicTrackPath: music_track,
            targetDuration: target_duration,
          },
          copilot,
          voiceService,
        );

        return {
          text: JSON.stringify({
            manifest: result.manifest,
            blog: result.blog,
            storyboard: result.storyboard,
            processingTimeMs: result.processingTimeMs,
          }, null, 2),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `Error converting blog to video: ${message}`, isError: true };
      }
    },
  });

  return tools;
};
