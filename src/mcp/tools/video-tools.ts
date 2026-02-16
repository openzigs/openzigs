/**
 * MCP Tool registration for Director Mode (Video Production).
 * Exposes `produce-video`, `list-templates`, `search-assets` tools.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";

export interface VideoToolsOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
}

const produceVideoSchema = z.object({
  clips: z.array(z.string()).min(1).describe("Paths to input video clips"),
  mode: z.enum(["highlight", "script"]).describe("Production mode: 'highlight' for auto-edit, 'script' for narration-driven"),
  scriptPath: z.string().optional().describe("Path to script file (required for 'script' mode)"),
  musicTrackPath: z.string().optional().describe("Path to background music track"),
  template: z.string().optional().describe("Template ID: 'Minimalist', 'ContentCreator', 'Corporate', 'TechDemo'"),
  voiceoverPath: z.string().optional().describe("Pre-generated voiceover path (skip TTS)"),
});

const listTemplatesSchema = z.object({
  tag: z.string().optional().describe("Filter templates by tag (e.g. 'social', 'professional')"),
});

const searchAssetsSchema = z.object({
  query: z.string().describe("Search query for music/sound effects"),
  source: z.enum(["local", "pixabay", "jamendo", "pexels", "all"]).optional().describe("Asset source to search (default: 'all')"),
  type: z.enum(["music", "sfx", "image", "video"]).optional().describe("Asset type filter"),
  maxResults: z.number().optional().describe("Maximum results to return (default: 10)"),
});

export const createVideoTools = ({ copilot, voiceService }: VideoToolsOptions): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  // ── produce-video ──
  tools.push({
    name: "produce-video",
    description:
      "Analyze input video clips and produce a Director Manifest (edit decision list) using a single-shot LLM call. " +
      "Supports two modes: 'highlight' (auto-select best moments) and 'script' (narration-driven with TTS voiceover). " +
      "Returns a JSON manifest that can be rendered into a final video.",
    inputSchema: {
      type: "object",
      properties: {
        clips: { type: "array", items: { type: "string" }, description: "Paths to input video clips" },
        mode: { type: "string", enum: ["highlight", "script"], description: "Production mode" },
        scriptPath: { type: "string", description: "Path to script file (script mode)" },
        musicTrackPath: { type: "string", description: "Path to background music" },
        template: { type: "string", description: "Template ID" },
        voiceoverPath: { type: "string", description: "Pre-generated voiceover path" },
      },
      required: ["clips", "mode"],
    },
    zodSchema: produceVideoSchema,
    category: "productivity",
    riskLevel: "high",
    handler: async (args) => {
      const { clips, mode, scriptPath, musicTrackPath, template, voiceoverPath } =
        args as z.infer<typeof produceVideoSchema>;

      try {
        // Lazy-load heavy modules
        const { ingest } = await import("../../video/ingestion/index.js");
        const { ProducerService } = await import("../../video/producer/producer-service.js");

        // Ingest clips
        const ingestionResult = await ingest(
          { clips, mode: mode === "script" ? "script" : "highlight" },
          {},
        );

        // Produce manifest
        const producer = new ProducerService(copilot, voiceService);
        const result = await producer.produce({
          mode: mode as "highlight" | "script",
          contextPayload: ingestionResult.contextPayload,
          scriptPath,
          musicTrackPath,
          preferredTemplate: template,
          voiceoverPath,
        });

        return {
          text: JSON.stringify({
            manifest: result.manifest,
            tokensUsed: result.tokensUsed,
            clipsProcessed: ingestionResult.clips.length,
            totalDuration: ingestionResult.clips.reduce((sum, c) => sum + c.duration, 0),
          }, null, 2),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `Error producing video: ${message}`, isError: true };
      }
    },
  });

  // ── list-templates ──
  tools.push({
    name: "list-templates",
    description: "List available video templates with their default configurations and supported features.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter by tag" },
      },
    },
    zodSchema: listTemplatesSchema,
    category: "productivity",
    riskLevel: "low",
    handler: async (args) => {
      const { tag } = args as z.infer<typeof listTemplatesSchema>;

      const { createTemplateRegistry } = await import("../../video/templates/template-registry.js");
      const registry = createTemplateRegistry();

      const templates = tag ? registry.getByTag(tag) : registry.getAll();

      const summary = templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        aspectRatio: t.aspectRatio,
        fps: t.defaultComposition.fps,
        transition: t.defaultTransition,
        tags: t.tags,
      }));

      return { text: JSON.stringify(summary, null, 2) };
    },
  });

  // ── search-assets ──
  tools.push({
    name: "search-assets",
    description:
      "Search for royalty-free music, sound effects, and images from local library, Pixabay, Jamendo, and Pexels. " +
      "Returns metadata including license, duration, and preview URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        source: { type: "string", enum: ["local", "pixabay", "jamendo", "pexels", "all"], description: "Source" },
        type: { type: "string", enum: ["music", "sfx", "image", "video"], description: "Asset type" },
        maxResults: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
    zodSchema: searchAssetsSchema,
    category: "productivity",
    riskLevel: "low",
    handler: async (args) => {
      const { query, source, type, maxResults } = args as z.infer<typeof searchAssetsSchema>;

      try {
        const { AssetManager } = await import("../../video/assets/asset-manager.js");
        const manager = new AssetManager({
          localLibraryPath: "~/.openzigs/director/library",
          downloadCachePath: "~/.openzigs/director/cache",
          pixabay: { enabled: false, apiKey: "" },
          jamendo: { enabled: false, clientId: "" },
          pexels: { enabled: false, apiKey: "" },
        });
        await manager.initialize();

        const results = await manager.search({
          query,
          source: source ?? "all",
          type,
          perPage: maxResults ?? 10,
        });

        return { text: JSON.stringify(results, null, 2) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `Error searching assets: ${message}`, isError: true };
      }
    },
  });

  return tools;
};
