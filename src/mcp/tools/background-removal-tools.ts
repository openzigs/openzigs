/**
 * MCP Tool: Background Removal via rembg Python sidecar.
 * Issue #769: Sends image to Python sidecar for AI background removal.
 */

import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ToolDefinition } from "../tool-registry.js";
import { logger } from "../../logging/logger.js";
import { normalizeSidecarError } from "../../sidecars/error-normalizer.js";

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const removeBackgroundSchema = z.object({
  file_path: z.string().describe("Path to the image file"),
  model: z
    .enum(["u2net", "u2net_human_seg", "isnet-general-use"])
    .optional()
    .default("u2net")
    .describe("Rembg model to use"),
  alpha_matting: z
    .boolean()
    .optional()
    .default(false)
    .describe("Enable alpha matting for softer edges"),
});

export interface BackgroundRemovalToolsOptions {
  sidecarUrl: string;
}

function resolveImagePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const galleryPath = path.join(GALLERY_DIR, filePath);
  if (fs.existsSync(galleryPath)) return galleryPath;
  return filePath;
}

export const createBackgroundRemovalTools = ({
  sidecarUrl,
}: BackgroundRemovalToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "remove-background",
      description:
        "Remove the background from an image using AI (rembg). Returns a transparent PNG. " +
        "Supports multiple models: u2net (general), u2net_human_seg (people), isnet-general-use (detailed).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the image" },
          model: {
            type: "string",
            enum: ["u2net", "u2net_human_seg", "isnet-general-use"],
            description: "Model to use (default: u2net)",
          },
          alpha_matting: {
            type: "boolean",
            description: "Enable alpha matting for soft edges",
          },
        },
        required: ["file_path"],
      },
      zodSchema: removeBackgroundSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = removeBackgroundSchema.parse(args);
          const sourcePath = path.resolve(resolveImagePath(input.file_path));

          if (!fs.existsSync(sourcePath)) {
            return {
              text: `File not found: ${input.file_path}`,
              isError: true,
            };
          }

          const imageBuffer = fs.readFileSync(sourcePath);
          const base64Image = imageBuffer.toString("base64");

          const response = await fetch(`${sidecarUrl}/remove-background`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: base64Image,
              model: input.model,
              alpha_matting: input.alpha_matting,
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
              text: `Background removal sidecar error (${response.status}): ${userMessage}`,
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
          const outputFilename = `${baseName}_nobg_${Date.now()}.png`;
          const outputPath = path.join(GALLERY_DIR, outputFilename);
          fs.writeFileSync(outputPath, Buffer.from(result.image, "base64"));

          return {
            text: JSON.stringify({
              success: true,
              outputPath,
              model: input.model,
              width: result.width,
              height: result.height,
            }),
          };
        } catch (err) {
          logger.error("remove-background error", { error: String(err) });
          return {
            text: `Error removing background: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
