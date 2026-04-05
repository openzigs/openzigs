/**
 * MCP Tools: Image Manipulation (Sharp) — crop, resize, convert, filter, watermark.
 * Issue #768: Node.js-native image processing using the Sharp library.
 */

import * as z from "zod";
import sharp from "sharp";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ToolDefinition } from "../tool-registry.js";

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

// ── Schemas ─────────────────────────────────────────────────

const resizeImageSchema = z.object({
  file_path: z.string().describe("Path to the source image file"),
  width: z
    .number()
    .int()
    .min(1)
    .max(8192)
    .optional()
    .describe("Target width in pixels"),
  height: z
    .number()
    .int()
    .min(1)
    .max(8192)
    .optional()
    .describe("Target height in pixels"),
  fit: z
    .enum(["cover", "contain", "fill", "inside", "outside"])
    .optional()
    .default("inside")
    .describe("How the image should be resized to fit the dimensions"),
});

const cropImageSchema = z.object({
  file_path: z.string().describe("Path to the source image file"),
  left: z.number().int().min(0).describe("Left offset in pixels"),
  top: z.number().int().min(0).describe("Top offset in pixels"),
  width: z.number().int().min(1).describe("Crop width in pixels"),
  height: z.number().int().min(1).describe("Crop height in pixels"),
});

const convertImageSchema = z.object({
  file_path: z.string().describe("Path to the source image file"),
  format: z
    .enum(["png", "jpeg", "webp", "avif", "tiff"])
    .describe("Target image format"),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(80)
    .describe("Output quality (1-100)"),
});

const filterImageSchema = z.object({
  file_path: z.string().describe("Path to the source image file"),
  filter: z
    .enum(["grayscale", "blur", "sharpen", "negate", "normalize", "sepia"])
    .describe("Filter to apply"),
  intensity: z
    .number()
    .min(0.1)
    .max(100)
    .optional()
    .describe("Filter intensity (for blur: sigma value)"),
});

const watermarkImageSchema = z.object({
  file_path: z.string().describe("Path to the source image file"),
  watermark_path: z
    .string()
    .describe(
      "Path to the watermark image (PNG with transparency recommended)",
    ),
  position: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
    .optional()
    .default("bottom-right")
    .describe("Position of the watermark"),
  opacity: z
    .number()
    .min(0.1)
    .max(1)
    .optional()
    .default(0.5)
    .describe("Watermark opacity (0.1-1.0)"),
  scale: z
    .number()
    .min(0.05)
    .max(1)
    .optional()
    .default(0.2)
    .describe("Scale relative to source image width"),
});

// ── Helpers ─────────────────────────────────────────────────

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
  if (resolved.includes("..")) {
    throw new Error("Path traversal not allowed");
  }
  return resolved;
}

// ── Tool factory ────────────────────────────────────────────

export const createImageManipulationTools = (): ToolDefinition[] => {
  return [
    {
      name: "resize-image",
      description:
        "Resize an image to specified dimensions using Sharp. Supports multiple fit modes: cover, contain, fill, inside, outside. At least one of width or height must be provided.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path to the source image",
          },
          width: { type: "number", description: "Target width in pixels" },
          height: { type: "number", description: "Target height in pixels" },
          fit: {
            type: "string",
            enum: ["cover", "contain", "fill", "inside", "outside"],
          },
        },
        required: ["file_path"],
      },
      zodSchema: resizeImageSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = resizeImageSchema.parse(args);
          if (!input.width && !input.height) {
            return {
              text: "At least one of width or height must be provided.",
              isError: true,
            };
          }
          const sourcePath = validatePath(resolveImagePath(input.file_path));
          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }
          const outputPath = generateOutputPath(
            sourcePath,
            `${input.width ?? "auto"}x${input.height ?? "auto"}`,
          );
          await sharp(sourcePath)
            .resize(input.width, input.height, { fit: input.fit })
            .toFile(outputPath);
          const { width, height, format, size } =
            await sharp(outputPath).metadata();
          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              width,
              height,
              format,
              sizeBytes: size,
            }),
          };
        } catch (err) {
          return {
            text: `Error resizing image: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "crop-image",
      description:
        "Crop a region from an image. Specify left, top, width, and height in pixels.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          left: { type: "number" },
          top: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["file_path", "left", "top", "width", "height"],
      },
      zodSchema: cropImageSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = cropImageSchema.parse(args);
          const sourcePath = validatePath(resolveImagePath(input.file_path));
          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }
          const outputPath = generateOutputPath(sourcePath, "cropped");
          await sharp(sourcePath)
            .extract({
              left: input.left,
              top: input.top,
              width: input.width,
              height: input.height,
            })
            .toFile(outputPath);
          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              width: input.width,
              height: input.height,
            }),
          };
        } catch (err) {
          return {
            text: `Error cropping image: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "convert-image",
      description:
        "Convert an image to a different format (png, jpeg, webp, avif, tiff) with quality control.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          format: {
            type: "string",
            enum: ["png", "jpeg", "webp", "avif", "tiff"],
          },
          quality: { type: "number", description: "Output quality 1-100" },
        },
        required: ["file_path", "format"],
      },
      zodSchema: convertImageSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = convertImageSchema.parse(args);
          const sourcePath = validatePath(resolveImagePath(input.file_path));
          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }
          const outputPath = generateOutputPath(
            sourcePath,
            "converted",
            `.${input.format}`,
          );
          const pipeline = sharp(sourcePath);
          // Sharp uses .toFormat() but also accepts format-specific methods
          await pipeline
            .toFormat(input.format, { quality: input.quality })
            .toFile(outputPath);
          const stat = fs.statSync(outputPath);
          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              format: input.format,
              sizeBytes: stat.size,
            }),
          };
        } catch (err) {
          return {
            text: `Error converting image: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "filter-image",
      description:
        "Apply a visual filter to an image: grayscale, blur, sharpen, negate, normalize, or sepia.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          filter: {
            type: "string",
            enum: [
              "grayscale",
              "blur",
              "sharpen",
              "negate",
              "normalize",
              "sepia",
            ],
          },
          intensity: {
            type: "number",
            description: "Filter intensity (for blur: sigma)",
          },
        },
        required: ["file_path", "filter"],
      },
      zodSchema: filterImageSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = filterImageSchema.parse(args);
          const sourcePath = validatePath(resolveImagePath(input.file_path));
          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }
          const outputPath = generateOutputPath(sourcePath, input.filter);
          let pipeline = sharp(sourcePath);
          switch (input.filter) {
            case "grayscale":
              pipeline = pipeline.grayscale();
              break;
            case "blur":
              pipeline = pipeline.blur(input.intensity ?? 3);
              break;
            case "sharpen":
              pipeline = pipeline.sharpen(input.intensity ?? 1);
              break;
            case "negate":
              pipeline = pipeline.negate();
              break;
            case "normalize":
              pipeline = pipeline.normalize();
              break;
            case "sepia":
              // Sepia via tint — warm brownish overlay
              pipeline = pipeline.grayscale().tint({ r: 112, g: 66, b: 20 });
              break;
          }
          await pipeline.toFile(outputPath);
          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              filter: input.filter,
            }),
          };
        } catch (err) {
          return {
            text: `Error filtering image: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "watermark-image",
      description:
        "Add a watermark overlay to an image. Supports positioning (corners or center), opacity, and scale.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          watermark_path: { type: "string" },
          position: {
            type: "string",
            enum: [
              "top-left",
              "top-right",
              "bottom-left",
              "bottom-right",
              "center",
            ],
          },
          opacity: { type: "number" },
          scale: { type: "number" },
        },
        required: ["file_path", "watermark_path"],
      },
      zodSchema: watermarkImageSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = watermarkImageSchema.parse(args);
          const sourcePath = validatePath(resolveImagePath(input.file_path));
          const wmPath = validatePath(resolveImagePath(input.watermark_path));
          if (!fs.existsSync(sourcePath)) {
            return {
              text: `Source file not found: ${input.file_path}`,
              isError: true,
            };
          }
          if (!fs.existsSync(wmPath)) {
            return {
              text: `Watermark file not found: ${input.watermark_path}`,
              isError: true,
            };
          }

          const sourceMetadata = await sharp(sourcePath).metadata();
          const srcW = sourceMetadata.width ?? 800;
          const srcH = sourceMetadata.height ?? 600;

          const wmWidth = Math.round(srcW * input.scale);
          const watermark = await sharp(wmPath)
            .resize(wmWidth)
            .ensureAlpha()
            .toBuffer();

          // Apply opacity by modulating alpha channel
          const wmAdjusted = await sharp(watermark)
            .composite([
              {
                input: Buffer.from(
                  Array(
                    wmWidth *
                      Math.round(
                        (wmWidth / (sourceMetadata.width ?? 1)) * srcH,
                      ) *
                      4,
                  ).fill(Math.round(input.opacity * 255)),
                ),
                raw: { width: 1, height: 1, channels: 4 },
                blend: "dest-in",
              },
            ])
            .toBuffer()
            .catch(() => watermark); // Fallback to non-opacity-adjusted if composition fails

          const wmMeta = await sharp(wmAdjusted).metadata();
          const wmH = wmMeta.height ?? 50;

          let top = 0;
          let left = 0;
          const margin = 10;
          switch (input.position) {
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
                input: wmAdjusted,
                top: Math.max(0, top),
                left: Math.max(0, left),
              },
            ])
            .toFile(outputPath);

          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              position: input.position,
            }),
          };
        } catch (err) {
          return {
            text: `Error watermarking image: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
