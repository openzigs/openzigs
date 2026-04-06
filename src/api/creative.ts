/**
 * Creative Studio API routes — AI-powered inpainting via the media queue,
 * plus image manipulation endpoints (resize, crop, filter, convert, watermark).
 * Issue #777: Inpainting workflows backed by Flux Kontext on the image-gen sidecar.
 * Issue #811: Image manipulation REST API using Sharp.
 */

import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { logger } from "../logging/logger.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";

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

export interface CreativeRouterOptions {
  mediaQueueRepo: MediaQueueRepository;
}

// Multer: accept image + mask files, 20 MB each
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

export function createCreativeRouter({
  mediaQueueRepo,
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

        // Convert uploaded image to base64
        const imageBase64 = imageFile.buffer.toString("base64");

        // Build prompt — prepend style instruction if specified
        const styledPrompt = styleId ? `${styleId} style: ${prompt}` : prompt;

        // Create an img2img queue job targeting flux-kontext
        const job = mediaQueueRepo.createJob({
          type: "img2img",
          payload: {
            prompt: styledPrompt,
            init_image: imageBase64,
            strength: 0.85,
          },
          model: "flux-kontext",
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

  return router;
}
