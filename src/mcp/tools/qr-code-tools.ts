/**
 * MCP Tool: QR Code Generator — Generate QR codes in multiple formats.
 * Issue #773: Create QR codes for URLs, text, WiFi, vCard, etc.
 */

import * as z from "zod";
import QRCode from "qrcode";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ToolDefinition } from "../tool-registry.js";

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const generateQrCodeSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(4096)
    .describe("The content to encode in the QR code (URL, text, etc.)"),
  format: z
    .enum(["png", "svg", "terminal"])
    .optional()
    .default("png")
    .describe(
      "Output format: png (image file), svg (vector), terminal (ASCII art)",
    ),
  width: z
    .number()
    .int()
    .min(100)
    .max(2000)
    .optional()
    .default(400)
    .describe("Image width in pixels (PNG only)"),
  color_dark: z
    .string()
    .optional()
    .default("#000000")
    .describe("Dark module color (hex)"),
  color_light: z
    .string()
    .optional()
    .default("#ffffff")
    .describe("Light module color (hex)"),
  error_correction: z
    .enum(["L", "M", "Q", "H"])
    .optional()
    .default("M")
    .describe("Error correction level: L (7%), M (15%), Q (25%), H (30%)"),
  margin: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .default(4)
    .describe("Quiet zone margin in modules"),
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const createQrCodeTools = (): ToolDefinition[] => {
  return [
    {
      name: "generate-qr-code",
      description:
        "Generate a QR code from text, URL, or structured data. Supports PNG image, SVG vector, " +
        "and terminal ASCII output. Customize colors, size, error correction, and margin.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Content to encode" },
          format: { type: "string", enum: ["png", "svg", "terminal"] },
          width: { type: "number", description: "Image width (PNG only)" },
          color_dark: { type: "string", description: "Dark color (hex)" },
          color_light: { type: "string", description: "Light color (hex)" },
          error_correction: { type: "string", enum: ["L", "M", "Q", "H"] },
          margin: { type: "number", description: "Margin in modules" },
        },
        required: ["content"],
      },
      zodSchema: generateQrCodeSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = generateQrCodeSchema.parse(args);

          // Validate hex colors
          if (!HEX_RE.test(input.color_dark)) {
            return {
              text: `Invalid dark color hex: ${input.color_dark}`,
              isError: true,
            };
          }
          if (!HEX_RE.test(input.color_light)) {
            return {
              text: `Invalid light color hex: ${input.color_light}`,
              isError: true,
            };
          }

          const options: QRCode.QRCodeToFileOptions = {
            width: input.width,
            margin: input.margin,
            color: {
              dark: input.color_dark,
              light: input.color_light,
            },
            errorCorrectionLevel: input.error_correction,
          };

          switch (input.format) {
            case "terminal": {
              const ascii = await QRCode.toString(input.content, {
                type: "terminal",
                errorCorrectionLevel: input.error_correction,
                margin: input.margin,
              });
              return {
                text: JSON.stringify({
                  format: "terminal",
                  content: input.content,
                  qr: ascii,
                }),
              };
            }
            case "svg": {
              const svgString = await QRCode.toString(input.content, {
                type: "svg",
                width: input.width,
                margin: input.margin,
                color: { dark: input.color_dark, light: input.color_light },
                errorCorrectionLevel: input.error_correction,
              });
              fs.mkdirSync(GALLERY_DIR, { recursive: true });
              const outputPath = path.join(GALLERY_DIR, `qr_${Date.now()}.svg`);
              fs.writeFileSync(outputPath, svgString);
              return {
                text: JSON.stringify({
                  success: true,
                  format: "svg",
                  outputPath,
                  content: input.content,
                }),
              };
            }
            default: {
              fs.mkdirSync(GALLERY_DIR, { recursive: true });
              const outputPath = path.join(GALLERY_DIR, `qr_${Date.now()}.png`);
              await QRCode.toFile(outputPath, input.content, options);
              const stat = fs.statSync(outputPath);
              return {
                text: JSON.stringify({
                  success: true,
                  format: "png",
                  outputPath,
                  content: input.content,
                  width: input.width,
                  sizeBytes: stat.size,
                }),
              };
            }
          }
        } catch (err) {
          return {
            text: `Error generating QR code: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
