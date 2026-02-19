/**
 * Director Mode — Storyboard Engine
 * Issue #255: LLM-powered "Creative Director" that transforms text documents
 * into scene-by-scene storyboards with consistent visual style.
 *
 * Pipeline: Text → Analyze → Define Style Anchor → Segment → Script → Visualize
 */

import { logger } from "../../logging/logger.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";

// ── Types ─────────────────────────────────────────────────────

/** A single scene in the storyboard output. */
export interface StoryboardScene {
  /** Sequential scene index (0-based) */
  index: number;
  /** Voiceover narration script for this scene */
  voiceover: string;
  /** Full image generation prompt (includes Style Anchor prefix) */
  imagePrompt: string;
  /** Estimated duration of this scene in seconds */
  durationEstimate: number;
  /** The raw image description before Style Anchor was prepended */
  rawImageDescription: string;
}

/** Full storyboard output from the engine. */
export interface Storyboard {
  /** Project title derived from the source document */
  title: string;
  /** The immutable Visual Style Anchor applied to all scenes */
  styleAnchor: string;
  /** Ordered list of scenes */
  scenes: StoryboardScene[];
  /** Summary of the source document's tone and audience */
  analysis: {
    tone: string;
    audience: string;
    coreThemes: string[];
  };
  /** Approximate token usage for the LLM call */
  tokensUsed: number;
}

/** A visual asset the user uploaded with a description to weave into the script. */
export interface StoryboardVisualAsset {
  /** User-provided description of the asset (e.g. "product demo screenshot") */
  description: string;
  /** Asset type */
  type: "image" | "video";
}

/** Options for storyboard generation. */
export interface StoryboardOptions {
  /** Override the LLM model (e.g. "gpt-4.1", "claude-sonnet-4") */
  model?: string;
  /** Hint for the visual style (e.g. "corporate", "playful", "technical") */
  styleHint?: string;
  /** Target total duration in seconds (default: auto-calculated from text length) */
  targetDuration?: number;
  /** Min scene duration in seconds (default: 15) */
  minSceneDuration?: number;
  /** Max scene duration in seconds (default: 30) */
  maxSceneDuration?: number;
  /** Target audience hint (e.g. "developers", "executives", "general") */
  audienceHint?: string;
  /** Visual assets the user uploaded — their descriptions should be woven into the narration */
  visualAssets?: StoryboardVisualAsset[];
  /** When true, generate PowerPoint-style slide images with short text phrases rendered into the image */
  slideStyle?: boolean;  /** When true, user-provided visual assets cover all middle scenes — only generate AI images for intro (index 0) and outro (last scene) */
  assetsOnlyMode?: boolean;}

// ── Constants ─────────────────────────────────────────────────

/** Average speaking rate for voiceover estimation (words per second). */
const WORDS_PER_SECOND = 2.5;

/** Default scene duration bounds in seconds. */
const DEFAULT_MIN_SCENE_SEC = 15;
const DEFAULT_MAX_SCENE_SEC = 30;

// ── Storyboard Engine ─────────────────────────────────────────

export class StoryboardEngine {
  constructor(private readonly copilot: CopilotWrapper) {}

  /**
   * Transform a text document into a scene-by-scene storyboard.
   *
   * @param text     - Clean text content (headers preserved, code blocks stripped)
   * @param options  - Generation options
   * @returns          Storyboard with scenes, style anchor, and analysis
   */
  async generate(text: string, options: StoryboardOptions = {}): Promise<Storyboard> {
    if (!text || text.trim().length === 0) {
      throw new Error("Input text cannot be empty");
    }

    const minDur = options.minSceneDuration ?? DEFAULT_MIN_SCENE_SEC;
    const maxDur = options.maxSceneDuration ?? DEFAULT_MAX_SCENE_SEC;

    // Estimate target duration from word count if not specified
    const wordCount = text.split(/\s+/).length;
    const estimatedSpokenDuration = wordCount / WORDS_PER_SECOND;
    const targetDuration = options.targetDuration ?? Math.max(60, Math.min(300, estimatedSpokenDuration));
    const estimatedSceneCount = Math.max(3, Math.round(targetDuration / ((minDur + maxDur) / 2)));

    logger.info(
      `[StoryboardEngine] Generating storyboard: ${wordCount} words, ` +
      `target ${targetDuration.toFixed(0)}s, ~${estimatedSceneCount} scenes`,
    );

    const systemPrompt = this.buildSystemPrompt(options, estimatedSceneCount, minDur, maxDur);
    const userPrompt = this.buildUserPrompt(text, targetDuration, options.visualAssets);

    // Single-shot LLM call
    const chunks: string[] = [];
    const stream = this.copilot.chat(
      `${systemPrompt}\n\n${userPrompt}`,
      {
        tools: [],
        ...(options.model ? { model: options.model } : {}),
      },
    );

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const responseText = chunks.join("");
    const tokensUsed = Math.ceil((systemPrompt.length + userPrompt.length + responseText.length) / 4);

    // Parse the structured JSON response
    const rawOutput = this.parseResponse(responseText);

    // Validate and build the final storyboard
    const storyboard = this.buildStoryboard(rawOutput, tokensUsed, options.slideStyle, options.assetsOnlyMode);

    logger.info(
      `[StoryboardEngine] Storyboard complete: "${storyboard.title}" ` +
      `(${storyboard.scenes.length} scenes, style: "${storyboard.styleAnchor.substring(0, 60)}...")`,
    );

    return storyboard;
  }

  /**
   * Build the system prompt with Style Anchor instructions.
   */
  private buildSystemPrompt(
    options: StoryboardOptions,
    estimatedSceneCount: number,
    minDur: number,
    maxDur: number,
  ): string {
    const styleHint = options.styleHint
      ? `\nSTYLE HINT from the user: "${options.styleHint}" — use this as a starting point for your Visual Style Anchor.`
      : "";

    const audienceHint = options.audienceHint
      ? `\nTARGET AUDIENCE: ${options.audienceHint}`
      : "";

    const slideStyleBlock = options.slideStyle
      ? `

SLIDE-STYLE MODE (ACTIVE):
The imageDescription you write is fed DIRECTLY as a prompt to an image model — it must be a bare, directive prompt fragment, not a sentence or prose description.

STRICT FORMAT for imageDescription:
  "<phrase>" [placement], [background]

RULES (no exceptions):
- 1–2 quoted text phrases MAX, each MUST be 25 characters or fewer (hard model limit)
- Placement: one short word/phrase — "centered", "bold centered", "large centered title", "bottom subtitle"
- Background: one short phrase — "dark navy gradient", "white minimal", "charcoal flat", "slate blue"
- NO narrative. NO sentences. NO "showing", "depicting", "illustrating", "featuring", "with background"
- NO filler. The description must read like a prompt directive, not a slide description

GOOD examples:
  "Cloud Migration" large centered title, deep navy background
  "Revenue +40%", "Q4 Results" stacked center, charcoal flat background
  "Next Steps" bold centered, slate blue gradient
  "Step 1: Setup" top-left, white minimal background

BAD examples (will produce garbage output):
  A clean slide showing cloud migration with blue gradient and readable text
  Professional presentation with key points displayed in centered layout
  The slide presents the main theme with dark background

The styleAnchor MUST describe a presentation slide aesthetic (clean, minimal, readable).`
      : "";

    const assetsOnlyBlock = options.assetsOnlyMode
      ? `

ASSETS-ONLY MODE (ACTIVE):
The user has provided their own images and videos as the main visual content. Your primary job is writing compelling voiceover narration — NOT generating image descriptions for most scenes.

RULES for imageDescription in this mode:
- FIRST scene (index 0): write a brief imageDescription for an AI-generated intro/title card (e.g. '"${options.styleHint || "Title"}" centered title, dark professional background')
- LAST scene (final entry in the scenes array): write a brief imageDescription for an AI-generated closing card (e.g. '"Thank You" centered, matching style')
- ALL other scenes: set imageDescription to "" (empty string) — uploaded assets will be used

Focus entirely on rich, engaging voiceover narration for every scene.`
      : "";

    return `You are a professional Video Director and Visual Storyteller. Your task is to transform a text document into a compelling video storyboard.

YOUR PROCESS (follow this EXACTLY):

1. ANALYZE the document:
   - Identify the tone (formal, casual, technical, inspirational, etc.)
   - Identify the target audience
   - Extract 3-5 core themes or topics
   - Determine a suitable title for the video

2. DEFINE a Visual Style Anchor:
   - Create a SINGLE, IMMUTABLE visual style description string that will be prepended to EVERY image prompt
   - This ensures visual consistency across all generated images
   - The style anchor should be 20-40 words describing art style, color palette, mood, and quality
   - Example: "Flat vector art, corporate memphis style, blue and white palette, minimalist composition, soft gradients, high quality illustration, clean lines"
   - Example: "Photorealistic 3D render, warm cinematic lighting, shallow depth of field, tech product photography style, dark sophisticated background"
   - Example: "Watercolor illustration style, pastel earth tones, hand-drawn feel, botanical elements, soft textures, editorial quality"
${styleHint}
3. SEGMENT the text into ${estimatedSceneCount} scenes (approximately):
   - Each scene covers a logical section or concept
   - Scene duration should be ${minDur}-${maxDur} seconds
   - Scenes should flow narratively (intro → body → conclusion)

4. SCRIPT each scene:
   - Write a cohesive voiceover narration that SUMMARIZES the source text (don't just copy it)
   - The voiceover should sound natural when spoken aloud
   - Target approximately ${(WORDS_PER_SECOND * ((minDur + maxDur) / 2)).toFixed(0)} words per scene

5. VISUALIZE each scene:
   - Write a detailed image generation prompt for each scene
   - CRITICAL: Every image prompt MUST START with the exact Visual Style Anchor string
   - After the style anchor, describe the specific visual content for that scene
   - Include composition direction (close-up, wide shot, centered, etc.)
   - Reference concepts from the text but translate them into visual descriptions
${audienceHint}
${slideStyleBlock}
${assetsOnlyBlock}
OUTPUT FORMAT (strict JSON):
{
  "title": "string — video title derived from the document",
  "styleAnchor": "string — the immutable Visual Style Anchor (20-40 words)",
  "analysis": {
    "tone": "string",
    "audience": "string",
    "coreThemes": ["string", "string", ...]
  },
  "scenes": [
    {
      "voiceover": "string — narration script for this scene",
      "imageDescription": "string — scene-specific visual description (WITHOUT the style anchor prefix)",
      "durationEstimate": number — scene duration in seconds (${minDur}-${maxDur})
    }
  ]
}

RULES:
- Output ONLY the JSON object. No markdown code blocks, no extra text.
- The styleAnchor must appear IDENTICALLY at the start of every final image prompt (this will be concatenated programmatically — you only provide the imageDescription per scene).
- Voiceover text should be engaging, conversational, and suitable for text-to-speech.
- Duration estimates should reflect the voiceover length (roughly ${WORDS_PER_SECOND} words per second).
- Scenes must follow the document's logical flow — do not rearrange arbitrarily.
- Each scene's imageDescription should be specific and visually descriptive, not vague.
- If the user has provided VISUAL ASSETS (images or videos) with descriptions, naturally reference what those assets depict within the voiceover narration at appropriate moments. Treat the asset descriptions as additional context about the topic — weave their content into the script so the narration acknowledges what the viewer will see on screen.`;
  }

  /**
   * Build the user prompt containing the source text.
   */
  private buildUserPrompt(text: string, targetDuration: number, visualAssets?: StoryboardVisualAsset[]): string {
    // Truncate very long texts to avoid token limits
    const maxChars = 30_000;
    const truncatedText = text.length > maxChars
      ? text.substring(0, maxChars) + "\n\n[... document truncated for length ...]"
      : text;

    // Build visual asset context block if assets with descriptions exist
    let assetBlock = "";
    if (visualAssets && visualAssets.length > 0) {
      const assetLines = visualAssets
        .filter((a) => a.description.trim())
        .map((a, i) => `  ${i + 1}. [${a.type}] ${a.description.trim()}`);
      if (assetLines.length > 0) {
        assetBlock = `\n\n=== USER-PROVIDED VISUAL ASSETS ===\nThe user has uploaded the following images/videos that will be overlaid on the final video.\nTheir descriptions provide additional context about the topic. Naturally weave references to what\nthese assets depict into the voiceover narration at appropriate moments — do NOT simply list them,\nbut incorporate their content as supporting visuals the narrator acknowledges.\n\n${assetLines.join("\n")}\n\n=== END OF VISUAL ASSETS ===`;
      }
    }

    return `=== SOURCE DOCUMENT ===

${truncatedText}

=== END OF DOCUMENT ===${assetBlock}

Target video duration: approximately ${targetDuration.toFixed(0)} seconds.
Transform this document into a video storyboard following the process described above.
Output a single JSON object.`;
  }

  /**
   * Parse the LLM's JSON response, handling markdown wrappers and extraction.
   */
  private parseResponse(responseText: string): RawStoryboardOutput {
    let jsonText = responseText.trim();

    // Strip markdown code block wrappers
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.slice(7);
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.slice(3);
    }
    if (jsonText.endsWith("```")) {
      jsonText = jsonText.slice(0, -3);
    }
    jsonText = jsonText.trim();

    try {
      return JSON.parse(jsonText) as RawStoryboardOutput;
    } catch {
      // Try to extract JSON object from mixed response
      const jsonStart = responseText.indexOf("{");
      const jsonEnd = responseText.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const extracted = responseText.slice(jsonStart, jsonEnd + 1);
        try {
          return JSON.parse(extracted) as RawStoryboardOutput;
        } catch {
          throw new Error("Failed to parse storyboard response as JSON");
        }
      }
      throw new Error("No JSON object found in storyboard response");
    }
  }

  /**
   * Validate and transform the raw LLM output into the final Storyboard structure.
   */
  private buildStoryboard(raw: RawStoryboardOutput, tokensUsed: number, slideStyle?: boolean, assetsOnlyMode?: boolean): Storyboard {
    if (!raw.title || typeof raw.title !== "string") {
      throw new Error("Storyboard response missing 'title'");
    }
    if (!raw.styleAnchor || typeof raw.styleAnchor !== "string") {
      throw new Error("Storyboard response missing 'styleAnchor'");
    }
    if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
      throw new Error("Storyboard response missing or empty 'scenes' array");
    }

    const styleAnchor = raw.styleAnchor.trim();

    const scenes: StoryboardScene[] = raw.scenes.map((scene, index) => {
      const voiceover = scene.voiceover?.trim() ?? "";
      const rawDesc = scene.imageDescription?.trim() ?? "";
      const duration = typeof scene.durationEstimate === "number" ? scene.durationEstimate : 20;

      if (!voiceover) {
        logger.warn(`[StoryboardEngine] Scene ${index} has empty voiceover`);
      }
      if (!rawDesc) {
        logger.warn(`[StoryboardEngine] Scene ${index} has empty image description`);
      }

      // Prepend the Visual Style Anchor to create the full image prompt.
      // In slide-style mode rawDesc is already a bare directive prompt fragment;
      // prepend style anchor only — no filler prefix that would dilute the text directive.
      // In assets-only mode middle scenes have empty rawDesc; leave imagePrompt empty so
      // the generation loop knows to skip AI generation for those scenes.
      let imagePrompt: string;
      if (!rawDesc && assetsOnlyMode) {
        imagePrompt = "";
      } else if (slideStyle && rawDesc) {
        imagePrompt = `${styleAnchor}. ${rawDesc}`;
      } else {
        imagePrompt = rawDesc
          ? `${styleAnchor}. ${rawDesc}`
          : styleAnchor;
      }

      return {
        index,
        voiceover,
        imagePrompt,
        durationEstimate: Math.max(5, Math.min(60, duration)),
        rawImageDescription: rawDesc,
      };
    });

    const analysis = {
      tone: raw.analysis?.tone ?? "neutral",
      audience: raw.analysis?.audience ?? "general",
      coreThemes: Array.isArray(raw.analysis?.coreThemes)
        ? raw.analysis.coreThemes
        : [],
    };

    return {
      title: raw.title,
      styleAnchor,
      scenes,
      analysis,
      tokensUsed,
    };
  }
}

// ── Internal Types ────────────────────────────────────────────

/** Raw JSON shape expected from the LLM before validation. */
interface RawStoryboardOutput {
  title?: string;
  styleAnchor?: string;
  analysis?: {
    tone?: string;
    audience?: string;
    coreThemes?: string[];
  };
  scenes?: Array<{
    voiceover?: string;
    imageDescription?: string;
    durationEstimate?: number;
  }>;
}
