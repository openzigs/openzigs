/**
 * MCP Tool: Image Upscaling via Real-ESRGAN Python sidecar.
 * Issue #767: Sends image to Python sidecar for AI upscaling.
 */

import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ToolDefinition } from "../tool-registry.js";
import { logger } from "../../logging/logger.js";
import { normalizeSidecarError } from "../../sidecars/error-normalizer.js";

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const upscaleImageSchema = z.object({
  file_path: z.string().describe("Path to the image file to upscale"),
  scale: z
    .number()
    .min(2)
    .max(4)
    .optional()
    .default(2)
    .describe("Upscale factor (2x or 4x)"),
});

export interface ImageUpscaleToolsOptions {
  sidecarUrl: string;
}

function resolveImagePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const galleryPath = path.join(GALLERY_DIR, filePath);
  if (fs.existsSync(galleryPath)) return galleryPath;
  return filePath;
}

export const createImageUpscaleTools = ({
  sidecarUrl,
}: ImageUpscaleToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "upscale-image",
      description:
        "Upscale an image using Real-ESRGAN AI super-resolution. Supports 2x and 4x upscaling. " +
        "Input should be a path to an image file (PNG, JPEG, WebP). Returns the path to the upscaled image.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path to the image to upscale",
          },
          scale: {
            type: "number",
            description: "Upscale factor: 2 or 4 (default: 2)",
          },
        },
        required: ["file_path"],
      },
      zodSchema: upscaleImageSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = upscaleImageSchema.parse(args);
          const sourcePath = path.resolve(resolveImagePath(input.file_path));

          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }

          const imageBuffer = fs.readFileSync(sourcePath);
          const base64Image = imageBuffer.toString("base64");
          const ext = path.extname(sourcePath).slice(1) || "png";

          const response = await fetch(`${sidecarUrl}/upscale`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: base64Image,
              format: ext,
              scale: input.scale,
            }),
            signal: AbortSignal.timeout(120_000),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "");
            const { userMessage } = normalizeSidecarError(
              errText,
              response.status,
            );
            return {
              text: `Upscale sidecar error (${response.status}): ${userMessage}`,
              isError: true,
            };
          }

          const result = (await response.json()) as {
            image: string;
            width: number;
            height: number;
          };
          fs.mkdirSync(GALLERY_DIR, { recursive: true });
          const baseName = path.basename(sourcePath, path.extname(sourcePath));
          const outputFilename = `${baseName}_upscaled_${input.scale}x_${Date.now()}.png`;
          const outputPath = path.join(GALLERY_DIR, outputFilename);
          fs.writeFileSync(outputPath, Buffer.from(result.image, "base64"));

          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              scale: input.scale,
              width: result.width,
              height: result.height,
            }),
          };
        } catch (err) {
          logger.error("upscale-image error", { error: String(err) });
          return {
            text: `Error upscaling image: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
