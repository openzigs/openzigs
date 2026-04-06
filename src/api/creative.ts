/**
 * Creative Studio API routes — AI-powered inpainting via the media queue,
 * plus image manipulation endpoints (resize, crop, filter, convert, watermark).
 * Issue #777: Inpainting workflows backed by Flux Kontext on the image-gen sidecar.
 * Issue #811: Image manipulation REST API using Sharp.
 */

import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import QRCode from "qrcode";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { logger } from "../logging/logger.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type { CopilotWrapperService } from "../copilot/index.js";

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const ALLOWED_DIRS = [
  GALLERY_DIR,
  path.join(os.homedir(), ".openzigs"),
  os.homedir(),
];

function resolveImagePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const galleryPath = path.join(GALLERY_DIR, filePath);
  if (fs.existsSync(galleryPath)) return galleryPath;
  return filePath;
}

function generateOutputPath(
  sourcePath: string,
  suffix: string,
  ext?: string,
): string {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const outputExt = ext ?? path.extname(sourcePath);
  return path.join(GALLERY_DIR, `${base}_${suffix}_${Date.now()}${outputExt}`);
}

function validatePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_DIRS.some(
    (dir) => resolved.startsWith(dir + path.sep) || resolved === dir,
  );
  if (!allowed) {
    throw new Error("Path not allowed: must be under home directory");
  }
  return resolved;
}

// ── Image generation models available on the Mac Mini sidecar ──────────────────
export const IMAGE_GEN_MODELS = [
  {
    id: "flux-kontext",
    name: "Flux Kontext",
    description: "Text-guided semantic editing — best for inpainting",
  },
  {
    id: "flux-dev",
    name: "Flux Dev",
    description: "High-quality 25-step image generation",
  },
  {
    id: "flux-schnell",
    name: "Flux Schnell",
    description: "Fast 4-step model",
  },
  {
    id: "z-image-turbo",
    name: "Z-Image Turbo",
    description: "Fast 4-step LoRA-compatible model",
  },
] as const;

const VALID_IMAGE_MODEL_IDS = IMAGE_GEN_MODELS.map((m) => m.id);

export interface CreativeRouterOptions {
  mediaQueueRepo: MediaQueueRepository;
  copilotWrapper?: CopilotWrapperService;
  imageProcessingSidecarUrl?: string;
}

// Multer: accept image + mask files, 20 MB each
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const PLATFORM_LIMITS: Record<
  string,
  { maxChars: number; maxHashtags: number; style: string }
> = {
  twitter: {
    maxChars: 280,
    maxHashtags: 3,
    style: "concise, punchy, conversational",
  },
  instagram: {
    maxChars: 2200,
    maxHashtags: 30,
    style: "engaging, visual storytelling, emoji-friendly",
  },
  linkedin: {
    maxChars: 3000,
    maxHashtags: 5,
    style: "professional, thought leadership, insightful",
  },
  facebook: {
    maxChars: 63206,
    maxHashtags: 5,
    style: "conversational, community-oriented",
  },
  pinterest: {
    maxChars: 500,
    maxHashtags: 20,
    style: "keyword-rich, SEO-optimized, descriptive",
  },
  youtube: {
    maxChars: 5000,
    maxHashtags: 15,
    style: "detailed, keyword-optimized, hook in first line",
  },
  reddit: {
    maxChars: 40000,
    maxHashtags: 0,
    style: "authentic, community-aware, no promotional language",
  },
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function createCreativeRouter({
  mediaQueueRepo,
  copilotWrapper,
  imageProcessingSidecarUrl,
}: CreativeRouterOptions): Router {
  const router = Router();

  /**
   * POST /inpaint
   * Accepts multipart form: image (required), mask (optional), prompt (required), style_id (optional).
   * Queues an img2img job with flux-kontext model via the media queue.
   */
  router.post(
    "/inpaint",
    upload.fields([
      { name: "image", maxCount: 1 },
      { name: "mask", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as
          | Record<string, Express.Multer.File[]>
          | undefined;
        const imageFile = files?.["image"]?.[0];
        if (!imageFile) {
          res.status(400).json({ error: "image file is required" });
          return;
        }

        const prompt = (req.body as Record<string, string>).prompt?.trim();
        if (!prompt) {
          res.status(400).json({ error: "prompt is required" });
          return;
        }

        const MAX_PROMPT_LENGTH = 2000;
        if (prompt.length > MAX_PROMPT_LENGTH) {
          res.status(400).json({
            error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters`,
          });
          return;
        }

        const styleId = (req.body as Record<string, string>).style_id ?? "";
        const requestedModel =
          (req.body as Record<string, string>).model?.trim() ?? "";
        const selectedModel = VALID_IMAGE_MODEL_IDS.includes(
          requestedModel as (typeof VALID_IMAGE_MODEL_IDS)[number],
        )
          ? requestedModel
          : "flux-kontext";

        // Convert uploaded image to base64
        const imageBase64 = imageFile.buffer.toString("base64");

        // Build prompt — prepend style instruction if specified
        const styledPrompt = styleId ? `${styleId} style: ${prompt}` : prompt;

        // Kontext uses a slightly higher strength (semantic editing);
        // other models use img2img style transfer strength.
        const strength = selectedModel === "flux-kontext" ? 0.85 : 0.75;

        // Create an img2img queue job. QueueMaster routes flux-kontext to
        // /kontext-async and all other models to /img2img-async.
        const job = mediaQueueRepo.createJob({
          type: "img2img",
          payload: {
            prompt: styledPrompt,
            init_image: imageBase64,
            strength,
          },
          model: selectedModel,
          priority: 1,
        });

        logger.info(
          `[CreativeRouter] Inpaint job queued: ${job.id} (prompt="${prompt.slice(0, 80)}")`,
        );

        res.status(202).json({
          jobId: job.id,
          status: job.status,
          message:
            "Inpainting job queued. Poll /api/queue/jobs/:id for status, or wait for the result in the Gallery.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[CreativeRouter] Inpaint error: ${msg}`);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // ── Image Model List ─────────────────────────────────────────

  /** GET /image-models — list available image generation models on the Mac Mini sidecar */
  router.get("/image-models", (_req, res) => {
    res.json({ models: IMAGE_GEN_MODELS });
  });

  // ── AI Prompt Enhancement ─────────────────────────────────────

  /**
   * POST /enhance-prompt
   * Uses the LLM to rewrite a raw inpainting prompt into a more descriptive,
   * effective image generation prompt.
   * Body: { prompt: string }
   */
  router.post("/enhance-prompt", async (req, res) => {
    try {
      const body = req.body as Record<string, string>;
      const rawPrompt = body.prompt?.trim();
      if (!rawPrompt) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }
      if (rawPrompt.length > 2000) {
        res.status(400).json({ error: "prompt exceeds 2000 characters" });
        return;
      }
      if (!copilotWrapper) {
        res.status(503).json({ error: "AI service not available" });
        return;
      }

      const systemPrompt = [
        "You are an expert at writing AI image generation prompts for inpainting workflows.",
        "Improve the following prompt to be more descriptive and effective for AI image generation.",
        "Keep the core intent exactly, but add specific visual details, lighting, texture, and composition guidance.",
        "The prompt should describe WHAT should appear in the painted region.",
        "Return ONLY the improved prompt text — no preamble, no quotes, no explanations.",
        `\nOriginal prompt: ${rawPrompt}`,
      ].join("\n");

      let enhanced = "";
      for await (const chunk of copilotWrapper.chat(systemPrompt, {
        availableTools: [],
      })) {
        enhanced += chunk;
      }

      res.json({ enhancedPrompt: enhanced.trim() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Enhance-prompt error: ${msg}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Image Manipulation Endpoints (Issue #811) ──────────────

  /** POST /resize — resize an image */
  router.post("/resize", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const filePath = body.file_path as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "file_path is required" });
        return;
      }
      const width = typeof body.width === "number" ? body.width : undefined;
      const height = typeof body.height === "number" ? body.height : undefined;
      if (!width && !height) {
        res
          .status(400)
          .json({ error: "At least one of width or height is required" });
        return;
      }
      const fit = (typeof body.fit === "string" ? body.fit : "inside") as
        | "cover"
        | "contain"
        | "fill"
        | "inside"
        | "outside";

      const sourcePath = validatePath(resolveImagePath(filePath));
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: `File not found: ${filePath}` });
        return;
      }

      const outputPath = generateOutputPath(
        sourcePath,
        `${width ?? "auto"}x${height ?? "auto"}`,
      );
      await sharp(sourcePath).resize(width, height, { fit }).toFile(outputPath);
      const meta = await sharp(outputPath).metadata();

      res.json({
        success: true,
        outputPath,
        width: meta.width,
        height: meta.height,
        format: meta.format,
        sizeBytes: meta.size,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Resize error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /crop — crop an image */
  router.post("/crop", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const filePath = body.file_path as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "file_path is required" });
        return;
      }
      const left = body.left as number | undefined;
      const top = body.top as number | undefined;
      const width = body.width as number | undefined;
      const height = body.height as number | undefined;
      if (left == null || top == null || width == null || height == null) {
        res
          .status(400)
          .json({ error: "left, top, width, and height are required" });
        return;
      }

      const sourcePath = validatePath(resolveImagePath(filePath));
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: `File not found: ${filePath}` });
        return;
      }

      const outputPath = generateOutputPath(sourcePath, "cropped");
      await sharp(sourcePath)
        .extract({ left, top, width, height })
        .toFile(outputPath);

      res.json({ success: true, outputPath, width, height });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Crop error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /filter — apply a visual filter */
  router.post("/filter", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const filePath = body.file_path as string | undefined;
      const filter = body.filter as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "file_path is required" });
        return;
      }
      const validFilters = [
        "grayscale",
        "blur",
        "sharpen",
        "negate",
        "normalize",
        "sepia",
      ];
      if (!filter || !validFilters.includes(filter)) {
        res
          .status(400)
          .json({ error: `filter must be one of: ${validFilters.join(", ")}` });
        return;
      }
      const intensity =
        typeof body.intensity === "number" ? body.intensity : undefined;

      const sourcePath = validatePath(resolveImagePath(filePath));
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: `File not found: ${filePath}` });
        return;
      }

      const outputPath = generateOutputPath(sourcePath, filter);
      let pipeline = sharp(sourcePath);
      switch (filter) {
        case "grayscale":
          pipeline = pipeline.grayscale();
          break;
        case "blur":
          pipeline = pipeline.blur(intensity ?? 3);
          break;
        case "sharpen":
          pipeline = pipeline.sharpen(intensity ?? 1);
          break;
        case "negate":
          pipeline = pipeline.negate();
          break;
        case "normalize":
          pipeline = pipeline.normalize();
          break;
        case "sepia":
          pipeline = pipeline.grayscale().tint({ r: 112, g: 66, b: 20 });
          break;
      }
      await pipeline.toFile(outputPath);

      res.json({ success: true, outputPath, filter });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Filter error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /convert — convert image format */
  router.post("/convert", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const filePath = body.file_path as string | undefined;
      const format = body.format as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "file_path is required" });
        return;
      }
      const validFormats = ["png", "jpeg", "webp", "avif", "tiff"];
      if (!format || !validFormats.includes(format)) {
        res
          .status(400)
          .json({ error: `format must be one of: ${validFormats.join(", ")}` });
        return;
      }
      const quality = typeof body.quality === "number" ? body.quality : 80;

      const sourcePath = validatePath(resolveImagePath(filePath));
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: `File not found: ${filePath}` });
        return;
      }

      const outputPath = generateOutputPath(
        sourcePath,
        "converted",
        `.${format}`,
      );
      await sharp(sourcePath)
        .toFormat(format as keyof sharp.FormatEnum, { quality })
        .toFile(outputPath);
      const stat = fs.statSync(outputPath);

      res.json({ success: true, outputPath, format, sizeBytes: stat.size });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Convert error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /watermark — add a watermark overlay */
  router.post("/watermark", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const filePath = body.file_path as string | undefined;
      const watermarkPath = body.watermark_path as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "file_path is required" });
        return;
      }
      if (!watermarkPath || typeof watermarkPath !== "string") {
        res.status(400).json({ error: "watermark_path is required" });
        return;
      }

      const position = (
        typeof body.position === "string" ? body.position : "bottom-right"
      ) as string;
      const opacity = typeof body.opacity === "number" ? body.opacity : 0.5;
      const scale = typeof body.scale === "number" ? body.scale : 0.2;

      const sourcePath = validatePath(resolveImagePath(filePath));
      const wmPath = validatePath(resolveImagePath(watermarkPath));
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: `Source file not found: ${filePath}` });
        return;
      }
      if (!fs.existsSync(wmPath)) {
        res
          .status(404)
          .json({ error: `Watermark file not found: ${watermarkPath}` });
        return;
      }

      const sourceMetadata = await sharp(sourcePath).metadata();
      const srcW = sourceMetadata.width ?? 800;
      const srcH = sourceMetadata.height ?? 600;
      const wmWidth = Math.round(srcW * scale);

      const watermark = await sharp(wmPath)
        .resize(wmWidth)
        .ensureAlpha(opacity)
        .toBuffer();
      const wmMeta = await sharp(watermark).metadata();
      const wmH = wmMeta.height ?? 50;

      let top = 0;
      let left = 0;
      const margin = 10;
      switch (position) {
        case "top-left":
          top = margin;
          left = margin;
          break;
        case "top-right":
          top = margin;
          left = srcW - wmWidth - margin;
          break;
        case "bottom-left":
          top = srcH - wmH - margin;
          left = margin;
          break;
        case "bottom-right":
          top = srcH - wmH - margin;
          left = srcW - wmWidth - margin;
          break;
        case "center":
          top = Math.round((srcH - wmH) / 2);
          left = Math.round((srcW - wmWidth) / 2);
          break;
      }

      const outputPath = generateOutputPath(sourcePath, "watermarked");
      await sharp(sourcePath)
        .composite([
          {
            input: watermark,
            top: Math.max(0, top),
            left: Math.max(0, left),
          },
        ])
        .toFile(outputPath);

      res.json({ success: true, outputPath, position });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Watermark error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Background Removal (Issue #767) ─────────────────────────

  /** POST /remove-background — AI background removal via image-processing sidecar */
  router.post("/remove-background", async (req, res) => {
    try {
      if (!imageProcessingSidecarUrl) {
        res
          .status(503)
          .json({ error: "Image processing sidecar not configured" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const filePath = body.file_path as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "file_path is required" });
        return;
      }
      const model = (
        typeof body.model === "string" ? body.model : "u2net"
      ) as string;
      const validModels = ["u2net", "u2net_human_seg", "isnet-general-use"];
      if (!validModels.includes(model)) {
        res
          .status(400)
          .json({ error: `model must be one of: ${validModels.join(", ")}` });
        return;
      }
      const alphaMatting = body.alpha_matting === true;

      const sourcePath = validatePath(resolveImagePath(filePath));
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: `File not found: ${filePath}` });
        return;
      }

      const imageBuffer = fs.readFileSync(sourcePath);
      const base64Image = imageBuffer.toString("base64");

      const response = await fetch(
        `${imageProcessingSidecarUrl}/remove-background`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: base64Image,
            model,
            alpha_matting: alphaMatting,
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        res
          .status(502)
          .json({ error: `Sidecar error (${response.status}): ${errText}` });
        return;
      }

      const result = (await response.json()) as {
        image: string;
        width: number;
        height: number;
      };
      fs.mkdirSync(GALLERY_DIR, { recursive: true });
      const baseName = path.basename(sourcePath, path.extname(sourcePath));
      const outputPath = path.join(
        GALLERY_DIR,
        `${baseName}_nobg_${Date.now()}.png`,
      );
      fs.writeFileSync(outputPath, Buffer.from(result.image, "base64"));

      res.json({
        success: true,
        outputPath,
        model,
        width: result.width,
        height: result.height,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Remove-background error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Image Upscale (Issue #768) ─────────────────────────────

  /** POST /upscale — AI super-resolution via image-processing sidecar */
  router.post("/upscale", async (req, res) => {
    try {
      if (!imageProcessingSidecarUrl) {
        res
          .status(503)
          .json({ error: "Image processing sidecar not configured" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const filePath = body.file_path as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        res.status(400).json({ error: "file_path is required" });
        return;
      }
      const scale = typeof body.scale === "number" ? body.scale : 2;
      if (scale !== 2 && scale !== 4) {
        res.status(400).json({ error: "scale must be 2 or 4" });
        return;
      }

      const sourcePath = validatePath(resolveImagePath(filePath));
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: `File not found: ${filePath}` });
        return;
      }

      const imageBuffer = fs.readFileSync(sourcePath);
      const base64Image = imageBuffer.toString("base64");
      const ext = path.extname(sourcePath).slice(1) || "png";

      const response = await fetch(`${imageProcessingSidecarUrl}/upscale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64Image, format: ext, scale }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        res
          .status(502)
          .json({ error: `Sidecar error (${response.status}): ${errText}` });
        return;
      }

      const result = (await response.json()) as {
        image: string;
        width: number;
        height: number;
      };
      fs.mkdirSync(GALLERY_DIR, { recursive: true });
      const baseName = path.basename(sourcePath, path.extname(sourcePath));
      const outputPath = path.join(
        GALLERY_DIR,
        `${baseName}_upscaled_${scale}x_${Date.now()}.png`,
      );
      fs.writeFileSync(outputPath, Buffer.from(result.image, "base64"));

      res.json({
        success: true,
        outputPath,
        scale,
        width: result.width,
        height: result.height,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Upscale error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── QR Code Generation (Issue #773) ────────────────────────

  /** POST /qr-code — generate a QR code (PNG or SVG) */
  router.post("/qr-code", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const content = body.content as string | undefined;
      if (
        !content ||
        typeof content !== "string" ||
        content.length < 1 ||
        content.length > 4096
      ) {
        res.status(400).json({ error: "content is required (1-4096 chars)" });
        return;
      }
      const format = (
        typeof body.format === "string" ? body.format : "png"
      ) as string;
      if (!["png", "svg"].includes(format)) {
        res.status(400).json({ error: "format must be png or svg" });
        return;
      }
      const width =
        typeof body.width === "number"
          ? Math.min(2000, Math.max(100, body.width))
          : 400;
      const colorDark =
        typeof body.color_dark === "string" ? body.color_dark : "#000000";
      const colorLight =
        typeof body.color_light === "string" ? body.color_light : "#ffffff";
      if (!HEX_RE.test(colorDark) || !HEX_RE.test(colorLight)) {
        res.status(400).json({ error: "Colors must be hex format (#RRGGBB)" });
        return;
      }
      const errorCorrection = (
        typeof body.error_correction === "string" ? body.error_correction : "M"
      ) as "L" | "M" | "Q" | "H";
      const margin =
        typeof body.margin === "number"
          ? Math.min(10, Math.max(0, body.margin))
          : 4;

      fs.mkdirSync(GALLERY_DIR, { recursive: true });

      if (format === "svg") {
        const svgString = await QRCode.toString(content, {
          type: "svg",
          width,
          margin,
          color: { dark: colorDark, light: colorLight },
          errorCorrectionLevel: errorCorrection,
        });
        const outputPath = path.join(GALLERY_DIR, `qr_${Date.now()}.svg`);
        fs.writeFileSync(outputPath, svgString);
        res.json({ success: true, format: "svg", outputPath, content, width });
      } else {
        const outputPath = path.join(GALLERY_DIR, `qr_${Date.now()}.png`);
        await QRCode.toFile(outputPath, content, {
          width,
          margin,
          color: { dark: colorDark, light: colorLight },
          errorCorrectionLevel: errorCorrection,
        });
        const stat = fs.statSync(outputPath);
        res.json({
          success: true,
          format: "png",
          outputPath,
          content,
          width,
          sizeBytes: stat.size,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] QR code error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Social Caption Generation (Issue #772) ─────────────────

  /** POST /caption — generate a platform-optimized caption via LLM */
  router.post("/caption", async (req, res) => {
    try {
      if (!copilotWrapper) {
        res.status(503).json({ error: "AI service not available" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const topic = body.topic as string | undefined;
      const platform = body.platform as string | undefined;
      if (!topic || typeof topic !== "string") {
        res.status(400).json({ error: "topic is required" });
        return;
      }
      if (!platform || !PLATFORM_LIMITS[platform]) {
        res
          .status(400)
          .json({
            error: `platform must be one of: ${Object.keys(PLATFORM_LIMITS).join(", ")}`,
          });
        return;
      }
      const tone = typeof body.tone === "string" ? body.tone : "casual";
      const includeCta = body.include_cta === true;
      const includeEmoji = body.include_emoji !== false;
      const context = typeof body.context === "string" ? body.context : "";

      const limits = PLATFORM_LIMITS[platform];
      const systemPrompt =
        "You are an expert social media copywriter. Generate a single caption optimized for the specified platform. " +
        "Follow the platform's character limits and style conventions exactly. " +
        "Return ONLY the caption text — no explanations, no labels, no formatting.";
      const userPrompt = [
        `Platform: ${platform} (max ${limits.maxChars} chars, style: ${limits.style})`,
        `Topic: ${topic}`,
        `Tone: ${tone}`,
        includeCta ? "Include a call-to-action." : "",
        includeEmoji ? "Include relevant emojis." : "No emojis.",
        context ? `Brand context: ${context}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      let caption = "";
      for await (const chunk of copilotWrapper.chat(
        `${systemPrompt}\n\nUser: ${userPrompt}`,
        { availableTools: [] },
      )) {
        caption += chunk;
      }
      caption = caption.trim();

      res.json({
        platform,
        caption,
        charCount: caption.length,
        maxChars: limits.maxChars,
        withinLimit: caption.length <= limits.maxChars,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Caption error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Hashtag Generation (Issue #772) ────────────────────────

  /** POST /hashtags — generate platform-optimized hashtags via LLM */
  router.post("/hashtags", async (req, res) => {
    try {
      if (!copilotWrapper) {
        res.status(503).json({ error: "AI service not available" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const topic = body.topic as string | undefined;
      const platform = body.platform as string | undefined;
      if (!topic || typeof topic !== "string") {
        res.status(400).json({ error: "topic is required" });
        return;
      }
      const validPlatforms = [
        "twitter",
        "instagram",
        "linkedin",
        "facebook",
        "pinterest",
        "youtube",
      ];
      if (!platform || !validPlatforms.includes(platform)) {
        res
          .status(400)
          .json({
            error: `platform must be one of: ${validPlatforms.join(", ")}`,
          });
        return;
      }
      const count =
        typeof body.count === "number"
          ? Math.min(30, Math.max(1, body.count))
          : 10;
      const includeTrending = body.include_trending !== false;
      const nicheLevel =
        typeof body.niche_level === "string" ? body.niche_level : "medium";

      const limits = PLATFORM_LIMITS[platform];
      const maxTags = Math.min(count, limits.maxHashtags || 30);

      const systemPrompt =
        "You are a social media hashtag strategist. Generate hashtags optimized for the specified platform. " +
        "Return ONLY a JSON array of objects with 'tag' (without #) and 'category' (broad/medium/niche) fields. " +
        "No explanations — just the JSON array.";
      const userPrompt = [
        `Platform: ${platform}`,
        `Topic: ${topic}`,
        `Count: ${maxTags}`,
        `Focus: ${nicheLevel} specificity`,
        includeTrending
          ? "Include popular/trending tags where relevant."
          : "Focus on evergreen tags.",
      ].join("\n");

      let response = "";
      for await (const chunk of copilotWrapper.chat(
        `${systemPrompt}\n\nUser: ${userPrompt}`,
        { availableTools: [] },
      )) {
        response += chunk;
      }
      response = response.trim();

      let hashtags: Array<{ tag: string; category: string }>;
      try {
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        hashtags = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      } catch {
        const words = response.match(/#?\w+/g) ?? [];
        hashtags = words.slice(0, maxTags).map((w) => ({
          tag: w.replace(/^#/, ""),
          category: nicheLevel,
        }));
      }

      res.json({
        platform,
        hashtags: hashtags.slice(0, maxTags).map((h) => ({
          tag: `#${h.tag.replace(/^#/, "")}`,
          category: h.category,
        })),
        count: Math.min(hashtags.length, maxTags),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Hashtags error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /generate-template — generate a post template body via LLM */
  router.post("/generate-template", async (req, res) => {
    try {
      if (!copilotWrapper) {
        res.status(503).json({ error: "AI service not available" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const prompt = body.prompt as string | undefined;
      const platform = body.platform as string | undefined;
      const variables = Array.isArray(body.variables)
        ? (body.variables as string[])
        : [];
      const model =
        typeof body.model === "string" && body.model ? body.model : undefined;

      if (!prompt || typeof prompt !== "string") {
        res.status(400).json({ error: "prompt is required" });
        return;
      }
      if (!platform || typeof platform !== "string") {
        res.status(400).json({ error: "platform is required" });
        return;
      }

      const limits = PLATFORM_LIMITS[platform] ?? {
        maxChars: 2200,
        style: "general",
      };

      const variableInstructions =
        variables.length > 0
          ? `The template MUST use these exact variable placeholders where appropriate: ${variables.map((v) => `{{${v}}}`).join(", ")}. Do not invent other variables.`
          : "You may introduce {{variable_name}} placeholders for any values that would naturally vary (e.g. {{product_name}}, {{brand}}, {{promo_code}}). Use 1–4 variables at most.";

      const systemPrompt =
        "You are an expert social media copywriter. Generate a reusable post template optimized for the specified platform. " +
        "A template uses {{variable_name}} syntax for values that will be filled in later. " +
        "Return ONLY the template text — no explanations, no labels, no markdown fences, no extra commentary.";

      const userPrompt = [
        `Platform: ${platform} (max ${limits.maxChars} chars, style: ${limits.style})`,
        `Description / goal: ${prompt}`,
        variableInstructions,
        "Write the complete template now:",
      ].join("\n");

      let template = "";
      for await (const chunk of copilotWrapper.chat(
        `${systemPrompt}\n\nUser: ${userPrompt}`,
        { availableTools: [], ...(model ? { model } : {}) },
      )) {
        template += chunk;
      }
      template = template.trim();

      res.json({ template });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CreativeRouter] Generate-template error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
