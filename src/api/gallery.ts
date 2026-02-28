/**
 * Gallery API — AI-powered prompt enhancement for media generation.
 */

import { Router } from "express";
import { logger } from "../logging/logger.js";
import type { CopilotWrapperService } from "../copilot/copilot-wrapper.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";

// ── Types ───────────────────────────────────────────────────

interface EnhancePromptRequest {
  raw_prompt: string;
  model: string;
  mode: string;
  seed?: number;
  parameters: {
    width?: number;
    height?: number;
    steps?: number;
    guidance?: number;
    num_frames?: number;
    fps?: number;
    strength?: number;
  };
}

interface EnhancePromptResponse {
  enhanced_prompt: string;
  thinking: string;
  suggested_parameters: {
    steps?: number;
    guidance?: number;
    width?: number;
    height?: number;
    num_frames?: number;
    fps?: number;
    seed?: number;
  };
}

// ── Factory ─────────────────────────────────────────────────

export interface GalleryRouterOptions {
  copilot: CopilotWrapperService;
  toolRegistry: ToolRegistry;
}

export const createGalleryRouter = ({ copilot, toolRegistry }: GalleryRouterOptions): Router => {
  const router = Router();

  // ── POST /enhance-prompt — AI-enhance a generation prompt ──
  router.post("/enhance-prompt", async (req, res) => {
    try {
      const body = req.body as Partial<EnhancePromptRequest>;

      if (!body.raw_prompt?.trim()) {
        res.status(400).json({ error: "raw_prompt is required" });
        return;
      }

      const rawPrompt = body.raw_prompt.trim();
      const model = body.model ?? "flux-schnell";
      const mode = body.mode ?? "txt2img";
      const params = body.parameters ?? {};
      const seed = typeof body.seed === "number" ? body.seed : undefined;

      const isVideo = mode === "txt2video" || mode === "img2video";

      // Build the LLM system prompt for prompt enhancement
      const systemContent = buildSystemPrompt(model, mode, isVideo);

      // Build the user message
      const userMessage = buildUserMessage(rawPrompt, model, mode, params, isVideo, seed);

      // Collect only the web-search tool for the LLM to use
      const webSearchTool = toolRegistry.getToolDefinition("web-search");
      const tools = webSearchTool ? [webSearchTool] : [];

      // Stream the response from the LLM
      const conversationId = `enhance-prompt-${Date.now()}`;
      let fullResponse = "";

      for await (const chunk of copilot.chat(userMessage, {
        conversationId,
        systemMessage: { mode: "replace", content: systemContent },
        tools,
        availableTools: ["web-search"],
      })) {
        fullResponse += chunk;
      }

      // Destroy the ephemeral session
      await copilot.destroySession(conversationId);

      // Parse the JSON response from the LLM
      const result = parseEnhanceResponse(fullResponse, params);

      logger.info(`[GalleryAPI] Prompt enhanced for ${model}/${mode}: "${rawPrompt.slice(0, 50)}..." → "${result.enhanced_prompt.slice(0, 50)}..."`);

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[GalleryAPI] Enhance prompt failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
};

// ── Prompt Construction ─────────────────────────────────────

function buildSystemPrompt(model: string, mode: string, isVideo: boolean): string {
  const modelGuidance = getModelGuidance(model, isVideo);

  return `You are an expert AI prompt engineer for image and video generation models.
Your job is to take a user's rough prompt and enhance it into a highly detailed, optimized prompt for the target model.

## Target Model: ${model}
## Generation Mode: ${mode}

${modelGuidance}

## Aspect Ratio Guide
Choose width/height based on the subject matter:
- **Portrait / person / tall subject** → 768×1344
- **Landscape / wide scene / cinematic** → 1344×768
- **Square / product / abstract / face close-up** → 1024×1024
- **Social media story / vertical video** → 896×1152
- For video: fixed 768×512, do not suggest different dimensions.

## Rules
1. If the user mentions something specific (a car model, a place, a historical figure, a product), use web search to find accurate visual details to enrich the prompt.
2. Preserve the user's core intent — do not change what they want to generate.
3. Add rich visual details: lighting, composition, materials, textures, atmosphere, color palette.
4. Use the word count and subject complexity to judge steps: simple/fast prompts stay at min steps; detailed/complex scenes push toward the model's max.
5. If a seed is provided, you may suggest a different seed only if you have a specific reason (e.g., the subject has known aesthetic seeds). Otherwise omit it.
6. Respond ONLY with a bare JSON object — no markdown, no code fences, no explanation before or after:

{"thinking": "One sentence explaining your parameter choices", "enhanced_prompt": "The enhanced, detailed prompt string", "suggested_parameters": {"steps": 4, "guidance": 3.5, "width": 768, "height": 1344}}

Only include parameters in suggested_parameters that should change from the current values. Omit seed unless you have a specific suggestion.`;
}

function getModelGuidance(model: string, isVideo: boolean): string {
  if (isVideo) {
    return `## LTX-Video Prompting Guide
- Use vivid, cinematic language describing camera movement, lighting, and atmosphere.
- Include explicit camera directions: "slow dolly forward", "aerial tracking shot", "handheld close-up".
- Describe lighting conditions: "golden hour rim lighting", "neon-lit fog", "harsh overhead fluorescents".
- Add temporal flow: describe what happens over the 4-second clip.
- Include cinematic quality keywords: "film grain", "anamorphic lens", "shallow depth of field".
- Fixed resolution: 768×512, max 97 frames.
- For complex scenes, suggest higher frame counts (closer to 97).`;
  }

  switch (model) {
    case "flux-schnell":
      return `## Flux Schnell Prompting Guide
- Optimized for speed (4 steps). Use natural, descriptive language.
- Works best with clear, concise descriptions rather than keyword spam.
- Describe the subject, setting, lighting, and mood in flowing sentences.
- Good at photorealistic scenes, illustrations, and creative compositions.
- Default resolution: 1024×1024. Portraits work well at 768×1344, landscapes at 1344×768.
- For simple prompts, 4 steps is sufficient. Complex prompts may benefit from 6-8 steps.`;

    case "flux-dev":
      return `## Flux Dev Prompting Guide
- Higher quality model, uses 25+ steps. Handles complex, detailed prompts well.
- Use rich, detailed natural language descriptions.
- Excellent at precise compositions, text rendering, and fine details.
- Benefits from specific art style references and detailed scene descriptions.
- Default resolution: 1024×1024. Can handle various aspect ratios well.
- For very detailed scenes, 30-40 steps may help. Guidance 3.0-7.0 range.`;

    case "flux-kontext":
      return `## Flux Kontext Prompting Guide (Image-to-Image)
- Specialized for image transformation and editing.
- Describe what should change about the source image.
- Be specific about modifications: style transfer, color changes, object additions.
- Strength parameter controls how much the output deviates from the source.
- 20 steps default, guidance 2.5. Higher strength = more dramatic changes.`;

    case "sdxl-turbo":
      return `## SDXL Turbo Prompting Guide
- Extremely fast, 1-4 steps. Use concise, keyword-style prompts.
- Comma-separated descriptors work well: "subject, style, lighting, quality".
- Add quality boosters: "masterpiece, best quality, highly detailed, 8k".
- Negative prompt support — avoid including negative keywords in the main prompt.
- Fixed at 512×512 for best results.`;

    default:
      return `## General Prompting Guide
- Use clear, descriptive natural language.
- Include subject, setting, lighting, mood, and style.
- Be specific about visual details.`;
  }
}

function buildUserMessage(
  rawPrompt: string,
  model: string,
  mode: string,
  params: EnhancePromptRequest["parameters"],
  isVideo: boolean,
  seed?: number,
): string {
  const wordCount = rawPrompt.trim().split(/\s+/).length;
  const complexity = wordCount <= 5 ? "very simple (≤5 words)" : wordCount <= 15 ? "moderate (6–15 words)" : `detailed (${wordCount} words)`;

  const paramSummary = isVideo
    ? `Frames: ${params.num_frames ?? 97}, FPS: ${params.fps ?? 24}, Resolution: 768×512`
    : `Resolution: ${params.width ?? 1024}×${params.height ?? 1024}, Steps: ${params.steps ?? 4}, Guidance: ${params.guidance ?? 3.5}${seed != null ? `, Seed: ${seed}` : ", Seed: (none)"}`;

  return `Enhance this prompt for ${model} (${mode}):

"${rawPrompt}"

Prompt complexity: ${complexity}
Current parameters: ${paramSummary}

Respond with JSON only.`;
}

// ── Response Parsing ────────────────────────────────────────

function extractJsonString(response: string): string | null {
  // Strip markdown code fences first
  const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Grab the outermost { ... } using lastIndexOf to handle nested objects
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start !== -1 && end > start) return response.slice(start, end + 1);

  return null;
}

function parseEnhanceResponse(
  response: string,
  _currentParams: EnhancePromptRequest["parameters"],
): EnhancePromptResponse {
  const jsonStr = extractJsonString(response);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr) as {
        thinking?: string;
        enhanced_prompt?: string;
        suggested_parameters?: Record<string, unknown>;
      };

      if (parsed.enhanced_prompt) {
        const suggested: EnhancePromptResponse["suggested_parameters"] = {};
        const sp = parsed.suggested_parameters ?? {};

        if (typeof sp.steps === "number") suggested.steps = sp.steps;
        if (typeof sp.guidance === "number") suggested.guidance = sp.guidance;
        if (typeof sp.width === "number") suggested.width = sp.width;
        if (typeof sp.height === "number") suggested.height = sp.height;
        if (typeof sp.num_frames === "number") suggested.num_frames = sp.num_frames;
        if (typeof sp.fps === "number") suggested.fps = sp.fps;
        if (typeof sp.seed === "number") suggested.seed = sp.seed;

        return {
          enhanced_prompt: parsed.enhanced_prompt,
          thinking: parsed.thinking ?? "",
          suggested_parameters: suggested,
        };
      }
    } catch {
      // JSON parse failed, fall through
    }
  }

  // Fallback: use the raw response as the enhanced prompt
  return {
    enhanced_prompt: response.trim(),
    thinking: "",
    suggested_parameters: {},
  };
}
