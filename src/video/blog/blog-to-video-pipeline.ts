/**
 * Director Mode — Blog-to-YouTube Pipeline Orchestrator
 * Issue #319: End-to-end pipeline converting a blog post URL into a
 * draft DirectorManifest ready for Studio editing and rendering.
 *
 * Pipeline: URL → Fetch & Parse → Download Images → Vision Caption → Storyboard → Image Gen → Voiceover → Draft
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { logger } from "../../logging/logger.js";
import { extractBlog, validateUrl } from "./blog-extractor.js";
import { StoryboardEngine, type StoryboardOptions } from "../generators/storyboard-engine.js";
import { ImageGenService } from "../generators/image-gen-service.js";
import type { CopilotWrapper, SdkAttachment } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";
import type {
  DirectorManifest,
  ImageSceneEntry,
  TitleCardEntry,
  TransitionEntry,
} from "../manifest/manifest-types.js";

// ── Types ────────────────────────────────────────────────────

export interface BlogToVideoInput {
  /** Blog post URL */
  url: string;
  /** Template ID (default: "Minimalist") */
  template?: "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo";
  /** Style hint for the storyboard (e.g. "corporate", "playful") */
  styleHint?: string;
  /** Image provider: cloud, local, or auto */
  imageProvider?: "cloud" | "local" | "auto";
  /** Local image model: flux-schnell, flux, flux-dev, or sdxl-turbo */
  imageModel?: "flux-schnell" | "flux" | "flux-dev" | "sdxl-turbo";
  /** Background music path */
  musicTrackPath?: string;
  /** LLM model override */
  model?: string;
  /** Target video duration in seconds (default: auto) */
  targetDuration?: number;
  /** Brand voice prompt block to inject into storyboard narration */
  brandVoiceBlock?: string;
}

export interface BlogToVideoResult {
  /** The completed DirectorManifest */
  manifest: DirectorManifest;
  /** Extracted blog metadata */
  blog: {
    title: string;
    description: string;
    wordCount: number;
    imageCount: number;
    resolvedUrl: string;
  };
  /** Storyboard summary */
  storyboard: {
    title: string;
    styleAnchor: string;
    sceneCount: number;
    analysis: { tone: string; audience: string; coreThemes: string[] };
  };
  /** Processing time in ms */
  processingTimeMs: number;
}

// ── Pipeline ─────────────────────────────────────────────────

/**
 * Run the full Blog-to-YouTube pipeline.
 *
 * 1. Fetch & parse the blog URL
 * 2. LLM storyboard generation (rewrite blog as narrated video)
 * 3. Generate images per scene (download blog images where available)
 * 4. Generate per-scene TTS voiceover
 * 5. Build DirectorManifest
 */
export async function blogToVideo(
  input: BlogToVideoInput,
  copilot: CopilotWrapper,
  voiceService?: VoiceService,
): Promise<BlogToVideoResult> {
  const startTime = Date.now();
  const {
    url,
    template = "Minimalist",
    styleHint,
    imageProvider = "auto",
    imageModel,
    musicTrackPath,
    model,
    targetDuration,
  } = input;

  const outputDir = path.join(os.homedir(), ".openzigs", "director", "blog");
  await fs.mkdir(outputDir, { recursive: true });

  // ── Step 1: Fetch & Parse Blog ──────────────────────────────
  logger.info(`[BlogToVideo] Step 1: Fetching blog from ${url}`);
  const blog = await extractBlog(url);

  logger.info(
    `[BlogToVideo] Extracted: "${blog.metadata.title}" — ` +
    `${blog.wordCount} words, ${blog.images.length} images`,
  );

  // ── Step 2: Download Blog Images & Vision Captioning ─────────
  logger.info("[BlogToVideo] Step 2: Downloading blog images and generating captions…");

  const blogImagesToProcess = blog.images.slice(0, 20);
  const downloadedBlogImages = await downloadBlogImages(blogImagesToProcess, outputDir);

  // Vision captioning: send each downloaded image to the LLM for a real description
  const visionCaptions = await captionBlogImages(
    blogImagesToProcess,
    downloadedBlogImages,
    copilot,
    model,
  );

  // ── Step 3: LLM Storyboard Generation ──────────────────────
  logger.info("[BlogToVideo] Step 3: Generating storyboard via LLM…");

  const storyboardEngine = new StoryboardEngine(copilot);
  const storyboardOptions: StoryboardOptions = {};
  if (styleHint) storyboardOptions.styleHint = styleHint;
  if (model) storyboardOptions.model = model;
  if (targetDuration) storyboardOptions.targetDuration = targetDuration;

  // Provide blog images as visual asset context with vision captions and positional context
  if (blogImagesToProcess.length > 0) {
    storyboardOptions.visualAssets = blogImagesToProcess.map((img, i) => ({
      description: visionCaptions[i] || img.alt || "Blog article image",
      type: "image" as const,
      positionHint: img.surroundingText || undefined,
    }));
  }

  // Pass brand voice through to storyboard engine
  if (input.brandVoiceBlock) {
    storyboardOptions.brandVoiceBlock = input.brandVoiceBlock;
  }

  const storyboard = await storyboardEngine.generate(blog.text, storyboardOptions);

  logger.info(
    `[BlogToVideo] Storyboard: "${storyboard.title}" — ${storyboard.scenes.length} scenes, ` +
    `style: "${storyboard.styleAnchor.substring(0, 50)}…"`,
  );

  // ── Step 4: Image Generation Setup ───────────────────────────
  logger.info("[BlogToVideo] Step 4: Setting up image generation…");

  const imageOutputDir = path.join(os.homedir(), ".openzigs", "director", "images");
  await fs.mkdir(imageOutputDir, { recursive: true });

  const imageGenUserConfig = await ImageGenService.loadUserImageGenConfig();
  let imageService = new ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
  await imageService.initialize();

  // Pre-flight: verify the image node is actually ready before committing to a
  // 5-min-per-scene generation loop. In network mode, the remote node accepts
  // connections even while the model is loading — generating against it hangs
  // for the full localTimeoutMs on every scene. Fall back to the local sidecar
  // instead so blog images and AI-gen scenes work without a long stall.
  if (imageService.isNetworkMode) {
    const health = await imageService.checkHealth();
    if (!health.local) {
      logger.warn(
        "[BlogToVideo] Network image node not ready (model may still be loading) — " +
        "falling back to local sidecar for this run",
      );
      imageService = new ImageGenService({ outputDir: imageOutputDir, imageGenMode: "local" });
      await imageService.initialize();
    }
  }

  // Fixed 16:9 video frame resolution — do not query sidecar.
  // The sidecar's "recommended resolution" is intended for standalone
  // generation (e.g. Flux native 1024x1024) which is square and slows down
  // MPS-based models by 3–5×. For video we target 768×432 and keep generation
  // fast.
  const imageWidth = 768;
  const imageHeight = 432;

  // ── Step 5: Build Timeline with Images + Voiceover ──────────
  logger.info("[BlogToVideo] Step 5: Building timeline with images and voiceover…");

  const fps = 30;
  const timeline: Array<ImageSceneEntry | TitleCardEntry | TransitionEntry> = [];
  let currentFrame = 0;
  const baseSeed = Date.now() % 100_000;

  for (const scene of storyboard.scenes) {
    // Resolve image: use LLM-assigned blog image or generate
    let sceneImagePath: string;
    const assignedImageIdx = scene.blogImageIndex;
    const hasBlogImage = assignedImageIdx != null
      && assignedImageIdx >= 0
      && assignedImageIdx < downloadedBlogImages.length
      && downloadedBlogImages[assignedImageIdx];

    if (hasBlogImage) {
      sceneImagePath = downloadedBlogImages[assignedImageIdx]!;
      logger.info(`[BlogToVideo] Scene ${scene.index}: using blog image #${assignedImageIdx}`);
    } else if (!imageService) {
      logger.warn(`[BlogToVideo] Scene ${scene.index}: no blog image and no image service — skipping`);
      continue;
    } else {
      // Throttle cloud requests
      if (imageProvider !== "local" && scene.index > 0) {
        await new Promise((r) => setTimeout(r, 15_000));
      }

      logger.info(
        `[BlogToVideo] Scene ${scene.index}: generating image — ` +
        `"${scene.rawImageDescription.substring(0, 50)}…"`,
      );

      try {
        const result = await imageService.generateImage(scene.imagePrompt, {
          provider: imageProvider,
          localModel: imageModel,
          width: imageWidth,
          height: imageHeight,
          seed: baseSeed + scene.index * 1000,
        });
        sceneImagePath = result.filePath;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[BlogToVideo] Image gen failed for scene ${scene.index}: ${msg}`);
        continue;
      }
    }

    // Generate per-scene voiceover
    let sceneVoiceoverPath: string | undefined;
    if (voiceService && scene.voiceover) {
      try {
        if (!voiceService.isReady()) {
          await voiceService.initialize();
        }
        if (voiceService.isReady()) {
          const { nanoid } = await import("nanoid");
          const ttsResult = await voiceService.synthesize(scene.voiceover);
          const audioExt = ttsResult.contentType === "audio/wav" ? "wav" : "mp3";
          const voPath = path.join(imageOutputDir, `openzigs-blog-vo-${nanoid(8)}.${audioExt}`);
          await fs.writeFile(voPath, ttsResult.audio);
          sceneVoiceoverPath = voPath;
        }
      } catch {
        // TTS failure is non-fatal
      }
    }

    // Compute duration from voiceover or estimate
    let sceneDurationSec = scene.durationEstimate;
    if (sceneVoiceoverPath) {
      const measured = await probeAudioDuration(sceneVoiceoverPath);
      if (measured && measured > 0) {
        sceneDurationSec = Math.max(measured + 0.35, 2);
      }
    }

    const durationInFrames = Math.max(Math.round(sceneDurationSec * fps), fps);

    // Chapter title card
    if (scene.chapterTitle) {
      const CHAPTER_CARD_DURATION = 90; // 3s at 30fps

      if (timeline.length > 0) {
        timeline.push({
          type: "transition",
          style: "crossfade",
          duration: 15,
          startAtFrame: currentFrame,
        });
      }

      timeline.push({
        type: "title_card",
        title: scene.chapterTitle,
        startAtFrame: currentFrame,
        duration: CHAPTER_CARD_DURATION,
        animation: "fade",
      });
      currentFrame += CHAPTER_CARD_DURATION;
    }

    // Crossfade transition
    if (timeline.length > 0) {
      timeline.push({
        type: "transition",
        style: "crossfade",
        duration: Math.min(15, durationInFrames),
        startAtFrame: currentFrame,
      });
    }

    // Image scene with Ken Burns
    timeline.push({
      type: "image_scene",
      src: sceneImagePath,
      startAtFrame: currentFrame,
      duration: durationInFrames,
      voiceover: sceneVoiceoverPath,
      voiceoverVolume: 1.0,
      scriptText: scene.voiceover,
      kenBurns: {
        scaleFrom: 1.0,
        scaleTo: 1.15,
        translateXFrom: 0,
        translateXTo: scene.index % 2 === 0 ? -10 : 10,
        translateYFrom: 0,
        translateYTo: -5,
      },
      textOverlays: scene.textOverlays,
    });

    currentFrame += durationInFrames;
  }

  // ── Step 6: Construct Manifest ──────────────────────────────
  logger.info("[BlogToVideo] Step 6: Building DirectorManifest…");

  const manifest: DirectorManifest = {
    projectTitle: storyboard.title,
    templateId: template,
    composition: { width: 1920, height: 1080, fps },
    audioLayer: {
      music: musicTrackPath
        ? {
            track: musicTrackPath,
            volume: 0.08,
            ducking: true,
            fadeInFrames: 30,
            fadeOutFrames: 30,
            loop: true,
          }
        : null,
      voiceover: null,
    },
    timeline,
    metadata: {
      generatedAt: new Date().toISOString(),
      llmModel: model ?? "copilot",
      llmTokensUsed: storyboard.tokensUsed,
      productionMode: "presentation",
      sourceClips: [],
      estimatedRenderTime: currentFrame / fps,
    },
  };

  const processingTimeMs = Date.now() - startTime;
  logger.info(
    `[BlogToVideo] Complete: ${timeline.filter((t) => t.type === "image_scene").length} scenes, ` +
    `${(currentFrame / fps).toFixed(1)}s, ${processingTimeMs}ms`,
  );

  return {
    manifest,
    blog: {
      title: blog.metadata.title,
      description: blog.metadata.description,
      wordCount: blog.wordCount,
      imageCount: blog.images.length,
      resolvedUrl: blog.resolvedUrl,
    },
    storyboard: {
      title: storyboard.title,
      styleAnchor: storyboard.styleAnchor,
      sceneCount: storyboard.scenes.length,
      analysis: storyboard.analysis,
    },
    processingTimeMs,
  };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Download blog images to a local directory.
 * Returns array of local file paths (null for failed downloads).
 */
async function downloadBlogImages(
  images: Array<{ url: string; alt: string }>,
  outputDir: string,
): Promise<Array<string | null>> {
  const results: Array<string | null> = [];

  for (const img of images) {
    try {
      // Validate the URL before fetching to prevent SSRF
      let parsedUrl: URL;
      try {
        parsedUrl = validateUrl(img.url);
      } catch {
        results.push(null);
        continue;
      }

      const response = await fetch(parsedUrl.href, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OpenZigs/1.0)",
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });

      if (!response.ok) {
        results.push(null);
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        results.push(null);
        continue;
      }

      // Determine extension from content-type
      const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
      const { nanoid } = await import("nanoid");
      const filename = `blog-img-${nanoid(8)}${ext}`;
      const filePath = path.join(outputDir, filename);

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(filePath, buffer);
      results.push(filePath);

      logger.info(`[BlogToVideo] Downloaded blog image: ${img.url.substring(0, 60)}… → ${filename}`);
    } catch {
      results.push(null);
    }
  }

  return results;
}

/**
 * Probe audio file duration using ffprobe.
 */
async function probeAudioDuration(filePath: string): Promise<number | null> {
  const { spawn } = await import("node:child_process");
  return new Promise<number | null>((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const duration = Number.parseFloat(stdout.trim());
      resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
    });
  });
}

/**
 * Send downloaded blog images to the LLM for vision-based captioning.
 * Returns an array of captions (same indices as input images).
 * Falls back to null for images that couldn't be captioned.
 */
async function captionBlogImages(
  blogImages: Array<{ url: string; alt: string }>,
  downloadedPaths: Array<string | null>,
  copilot: CopilotWrapper,
  model?: string,
): Promise<Array<string | null>> {
  const captions: Array<string | null> = new Array(blogImages.length).fill(null);

  // Collect images that were downloaded successfully
  const toCaption: Array<{ index: number; filePath: string; alt: string }> = [];
  for (let i = 0; i < blogImages.length; i++) {
    if (downloadedPaths[i]) {
      toCaption.push({ index: i, filePath: downloadedPaths[i]!, alt: blogImages[i].alt });
    }
  }

  if (toCaption.length === 0) {
    logger.info("[BlogToVideo] No downloaded images to caption — skipping vision pass");
    return captions;
  }

  logger.info(`[BlogToVideo] Vision captioning ${toCaption.length} blog images…`);

  // Caption images in parallel batches of 5 to avoid rate limits
  const BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < toCaption.length; batchStart += BATCH_SIZE) {
    const batch = toCaption.slice(batchStart, batchStart + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async ({ index, filePath, alt }) => {
        try {
          const attachment: SdkAttachment = {
            type: "file",
            path: filePath,
            displayName: path.basename(filePath),
          };

          const prompt =
            "Describe this image in 1-2 concise sentences for a video storyboard. " +
            "Focus on: what is depicted, key visual details, mood/setting. " +
            "Be specific and factual. Do not speculate about what you cannot see." +
            (alt ? `\n\nThe image's alt text is: "${alt}"` : "");

          let caption = "";
          for await (const chunk of copilot.chat(prompt, {
            model,
            attachments: [attachment],
          })) {
            caption += chunk;
          }

          caption = caption.trim();
          if (caption.length > 0) {
            return { index, caption };
          }
          return { index, caption: null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[BlogToVideo] Vision captioning failed for image ${index}: ${msg}`);
          return { index, caption: null };
        }
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value.caption) {
        captions[result.value.index] = result.value.caption;
        logger.info(
          `[BlogToVideo] Captioned image ${result.value.index}: ` +
          `"${result.value.caption.substring(0, 80)}…"`,
        );
      }
    }
  }

  const successCount = captions.filter(Boolean).length;
  logger.info(`[BlogToVideo] Vision captioning complete: ${successCount}/${toCaption.length} succeeded`);

  return captions;
}
