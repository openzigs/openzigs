/**
 * MCP Tools: Video Pipeline — clip extraction, reframing, audio cleaning,
 * captions, B-Roll, NLE export.
 * Issues #817-#828: OpusClip Feature Parity.
 */

import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ToolDefinition } from "../tool-registry.js";
import type { ClipExtractor } from "../../video/clip-extractor.js";
import type { ReframeWorker } from "../../video/reframe-worker.js";
import type { AudioCleaner } from "../../video/audio-cleaner.js";
import type { BRollPipeline } from "../../video/broll-pipeline.js";
import {
  getCaptionTemplate,
  getCaptionTemplateIds,
} from "../../video/caption-templates.js";
import {
  manifestToTimeline,
  exportFCPXML,
  exportEDL,
  type DirectorManifestForExport,
} from "../../video/nle-export.js";

// ── Schemas ─────────────────────────────────────────────────

/**
 * Extract a single frame from a video using ffmpeg.
 * Returns the path to the extracted frame, or null on failure.
 */
async function extractFrameFromVideo(
  videoPath: string,
  outputDir: string,
): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { nanoid } = await import("nanoid");

  const framePath = path.join(outputDir, `frame_${nanoid(8)}.jpg`);

  try {
    await execFileAsync("ffmpeg", [
      "-i",
      videoPath,
      "-ss",
      "1",
      "-vframes",
      "1",
      "-q:v",
      "2",
      "-y",
      framePath,
    ]);
    if (fs.existsSync(framePath)) return framePath;
    return null;
  } catch {
    return null;
  }
}

const clipVideoSchema = z.object({
  source: z.string().describe("File path or YouTube URL of the source video"),
  prompt: z
    .string()
    .optional()
    .describe("Natural language description of what clips to extract"),
  mode: z
    .enum(["auto", "prompt"])
    .default("auto")
    .describe("auto = AI decides, prompt = user-guided"),
  clip_count: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe("Target number of clips"),
  min_duration: z
    .number()
    .min(5)
    .default(15)
    .describe("Minimum clip duration in seconds"),
  max_duration: z
    .number()
    .min(10)
    .default(90)
    .describe("Maximum clip duration in seconds"),
  style: z
    .enum(["react", "highlight", "summarize", "teaser"])
    .default("highlight")
    .describe("Clip selection style"),
});

const reframeVideoSchema = z.object({
  source: z.string().describe("File path of the video to reframe"),
  target_aspect: z
    .enum(["9:16", "1:1", "16:9", "4:5"])
    .describe("Target aspect ratio"),
  layout: z
    .enum(["auto", "single-speaker", "split-screen", "gameplay", "action"])
    .default("auto")
    .describe("Content layout mode"),
  smoothing: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("Crop movement smoothness (0=linear, 1=full bezier)"),
});

const cleanAudioSchema = z.object({
  source: z.string().describe("Audio or video file path to clean"),
  remove_filler: z.boolean().default(true).describe("Remove filler words"),
  filler_words: z
    .array(z.string())
    .optional()
    .describe("Custom filler word list (extends defaults)"),
  trim_silence: z.boolean().default(true).describe("Trim excessive silence"),
  max_silence_duration: z
    .number()
    .min(0.1)
    .max(5)
    .default(0.5)
    .describe("Max pause duration in seconds"),
  aggressiveness: z
    .enum(["gentle", "moderate", "aggressive"])
    .default("moderate")
    .describe("Filler detection aggressiveness"),
  enhance_speech: z.boolean().default(false).describe("Normalize loudness"),
  de_noise: z.boolean().default(false).describe("Apply noise reduction"),
});

const addCaptionsSchema = z.object({
  source: z.string().describe("Video file path"),
  template: z
    .enum([
      "hormozi",
      "minimal",
      "tiktok",
      "news",
      "podcast",
      "corporate",
      "custom",
    ])
    .default("hormozi")
    .describe("Caption animation template"),
  position: z
    .enum(["top", "center", "bottom", "lower-third"])
    .optional()
    .describe("Caption position override"),
  highlight_color: z.string().optional().describe("Highlight color hex"),
  font: z.string().optional().describe("Font family override"),
  font_size: z.number().optional().describe("Font size override"),
  max_words_per_line: z
    .number()
    .min(1)
    .max(10)
    .default(5)
    .describe("Words per line"),
});

const autoBrollSchema = z.object({
  source: z.string().describe("Video file path"),
  mode: z
    .enum(["auto", "suggest", "custom"])
    .default("suggest")
    .describe(
      "auto=immediate, suggest=review first, custom=use provided assets",
    ),
  density: z
    .enum(["sparse", "moderate", "dense"])
    .default("moderate")
    .describe("B-Roll insertion frequency"),
  transition_style: z
    .enum(["crossfade", "cut", "zoom", "slide"])
    .default("crossfade")
    .describe("Transition between clips"),
});

const exportTimelineSchema = z.object({
  manifest_json: z.string().describe("Director manifest JSON string"),
  format: z.enum(["fcpxml", "edl"]).describe("Export format"),
  title: z.string().optional().describe("Timeline title"),
});

const generateThumbnailSchema = z.object({
  source: z.string().describe("Video file path"),
  title: z.string().optional().describe("Video title for text overlay"),
  template: z
    .enum(["reaction", "before-after", "list", "spotlight", "minimal", "auto"])
    .default("auto")
    .describe("Thumbnail layout template"),
  text_overlay: z.string().optional().describe("Custom overlay text"),
  count: z
    .number()
    .min(1)
    .max(6)
    .default(3)
    .describe("Number of variants to generate"),
});

// ── Factory ─────────────────────────────────────────────────

export interface VideoPipelineToolsOptions {
  clipExtractor?: ClipExtractor;
  reframeWorker?: ReframeWorker;
  audioCleaner?: AudioCleaner;
  brollPipeline?: BRollPipeline;
}

export const createVideoPipelineTools = (
  options: VideoPipelineToolsOptions,
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  // ── clip-video ──
  if (options.clipExtractor) {
    const clipExtractor = options.clipExtractor;
    tools.push({
      name: "clip-video",
      description:
        "Extract the best clips from a long video using multi-modal AI analysis. " +
        "Analyzes transcript, visual content, and audio to find viral-worthy segments. " +
        "Supports natural language prompts like 'find the funniest moments'.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "File path or YouTube URL" },
          prompt: { type: "string", description: "What to extract" },
          mode: { type: "string", description: "auto or prompt" },
          clip_count: { type: "number", description: "Target clip count" },
          min_duration: { type: "number", description: "Min seconds" },
          max_duration: { type: "number", description: "Max seconds" },
          style: {
            type: "string",
            description: "react|highlight|summarize|teaser",
          },
        },
        required: ["source"],
      },
      zodSchema: clipVideoSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = clipVideoSchema.parse(args);

          if (
            !fs.existsSync(input.source) &&
            !input.source.startsWith("http")
          ) {
            return { text: `Source not found: ${input.source}`, isError: true };
          }

          const jobId = await clipExtractor.submit({
            source: input.source,
            prompt: input.prompt,
            mode: input.mode,
            clipCount: input.clip_count,
            duration: { min: input.min_duration, max: input.max_duration },
            style: input.style,
          });

          try {
            const job = await clipExtractor.waitForCompletion(jobId, 600_000);
            return {
              text: JSON.stringify(
                {
                  jobId: job.id,
                  status: "complete",
                  clipCount: job.clips.length,
                  clips: job.clips.map((c) => ({
                    startTime: c.startTime,
                    endTime: c.endTime,
                    duration: Math.round(c.endTime - c.startTime),
                    viralityScore: c.viralityScore,
                    title: c.title,
                    description: c.description,
                    hookDetected: c.hookDetected,
                  })),
                },
                null,
                2,
              ),
            };
          } catch {
            return {
              text: JSON.stringify({
                jobId,
                status: "processing",
                message: "Job is still running. Check back with the job ID.",
              }),
            };
          }
        } catch (err) {
          return {
            text: `clip-video error: ${err instanceof Error ? err.message : err}`,
            isError: true,
          };
        }
      },
    });
  }

  // ── reframe-video ──
  if (options.reframeWorker) {
    const reframeWorker = options.reframeWorker;
    tools.push({
      name: "reframe-video",
      description:
        "Reframe a video to a different aspect ratio with AI subject tracking. " +
        "Automatically detects and follows the primary subject. " +
        "Supports single-speaker, split-screen, gameplay, and action modes.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Video file path" },
          target_aspect: {
            type: "string",
            description: "9:16, 1:1, 16:9, or 4:5",
          },
          layout: { type: "string", description: "Layout mode" },
          smoothing: { type: "number", description: "0-1 smoothness" },
        },
        required: ["source", "target_aspect"],
      },
      zodSchema: reframeVideoSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = reframeVideoSchema.parse(args);

          if (!fs.existsSync(input.source)) {
            return { text: `Source not found: ${input.source}`, isError: true };
          }

          const jobId = await reframeWorker.submit({
            source: input.source,
            targetAspect: input.target_aspect,
            layout: input.layout,
            smoothing: input.smoothing,
          });

          try {
            const job = await reframeWorker.waitForCompletion(jobId, 300_000);
            return {
              text: JSON.stringify(
                {
                  jobId: job.id,
                  status: "complete",
                  outputPath: job.outputPath,
                  targetAspect: job.targetAspect,
                  detectedLayout: job.detectedLayout,
                },
                null,
                2,
              ),
            };
          } catch {
            return {
              text: JSON.stringify({ jobId, status: "processing" }),
            };
          }
        } catch (err) {
          return {
            text: `reframe-video error: ${err instanceof Error ? err.message : err}`,
            isError: true,
          };
        }
      },
    });
  }

  // ── clean-audio ──
  if (options.audioCleaner) {
    const audioCleaner = options.audioCleaner;
    tools.push({
      name: "clean-audio",
      description:
        "Remove filler words (um, uh, like, you know) and trim excessive silence from audio or video. " +
        "Three aggressiveness levels. Optional noise reduction and speech enhancement.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Audio or video file path" },
          remove_filler: {
            type: "boolean",
            description: "Remove filler words",
          },
          trim_silence: { type: "boolean", description: "Trim long pauses" },
          aggressiveness: {
            type: "string",
            description: "gentle|moderate|aggressive",
          },
          enhance_speech: {
            type: "boolean",
            description: "Normalize loudness",
          },
          de_noise: { type: "boolean", description: "Reduce noise" },
        },
        required: ["source"],
      },
      zodSchema: cleanAudioSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = cleanAudioSchema.parse(args);

          if (!fs.existsSync(input.source)) {
            return { text: `Source not found: ${input.source}`, isError: true };
          }

          const jobId = await audioCleaner.submit({
            source: input.source,
            removeFiller: input.remove_filler,
            fillerWords: input.filler_words,
            trimSilence: input.trim_silence,
            maxSilenceDuration: input.max_silence_duration,
            aggressiveness: input.aggressiveness,
            enhanceSpeech: input.enhance_speech,
            deNoise: input.de_noise,
          });

          try {
            const job = await audioCleaner.waitForCompletion(jobId, 300_000);
            return {
              text: JSON.stringify(
                {
                  jobId: job.id,
                  status: "complete",
                  outputPath: job.outputPath,
                  removedFillers: job.removedFillers,
                  silenceTrimmed: job.silenceTrimmed,
                  durationSaved: `${job.durationSaved.toFixed(1)}s`,
                },
                null,
                2,
              ),
            };
          } catch {
            return { text: JSON.stringify({ jobId, status: "processing" }) };
          }
        } catch (err) {
          return {
            text: `clean-audio error: ${err instanceof Error ? err.message : err}`,
            isError: true,
          };
        }
      },
    });
  }

  // ── add-captions ──
  tools.push({
    name: "add-captions",
    description:
      "Apply animated captions to a video with configurable templates. " +
      `Available templates: ${getCaptionTemplateIds().join(", ")}. ` +
      "Supports word-level highlighting and brand kit integration.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Video file path" },
        template: { type: "string", description: "Caption template ID" },
        position: { type: "string", description: "Position override" },
        highlight_color: { type: "string", description: "Hex color" },
        max_words_per_line: { type: "number", description: "Words per line" },
      },
      required: ["source"],
    },
    zodSchema: addCaptionsSchema,
    category: "productivity",
    riskLevel: "low",
    handler: async (args) => {
      try {
        const input = addCaptionsSchema.parse(args);

        if (!fs.existsSync(input.source)) {
          return { text: `Source not found: ${input.source}`, isError: true };
        }

        const template =
          input.template !== "custom"
            ? getCaptionTemplate(input.template)
            : undefined;

        const config = template
          ? {
              ...template,
              ...(input.position && { position: input.position }),
              ...(input.highlight_color && {
                highlightColor: input.highlight_color,
              }),
              ...(input.font && { fontFamily: input.font }),
              ...(input.font_size && { fontSize: input.font_size }),
              maxWordsPerLine: input.max_words_per_line,
            }
          : { template: "custom" };

        return {
          text: JSON.stringify(
            {
              status: "configured",
              source: input.source,
              template: input.template,
              config,
              message:
                "Caption configuration ready. Apply via Director Studio render pipeline.",
            },
            null,
            2,
          ),
        };
      } catch (err) {
        return {
          text: `add-captions error: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  });

  // ── auto-broll ──
  if (options.brollPipeline) {
    const brollPipeline = options.brollPipeline;
    tools.push({
      name: "auto-broll",
      description:
        "Automatically identify and suggest B-Roll insertion points for a video. " +
        "Analyzes narration to find moments where B-Roll would enhance visual storytelling. " +
        "Sources from stock footage (Pexels/Pixabay), AI generation, or custom assets.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Video file path" },
          mode: { type: "string", description: "auto|suggest|custom" },
          density: { type: "string", description: "sparse|moderate|dense" },
          transition_style: {
            type: "string",
            description: "crossfade|cut|zoom|slide",
          },
        },
        required: ["source"],
      },
      zodSchema: autoBrollSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = autoBrollSchema.parse(args);

          if (!fs.existsSync(input.source)) {
            return { text: `Source not found: ${input.source}`, isError: true };
          }

          const jobId = await brollPipeline.submit({
            source: input.source,
            mode: input.mode,
            density: input.density,
            transitionStyle: input.transition_style,
          });

          try {
            const job = await brollPipeline.waitForCompletion(jobId, 300_000);
            return {
              text: JSON.stringify(
                {
                  jobId: job.id,
                  status: "complete",
                  suggestionCount: job.suggestions.length,
                  suggestions: job.suggestions.map((s) => ({
                    timestamp: s.timestamp,
                    duration: s.duration,
                    query: s.query,
                    context: s.context,
                    hasAsset: !!s.assetPath,
                  })),
                },
                null,
                2,
              ),
            };
          } catch {
            return { text: JSON.stringify({ jobId, status: "processing" }) };
          }
        } catch (err) {
          return {
            text: `auto-broll error: ${err instanceof Error ? err.message : err}`,
            isError: true,
          };
        }
      },
    });
  }

  // ── export-timeline ──
  tools.push({
    name: "export-timeline",
    description:
      "Export a Director manifest as FCP XML (for Premiere Pro, DaVinci Resolve, Final Cut Pro) " +
      "or EDL (CMX3600 format for universal NLE compatibility).",
    inputSchema: {
      type: "object",
      properties: {
        manifest_json: {
          type: "string",
          description: "Director manifest JSON",
        },
        format: { type: "string", description: "fcpxml or edl" },
        title: { type: "string", description: "Timeline title" },
      },
      required: ["manifest_json", "format"],
    },
    zodSchema: exportTimelineSchema,
    category: "productivity",
    riskLevel: "low",
    handler: async (args) => {
      try {
        const input = exportTimelineSchema.parse(args);
        let manifest: DirectorManifestForExport;

        try {
          manifest = JSON.parse(
            input.manifest_json,
          ) as DirectorManifestForExport;
        } catch {
          return { text: "Invalid manifest JSON", isError: true };
        }

        const timeline = manifestToTimeline(manifest, input.title);
        const output =
          input.format === "fcpxml"
            ? exportFCPXML(timeline)
            : exportEDL(timeline);

        const ext = input.format === "fcpxml" ? ".xml" : ".edl";
        const exportDir = path.join(os.homedir(), ".openzigs", "exports");
        fs.mkdirSync(exportDir, { recursive: true });
        const sanitizedName = timeline.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = path.join(
          exportDir,
          `${sanitizedName}_${Date.now()}${ext}`,
        );
        const resolved = path.resolve(outputPath);
        if (!resolved.startsWith(path.resolve(exportDir))) {
          return { text: "Invalid export path", isError: true };
        }
        fs.writeFileSync(resolved, output, "utf-8");

        return {
          text: JSON.stringify(
            {
              status: "complete",
              format: input.format,
              outputPath: path.basename(resolved),
              tracks: new Set(timeline.clips.map((c) => c.trackIndex)).size,
              clips: timeline.clips.filter((c) => c.type === "video").length,
              transitions: timeline.transitions.length,
            },
            null,
            2,
          ),
        };
      } catch (err) {
        return {
          text: `export-timeline error: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  });

  // ── generate-thumbnail (standalone) ──
  tools.push({
    name: "generate-thumbnail",
    description:
      "Generate YouTube-optimized thumbnails from a video. " +
      "Supports multiple templates (reaction, before-after, list, spotlight, minimal) " +
      "and batch variant generation for A/B testing.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Video file path" },
        title: { type: "string", description: "Video title" },
        template: { type: "string", description: "Thumbnail template" },
        text_overlay: { type: "string", description: "Custom overlay text" },
        count: { type: "number", description: "Variant count (1-6)" },
      },
      required: ["source"],
    },
    zodSchema: generateThumbnailSchema,
    category: "productivity",
    riskLevel: "low",
    handler: async (args) => {
      try {
        const input = generateThumbnailSchema.parse(args);

        if (!fs.existsSync(input.source)) {
          return { text: `Source not found: ${input.source}`, isError: true };
        }

        const { compositeThumbnail } =
          await import("../../video/thumbnails/thumbnail-compositor.js");
        const { nanoid } = await import("nanoid");

        const thumbnailDir = path.join(
          os.homedir(),
          ".openzigs",
          "video-output",
          "thumbnails",
        );
        if (!fs.existsSync(thumbnailDir)) {
          fs.mkdirSync(thumbnailDir, { recursive: true });
        }

        // Extract a frame from the video to use as background
        const framePath = await extractFrameFromVideo(
          input.source,
          thumbnailDir,
        );
        if (!framePath) {
          return {
            text: "Failed to extract frame from video. Ensure ffmpeg is installed.",
            isError: true,
          };
        }

        const titleText =
          input.title ??
          path.basename(input.source, path.extname(input.source));
        const overlayText = input.text_overlay ?? titleText;
        const variantCount = input.count ?? 3;

        const placements: Array<"top" | "center" | "bottom"> = [
          "bottom",
          "top",
          "center",
        ];
        const overlays: Array<
          "arrows" | "circles" | "emoji" | "badge" | undefined
        > = [undefined, "badge", "emoji", "arrows", "circles", undefined];

        const results: {
          path: string;
          variant: number;
          placement: string;
        }[] = [];

        for (let i = 0; i < variantCount; i++) {
          const id = nanoid(8);
          const outputPath = path.join(thumbnailDir, `thumb_${id}.jpg`);
          const placement = placements[i % placements.length];
          const overlay = overlays[i % overlays.length];

          await compositeThumbnail({
            backgroundPath: framePath,
            textLines: [overlayText.toUpperCase()],
            textPlacement: placement,
            textColor: "#ffffff",
            outputPath,
            outputFormat: "jpeg",
            clickbaitOverlay: overlay,
          });

          results.push({
            path: outputPath,
            variant: i + 1,
            placement,
          });
        }

        return {
          text: JSON.stringify(
            {
              status: "complete",
              source: input.source,
              template: input.template,
              title: titleText,
              thumbnailCount: results.length,
              thumbnails: results,
              outputDir: thumbnailDir,
            },
            null,
            2,
          ),
        };
      } catch (err) {
        return {
          text: `generate-thumbnail error: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  });

  return tools;
};
