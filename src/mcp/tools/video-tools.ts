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
  clips: z.array(z.string()).optional().describe("Paths to input video clips (required for highlight/script modes)"),
  mode: z.enum(["highlight", "script", "presentation"]).describe("Production mode: 'highlight' for auto-edit, 'script' for narration-driven, 'presentation' for text-to-video"),
  scriptPath: z.string().optional().describe("Path to script file (required for 'script' mode)"),
  musicTrackPath: z.string().optional().describe("Path to background music track"),
  template: z.string().optional().describe("Template ID: 'Minimalist', 'ContentCreator', 'Corporate', 'TechDemo'"),
  voiceoverPath: z.string().optional().describe("Pre-generated voiceover path (skip TTS)"),
  inputFile: z.string().optional().describe("Path to .md or .txt file (required for 'presentation' mode)"),
  sourceType: z.enum(["text", "markdown"]).optional().describe("Type of input document for presentation mode"),
  imageProvider: z.enum(["cloud", "local", "auto"]).optional().describe("Image generation provider: 'cloud' (Vertex AI), 'local' (sidecar), 'auto' (failover)"),
  imageModel: z.enum(["flux", "sdxl-turbo"]).optional().describe("Local sidecar model to use: 'flux' (higher quality, slower) or 'sdxl-turbo' (faster, smaller). Only used when imageProvider is 'local' or 'auto'."),
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
      "Supports three modes: 'highlight' (auto-select best moments), 'script' (narration-driven with TTS voiceover), " +
      "and 'presentation' (transform text documents into narrated video presentations with AI-generated visuals). " +
      "Returns a JSON manifest that can be rendered into a final video.",
    inputSchema: {
      type: "object",
      properties: {
        clips: { type: "array", items: { type: "string" }, description: "Paths to input video clips (highlight/script modes)" },
        mode: { type: "string", enum: ["highlight", "script", "presentation"], description: "Production mode" },
        scriptPath: { type: "string", description: "Path to script file (script mode)" },
        musicTrackPath: { type: "string", description: "Path to background music" },
        template: { type: "string", description: "Template ID" },
        voiceoverPath: { type: "string", description: "Pre-generated voiceover path" },
        inputFile: { type: "string", description: "Path to .md or .txt file (presentation mode)" },
        sourceType: { type: "string", enum: ["text", "markdown"], description: "Input document type" },
        imageProvider: { type: "string", enum: ["cloud", "local", "auto"], description: "Image generation provider" },
        imageModel: { type: "string", enum: ["flux", "sdxl-turbo"], description: "Local sidecar model (only for local/auto)" },
      },
      required: ["mode"],
    },
    zodSchema: produceVideoSchema,
    category: "productivity",
    riskLevel: "high",
    handler: async (args) => {
      const { clips, mode, scriptPath, musicTrackPath, template, voiceoverPath, inputFile, sourceType, imageProvider, imageModel } =
        args as z.infer<typeof produceVideoSchema>;

      try {
        // Mode C: Presentation — text-to-video pipeline
        if (mode === "presentation") {
          if (!inputFile) {
            return { text: "Error: 'inputFile' is required for presentation mode", isError: true };
          }

          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const os = await import("node:os");
          const { StoryboardEngine } = await import("../../video/generators/storyboard-engine.js");
          const { ImageGenService } = await import("../../video/generators/image-gen-service.js");
          const { nanoid } = await import("nanoid");

          // Step A: Ingest the text document
          let rawText = await fs.readFile(inputFile, "utf-8");
          if (sourceType === "markdown" || inputFile.endsWith(".md")) {
            // Strip code blocks but keep headers for structure
            rawText = rawText.replace(/```[\s\S]*?```/g, "[code block removed]");
          }

          // Step B: Generate storyboard via LLM
          const storyboardEngine = new StoryboardEngine(copilot);
          const storyboard = await storyboardEngine.generate(rawText);

          // Step C: Generate images for each scene
          // Use persistent dir so macOS /tmp/ cleanup doesn't nuke images before render
          const imageOutputDir = path.join(os.homedir(), ".openzigs", "director", "images");
          await fs.mkdir(imageOutputDir, { recursive: true });
          const imageService = new ImageGenService({ outputDir: imageOutputDir });
          await imageService.initialize();

          const fps = 30;
          const templateId = (template as "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo") ?? "Minimalist";

          // Query sidecar for recommended resolution (falls back to 1024x576)
          let imageWidth = 1024;
          let imageHeight = 576;
          try {
            const sidecarHealth = await imageService.getRecommendedResolution();
            if (sidecarHealth) {
              imageWidth = sidecarHealth.width;
              imageHeight = sidecarHealth.height;
            }
          } catch {
            // Use defaults if sidecar health check fails
          }

          // Build timeline entries for the DirectorManifest
          const timeline: Array<import("../../video/manifest/manifest-types.js").ImageSceneEntry | import("../../video/manifest/manifest-types.js").TransitionEntry> = [];
          let currentFrame = 0;

          for (const scene of storyboard.scenes) {
            const imageResult = await imageService.generateImage(scene.imagePrompt, {
              provider: imageProvider ?? "auto",
              localModel: imageModel,
              width: imageWidth,
              height: imageHeight,
            });

            // Generate per-scene voiceover if VoiceService is available
            let sceneVoiceoverPath: string | undefined;
            if (voiceService && scene.voiceover) {
              try {
                if (!voiceService.isReady() && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                  await voiceService.initialize();
                }
                if (voiceService.isReady()) {
                  const ttsResult = await voiceService.synthesize(scene.voiceover);
                  const voPath = path.join(os.tmpdir(), `openzigs-vo-${nanoid(8)}.mp3`);
                  await fs.writeFile(voPath, ttsResult.audio);
                  sceneVoiceoverPath = voPath;
                }
              } catch {
                // TTS failure is non-fatal for scene processing
              }
            }

            const durationInFrames = Math.round(scene.durationEstimate * fps);

            // Add crossfade transition between scenes (not before the first)
            if (timeline.length > 0) {
              const transitionDuration = Math.min(15, durationInFrames);
              timeline.push({
                type: "transition",
                style: "crossfade",
                duration: transitionDuration,
                startAtFrame: currentFrame,
              });
              // Transitions overlap, so don't advance currentFrame
            }

            timeline.push({
              type: "image_scene",
              src: imageResult.filePath,
              startAtFrame: currentFrame,
              duration: durationInFrames,
              voiceover: sceneVoiceoverPath,
              voiceoverVolume: 1.0,
              kenBurns: {
                scaleFrom: 1.0,
                scaleTo: 1.15,
                translateXFrom: 0,
                translateXTo: scene.index % 2 === 0 ? -10 : 10, // Alternate pan direction
                translateYFrom: 0,
                translateYTo: -5,
              },
            });

            currentFrame += durationInFrames;
          }

          // Step D: Construct the DirectorManifest
          const manifest: import("../../video/manifest/manifest-types.js").DirectorManifest = {
            projectTitle: storyboard.title,
            templateId,
            composition: { width: 1920, height: 1080, fps },
            audioLayer: {
              music: musicTrackPath ? {
                track: musicTrackPath,
                volume: 0.12,
                ducking: true,
                fadeInFrames: 30,
                fadeOutFrames: 30,
                loop: true,
              } : null,
              voiceover: voiceoverPath ? {
                source: voiceoverPath,
                volume: 1.0,
                startAtFrame: 0,
              } : null,
            },
            timeline,
            metadata: {
              generatedAt: new Date().toISOString(),
              llmModel: "copilot",
              llmTokensUsed: storyboard.tokensUsed,
              productionMode: "presentation",
              sourceClips: [],
              estimatedRenderTime: currentFrame / fps,
            },
          };

          return {
            text: JSON.stringify({
              mode: "presentation",
              manifest,
              storyboard: {
                title: storyboard.title,
                styleAnchor: storyboard.styleAnchor,
                analysis: storyboard.analysis,
                sceneCount: storyboard.scenes.length,
              },
              scenes: storyboard.scenes.map((scene, i) => ({
                index: i,
                voiceover: scene.voiceover,
                imagePrompt: scene.imagePrompt,
                durationEstimate: scene.durationEstimate,
                imagePath: timeline.find(
                  (t): t is import("../../video/manifest/manifest-types.js").ImageSceneEntry =>
                    t.type === "image_scene" && (t as import("../../video/manifest/manifest-types.js").ImageSceneEntry).src !== undefined,
                )?.src,
              })),
              tokensUsed: storyboard.tokensUsed,
              totalDuration: currentFrame / fps,
            }, null, 2),
          };
        }

        // Mode A/B: Highlight / Script — existing pipeline
        if (!clips || clips.length === 0) {
          return { text: "Error: 'clips' is required for highlight/script modes", isError: true };
        }

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
