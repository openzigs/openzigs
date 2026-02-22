/**
 * AI Thumbnail Generator — Frame Selector
 * Issue #322: LLM-powered selection of the optimal thumbnail frame
 * from a video's keyframes and manifest context.
 */

import { logger } from "../../logging/logger.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { DirectorManifest } from "../manifest/manifest-types.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface KeyframeInfo {
  path: string;
  timestampSec: number;
  sceneIndex: number;
}

export interface FrameSelectionResult {
  framePath: string;
  timestamp: number;
  rationale: string;
  suggestedText: string[];
  textPlacement: "top" | "center" | "bottom";
  textColor: string;
}

const SYSTEM_PROMPT = `You are a YouTube thumbnail optimization expert. Your job is to select the single most visually striking, emotionally engaging frame from a set of keyframes that would make a viewer click.

You will receive:
1. A list of available keyframes with timestamps and scene indices
2. The video's manifest metadata (title, scene descriptions)

Select ONE frame and respond with JSON:
{
  "selectedIndex": number,
  "rationale": "string — why this frame is the most clickable",
  "suggestedText": ["string", "string"],
  "textPlacement": "top" | "center" | "bottom",
  "textColor": "#hex"
}

RULES:
- suggestedText: 1-3 short, bold, enticing lines (YouTube clickbait style, ALL CAPS preferred, max 30 chars per line)
- Prefer frames with: faces, action, color contrast, emotional expressions, clear subjects
- Avoid: blurry frames, transition frames, text-heavy frames, dark/low-contrast frames
- textColor should contrast with the selected frame's dominant background
- Output ONLY the JSON object, no markdown wrappers`;

export async function selectThumbnailFrame(
  keyframes: KeyframeInfo[],
  manifest: DirectorManifest,
  copilot: CopilotWrapper,
  options?: { model?: string },
): Promise<FrameSelectionResult> {
  if (keyframes.length === 0) {
    throw new Error("No keyframes provided for thumbnail selection");
  }

  // If only one keyframe, skip LLM call
  if (keyframes.length === 1) {
    return {
      framePath: keyframes[0].path,
      timestamp: keyframes[0].timestampSec,
      rationale: "Only one keyframe available",
      suggestedText: [manifest.projectTitle.toUpperCase()],
      textPlacement: "bottom",
      textColor: "#ffffff",
    };
  }

  const sceneDescriptions = manifest.timeline
    .filter((e) => e.type === "image_scene" || e.type === "title_card")
    .map((e, i) => {
      if (e.type === "title_card") return `Scene ${i}: Title — "${e.title}"`;
      if (e.type === "image_scene" && "scriptText" in e && e.scriptText) {
        return `Scene ${i}: ${e.scriptText.slice(0, 100)}`;
      }
      return `Scene ${i}: (visual scene)`;
    })
    .join("\n");

  const keyframeList = keyframes
    .map((kf, i) => `[${i}] timestamp=${kf.timestampSec.toFixed(1)}s, scene=${kf.sceneIndex}, file="${path.basename(kf.path)}"`)
    .join("\n");

  const userPrompt = `VIDEO: "${manifest.projectTitle}"
Template: ${manifest.templateId}

SCENES:
${sceneDescriptions}

AVAILABLE KEYFRAMES:
${keyframeList}

Select the best frame for a YouTube thumbnail.`;

  const chunks: string[] = [];
  const stream = copilot.chat(`${SYSTEM_PROMPT}\n\n${userPrompt}`, {
    tools: [],
    ...(options?.model ? { model: options.model } : {}),
  });

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const responseText = chunks.join("").trim();
  let parsed: { selectedIndex?: number; rationale?: string; suggestedText?: string[]; textPlacement?: string; textColor?: string };

  try {
    let jsonText = responseText;
    if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    parsed = JSON.parse(jsonText);
  } catch {
    logger.warn("[FrameSelector] Failed to parse LLM response, using first keyframe");
    return {
      framePath: keyframes[0].path,
      timestamp: keyframes[0].timestampSec,
      rationale: "LLM response parsing failed — defaulting to first frame",
      suggestedText: [manifest.projectTitle.toUpperCase()],
      textPlacement: "bottom",
      textColor: "#ffffff",
    };
  }

  const selectedIdx = typeof parsed.selectedIndex === "number"
    ? Math.max(0, Math.min(parsed.selectedIndex, keyframes.length - 1))
    : 0;

  const selected = keyframes[selectedIdx];

  return {
    framePath: selected.path,
    timestamp: selected.timestampSec,
    rationale: parsed.rationale ?? "Selected by LLM",
    suggestedText: Array.isArray(parsed.suggestedText)
      ? parsed.suggestedText.filter((t): t is string => typeof t === "string").slice(0, 3)
      : [manifest.projectTitle.toUpperCase()],
    textPlacement: (["top", "center", "bottom"].includes(parsed.textPlacement ?? "")
      ? parsed.textPlacement as "top" | "center" | "bottom"
      : "bottom"),
    textColor: typeof parsed.textColor === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.textColor)
      ? parsed.textColor
      : "#ffffff",
  };
}

/**
 * Extract keyframes from existing scene images in a render output directory.
 * Falls back to using the image_scene sources from the manifest.
 */
export function extractKeyframesFromManifest(
  manifest: DirectorManifest,
  outputDir: string,
): KeyframeInfo[] {
  const fps = manifest.composition?.fps ?? 30;
  const keyframes: KeyframeInfo[] = [];

  for (const entry of manifest.timeline) {
    if (entry.type === "image_scene") {
      const imgPath = path.isAbsolute(entry.src) ? entry.src : path.join(outputDir, entry.src);
      if (fs.existsSync(imgPath)) {
        keyframes.push({
          path: imgPath,
          timestampSec: entry.startAtFrame / fps,
          sceneIndex: keyframes.length,
        });
      }
    }
  }

  return keyframes;
}
