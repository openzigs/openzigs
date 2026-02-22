/**
 * AI Thumbnail Generator — Text Compositor
 * Issue #322: Canvas-based text overlay compositing for YouTube thumbnails.
 * Uses @napi-rs/canvas for crisp, readable text at any resolution.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../../logging/logger.js";

export interface ThumbnailCompositeOptions {
  backgroundPath: string;
  textLines: string[];
  textPlacement: "top" | "center" | "bottom";
  textColor: string;
  textStrokeColor?: string;
  textStrokeWidth?: number;
  width?: number;
  height?: number;
  outputPath: string;
  outputFormat?: "jpeg" | "png";
}

/**
 * Composite text overlay onto a background image to create a YouTube thumbnail.
 * Text is rendered via headless canvas for crisp, readable output.
 */
export async function compositeThumbnail(
  options: ThumbnailCompositeOptions,
): Promise<string> {
  const {
    backgroundPath,
    textLines,
    textPlacement,
    textColor,
    textStrokeColor = "#000000",
    textStrokeWidth = 4,
    width = 1280,
    height = 720,
    outputPath,
    outputFormat = "jpeg",
  } = options;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Load and draw the background image, stretching to fill
  const bgImage = await loadImage(backgroundPath);
  ctx.drawImage(bgImage, 0, 0, width, height);

  // Semi-transparent gradient overlay for text readability
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  switch (textPlacement) {
    case "top":
      gradient.addColorStop(0, "rgba(0,0,0,0.6)");
      gradient.addColorStop(0.4, "rgba(0,0,0,0)");
      break;
    case "bottom":
      gradient.addColorStop(0.6, "rgba(0,0,0,0)");
      gradient.addColorStop(1, "rgba(0,0,0,0.6)");
      break;
    case "center":
      gradient.addColorStop(0.3, "rgba(0,0,0,0)");
      gradient.addColorStop(0.5, "rgba(0,0,0,0.5)");
      gradient.addColorStop(0.7, "rgba(0,0,0,0)");
      break;
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Calculate text dimensions
  const maxTextWidth = width * 0.85;
  const lineCount = textLines.length;

  // Auto-size font to fill ~60% of width
  let fontSize = Math.floor(width * 0.08); // Start at ~8% of width
  const fontFamily = "Impact, Arial Black, sans-serif";

  // Size down if text is too wide
  for (const line of textLines) {
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    const metrics = ctx.measureText(line);
    while (metrics.width > maxTextWidth && fontSize > 24) {
      fontSize -= 2;
      ctx.font = `bold ${fontSize}px ${fontFamily}`;
      const newMetrics = ctx.measureText(line);
      if (newMetrics.width <= maxTextWidth) break;
    }
  }

  const lineHeight = fontSize * 1.2;
  const totalTextHeight = lineCount * lineHeight;
  const padding = 30;

  // Calculate Y start based on placement
  let yStart: number;
  switch (textPlacement) {
    case "top":
      yStart = padding + fontSize;
      break;
    case "center":
      yStart = (height - totalTextHeight) / 2 + fontSize;
      break;
    case "bottom":
      yStart = height - totalTextHeight - padding + fontSize;
      break;
  }

  // Render text lines
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  for (let i = 0; i < textLines.length; i++) {
    const x = width / 2;
    const y = yStart + i * lineHeight;

    // Drop shadow
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillText(textLines[i], x + 3, y + 3);

    // Text stroke (outline)
    if (textStrokeWidth > 0) {
      ctx.strokeStyle = textStrokeColor;
      ctx.lineWidth = textStrokeWidth;
      ctx.lineJoin = "round";
      ctx.strokeText(textLines[i], x, y);
    }

    // Text fill
    ctx.fillStyle = textColor;
    ctx.fillText(textLines[i], x, y);
  }

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Write output
  const buffer = outputFormat === "png"
    ? canvas.toBuffer("image/png")
    : canvas.toBuffer("image/jpeg");

  fs.writeFileSync(outputPath, buffer);
  logger.info(`[ThumbnailCompositor] Wrote thumbnail: ${outputPath} (${width}x${height})`);

  return outputPath;
}
