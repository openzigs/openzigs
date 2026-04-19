/**
 * Gallery API — AI-powered prompt enhancement for media generation.
 */

import { Router } from "express";
import { logger } from "../logging/logger.js";
import type { CopilotWrapperService } from "../copilot/copilot-wrapper.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import { getUserSelectedModel } from "../config/user-model.js";

// ── Types ───────────────────────────────────────────────────

interface EnhancePromptRequest {
  raw_prompt: string;
  model: string;
  mode: string;
  seed?: number;
  llmModel?: string;
  parameters: {
    width?: number;
    height?: number;
    steps?: number;
    guidance?: number;
    num_frames?: number;
    fps?: number;
    strength?: number;
    duration_seconds?: number;
    music_steps?: number;
    instrumental?: boolean;
    negative_prompt?: string;
  };
}

interface EnhancePromptResponse {
  enhanced_prompt: string;
  thinking: string;
  suggested_lyrics?: string;
  suggested_negative_prompt?: string;
  suggested_parameters: {
    steps?: number;
    guidance?: number;
    width?: number;
    height?: number;
    num_frames?: number;
    fps?: number;
    seed?: number;
    duration_seconds?: number;
    music_steps?: number;
    video_steps?: number;
    video_guidance?: number;
  };
}

// ── Factory ─────────────────────────────────────────────────

export interface GalleryRouterOptions {
  copilot: CopilotWrapperService;
  toolRegistry: ToolRegistry;
}

export const createGalleryRouter = ({
  copilot,
  toolRegistry,
}: GalleryRouterOptions): Router => {
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
      const isMusic = mode === "txt2music";

      // Build the LLM system prompt for prompt enhancement
      const systemContent = buildSystemPrompt(model, mode, isVideo, isMusic);

      // Build the user message
      const userMessage = buildUserMessage(
        rawPrompt,
        model,
        mode,
        params,
        isVideo,
        isMusic,
        seed,
      );

      // Collect only the web-search tool for the LLM to use
      const webSearchTool = toolRegistry.getToolDefinition("web-search");
      const tools = webSearchTool ? [webSearchTool] : [];

      // Stream the response from the LLM
      const conversationId = `enhance-prompt-${Date.now()}`;
      let fullResponse = "";
      const galleryModel = body.llmModel || (await getUserSelectedModel());

      for await (const chunk of copilot.chat(userMessage, {
        conversationId,
        systemMessage: { mode: "replace", content: systemContent },
        tools,
        availableTools: ["web-search"],
        ...(galleryModel ? { model: galleryModel } : {}),
      })) {
        fullResponse += chunk;
      }

      // Destroy the ephemeral session
      await copilot.destroySession(conversationId);

      // Parse the JSON response from the LLM
      const result = parseEnhanceResponse(fullResponse, params);

      logger.info(
        `[GalleryAPI] Prompt enhanced for ${model}/${mode}: "${rawPrompt.slice(0, 50)}..." → "${result.enhanced_prompt.slice(0, 50)}..."`,
      );

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[GalleryAPI] Enhance prompt failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /enhance-speech — AI-enhance speech text for talking head ──
  router.post("/enhance-speech", async (req, res) => {
    try {
      const { raw_text, llmModel } = req.body as { raw_text?: string; llmModel?: string };

      if (!raw_text?.trim()) {
        res.status(400).json({ error: "raw_text is required" });
        return;
      }

      const text = raw_text.trim();
      const wordCount = text.split(/\s+/).length;

      const systemContent = `You are an expert speech writer and dialogue coach for AI talking-head video generation.

Your job: take rough speech text and polish it for natural spoken delivery by a TTS engine.

## Guidelines
1. **Natural cadence**: Break long sentences into shorter, conversational phrases. Add commas and dashes for natural pauses.
2. **Speakable**: Avoid abbreviations, acronyms, or symbols the TTS might mispronounce. Spell out numbers under 100.
3. **Engaging**: Make the speech sound like a real person talking — warm, clear, and confident.
4. **Preserve intent**: Keep the user's core message and meaning intact. Don't change the topic or add new information.
5. **Duration-aware**: Keep the enhanced text roughly the same length as the original. Don't pad with filler.
6. **Punctuation for prosody**: Use ellipses for dramatic pauses, em-dashes for asides, and exclamation points sparingly for emphasis.

## Estimated Speaking Rate
- ~150 words per minute at normal TTS speed
- ~14 characters per second

## Rules
- Respond ONLY with a bare JSON object — no markdown, no code fences:
{"thinking": "One sentence explaining your changes", "enhanced_text": "The polished speech text", "estimated_duration_sec": 10}
- estimated_duration_sec should be computed as: word_count / 2.5 (150 wpm = 2.5 words/sec)`;

      const userMessage = `Polish this speech text for TTS delivery in a talking-head video:

"${text}"

Word count: ${wordCount}
Respond with JSON only.`;

      const webSearchTool = toolRegistry.getToolDefinition("web-search");
      const tools = webSearchTool ? [webSearchTool] : [];

      const conversationId = `enhance-speech-${Date.now()}`;
      let fullResponse = "";
      const selectedModel = llmModel || (await getUserSelectedModel());

      for await (const chunk of copilot.chat(userMessage, {
        conversationId,
        systemMessage: { mode: "replace", content: systemContent },
        tools,
        availableTools: ["web-search"],
        ...(selectedModel ? { model: selectedModel } : {}),
      })) {
        fullResponse += chunk;
      }

      await copilot.destroySession(conversationId);

      // Parse JSON response
      const jsonStr = extractJsonString(fullResponse);
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr) as {
          thinking?: string;
          enhanced_text?: string;
          estimated_duration_sec?: number;
        };
        if (parsed.enhanced_text) {
          logger.info(
            `[GalleryAPI] Speech enhanced: "${text.slice(0, 50)}..." → "${parsed.enhanced_text.slice(0, 50)}..."`,
          );
          res.json({
            enhanced_text: parsed.enhanced_text,
            thinking: parsed.thinking ?? "",
            estimated_duration_sec: parsed.estimated_duration_sec ?? Math.round(wordCount / 2.5),
          });
          return;
        }
      }

      // Fallback: return original with estimate
      res.json({
        enhanced_text: text,
        thinking: "Could not enhance — returning original text",
        estimated_duration_sec: Math.round(wordCount / 2.5),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[GalleryAPI] Enhance speech failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
};

// ── Prompt Construction ─────────────────────────────────────

function buildSystemPrompt(
  model: string,
  mode: string,
  isVideo: boolean,
  isMusic: boolean,
): string {
  const modelGuidance = getModelGuidance(model, isVideo, isMusic);

  if (isMusic) {
    return `You are an expert AI prompt engineer specializing in the ACE-Step 1.5 music generation model.

Your job: take a rough music description and produce two things:
1. An **enhanced_prompt** — a comma-separated list of descriptive tags optimized for ACE-Step's caption encoder.
2. **suggested_lyrics** — properly structured lyrics using ACE-Step's bracketed section format.

## Target Model: ${model}
## Generation Mode: ${mode}

${modelGuidance}

## ACE-Step Tag Format for enhanced_prompt
Comma-separated tags covering: genre, sub-genre, mood, energy, tempo/BPM, key, instruments, production style, vocal style (or "instrumental, no vocals").
Example: "electronic, synthwave, retro, energetic, 128 BPM, A minor, driving bassline, arpeggiated synths, 80s drums, polished production, male vocals"

## ACE-Step Lyrics Format for suggested_lyrics
Use bracketed section headers. Each section gets a label on its own line, then lyric lines below.
Example:
[Verse 1]
Line one of verse
Line two of verse

[Chorus]
Chorus line one
Chorus line two

[Bridge]
Bridge line

[Outro]
Final line

If the user wants an instrumental track, set suggested_lyrics to "[Instrumental]".

## Inference Steps Guidance
Choose music_steps (8–27) based on prompt complexity:
- Simple/ambient/minimal: 8–12 steps (faster generation)
- Standard pop/rock/electronic: 16–20 steps
- Complex orchestral/multi-instrument/detailed: 22–27 steps (higher quality)

## Duration Guidance
Choose duration_seconds (10–300) based on the content:
- Short jingle/loop/sample: 10–20s
- Standard song section (verse+chorus): 30–60s
- Full song: 120–240s
- Only suggest if the user implies a different length than current.

## Rules
1. If the user mentions a specific genre, artist style, or musical reference, use web search to research accurate musical characteristics.
2. Preserve the user's core musical intent — do not change the genre or mood they want.
3. Do NOT put lyrics inside the enhanced_prompt — keep them strictly in suggested_lyrics.
4. If the user provides lyrics, refine and restructure them with proper bracketed sections.
5. If no lyrics are provided and it's not instrumental, write creative original lyrics matching the described mood/genre.
6. Respond ONLY with a bare JSON object — no markdown, no code fences, no explanation:

{"thinking": "One sentence explaining your choices", "enhanced_prompt": "comma, separated, tags", "suggested_lyrics": "[Verse 1]\\nLyric line...\\n\\n[Chorus]\\n...", "suggested_parameters": {"music_steps": 20, "duration_seconds": 30}}

Only include parameters in suggested_parameters that should change from current values.`;
  }

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
6. For video generation, always include a "suggested_negative_prompt" string with terms to avoid (e.g., "text, watermark, bad anatomy, distorted, static, motionless, worst quality, blurry, jittery"). Also suggest "video_steps" (10-60, default 30) and "video_guidance" (1.0-8.0, default 3.5) based on prompt complexity.
7. Respond ONLY with a bare JSON object — no markdown, no code fences, no explanation before or after:

${isVideo ? '{"thinking": "...", "enhanced_prompt": "...", "suggested_negative_prompt": "text, watermark, distorted, worst quality, static, motionless", "suggested_parameters": {"video_steps": 30, "video_guidance": 3.5, "num_frames": 97}}' : '{"thinking": "One sentence explaining your parameter choices", "enhanced_prompt": "The enhanced, detailed prompt string", "suggested_parameters": {"steps": 4, "guidance": 3.5, "width": 768, "height": 1344}}'}

Only include parameters in suggested_parameters that should change from the current values. Omit seed unless you have a specific suggestion.`;
}

function getModelGuidance(
  model: string,
  isVideo: boolean,
  isMusic: boolean,
): string {
  if (isMusic) {
    return `## ACE-Step Music Generation Prompting Guide
- Use descriptive, tag-style captions combining genre, mood, instruments, and production style.
- Format: "genre tags, mood descriptors, instrument list, production style, tempo/BPM"
- Example: "electronic, synthwave, retro, energetic, driving bassline, arpeggiated synths, 80s drums, 128 BPM"
- Example: "acoustic folk, warm, gentle, fingerpicked guitar, soft vocals, campfire atmosphere, 90 BPM"
- Include tempo (BPM) when possible — it significantly improves generation quality.
- Specify key instruments: guitar, piano, synth, drums, bass, strings, brass, etc.
- Add mood/energy: upbeat, melancholic, ethereal, aggressive, peaceful, cinematic.
- Add production style: lo-fi, polished, raw, ambient, orchestral, minimalist.
- For vocal tracks, include vocal style: male/female, raspy, smooth, choir, whispered.
- For instrumental tracks, explicitly note "instrumental, no vocals".
- Duration: 30s (default), up to 300s. Turbo model works best ≤60s.
- Do NOT include lyrics in the caption — lyrics are a separate input field.`;
  }

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

    case "sdxl-base":
      return `## SDXL Base Prompting Guide
- Designed for character LoRA inference and fine-tuned models.
- Use detailed, descriptive prompts: "portrait of [character], [setting], [lighting], [style]".
- Add quality boosters: "masterpiece, best quality, highly detailed, 8k".
- Negative prompt support — use negative_prompt to suppress unwanted elements.
- 1024×1024 recommended for best LoRA results. Typical steps: 20–30, guidance 7.0.`;

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
  isMusic: boolean,
  seed?: number,
): string {
  const wordCount = rawPrompt.trim().split(/\s+/).length;
  const complexity =
    wordCount <= 5
      ? "very simple (≤5 words)"
      : wordCount <= 15
        ? "moderate (6–15 words)"
        : `detailed (${wordCount} words)`;

  const paramSummary = isMusic
    ? `Duration: ${(params as Record<string, unknown>).duration_seconds ?? 30}s, Steps: ${(params as Record<string, unknown>).music_steps ?? 20}, Instrumental: ${(params as Record<string, unknown>).instrumental ?? false}${seed != null ? `, Seed: ${seed}` : ", Seed: (none)"}`
    : isVideo
      ? `Frames: ${params.num_frames ?? 97}, FPS: ${params.fps ?? 24}, Steps: ${params.steps ?? 30}, Guidance: ${params.guidance ?? 3.5}, Resolution: 768×512${seed != null ? `, Seed: ${seed}` : ", Seed: (none)"}`
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
        suggested_lyrics?: string;
        suggested_negative_prompt?: string;
        suggested_parameters?: Record<string, unknown>;
      };

      if (parsed.enhanced_prompt) {
        const suggested: EnhancePromptResponse["suggested_parameters"] = {};
        const sp = parsed.suggested_parameters ?? {};

        if (typeof sp.steps === "number") suggested.steps = sp.steps;
        if (typeof sp.guidance === "number") suggested.guidance = sp.guidance;
        if (typeof sp.width === "number") suggested.width = sp.width;
        if (typeof sp.height === "number") suggested.height = sp.height;
        if (typeof sp.num_frames === "number")
          suggested.num_frames = sp.num_frames;
        if (typeof sp.fps === "number") suggested.fps = sp.fps;
        if (typeof sp.seed === "number") suggested.seed = sp.seed;
        if (typeof sp.duration_seconds === "number")
          suggested.duration_seconds = sp.duration_seconds;
        if (typeof sp.music_steps === "number")
          suggested.music_steps = sp.music_steps;
        if (typeof sp.video_steps === "number")
          suggested.video_steps = sp.video_steps;
        if (typeof sp.video_guidance === "number")
          suggested.video_guidance = sp.video_guidance;

        return {
          enhanced_prompt: parsed.enhanced_prompt,
          thinking: parsed.thinking ?? "",
          suggested_lyrics:
            typeof parsed.suggested_lyrics === "string"
              ? parsed.suggested_lyrics
              : undefined,
          suggested_negative_prompt:
            typeof parsed.suggested_negative_prompt === "string"
              ? parsed.suggested_negative_prompt
              : undefined,
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
