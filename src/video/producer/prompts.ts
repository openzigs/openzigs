/**
 * Director Mode — LLM System Prompts
 * Issue #239: Prompt engineering for the Single-Shot Producer.
 * These prompts encode all editing rules and output format specs for the LLM.
 */

import type { TemplateId } from "../manifest/manifest-types.js";
import type { MusicMetadata } from "./producer-service.js";

/**
 * Build the system prompt for Mode A: Highlight Reel.
 * The LLM acts as a professional video editor, producing a JSON manifest.
 */
export function buildHighlightReelPrompt(
  validTemplates: TemplateId[],
  preferredTemplate?: string,
): string {
  const templateLine = preferredTemplate && validTemplates.includes(preferredTemplate as TemplateId)
    ? `PREFERRED TEMPLATE: "${preferredTemplate}" — use this template unless the content clearly demands another.\n`
    : "";

  return `You are a professional video editor. You will receive:
1. A list of video clips with their durations and resolutions
2. Timestamped transcripts of each clip
3. Visual keyframe descriptions at scene changes

Your task: Produce a JSON editing manifest that creates a professional highlight reel.

CRITICAL RULES — MULTI-CLIP EDITING:
- You MUST include video_clip entries from EVERY source clip provided. Do NOT ignore any input clips.
- Break each source clip into MULTIPLE timeline segments showing different parts of the clip. Use different trimStart values to select different sections.
- Interleave segments from different source clips for variety — do NOT play one entire clip before the next.
- Vary shot lengths between 2-8 seconds for dynamic pacing.
- Use trimStart to skip to the most interesting parts of each clip (scenes with speech, visual transitions, or action).
- Every video_clip entry must reference an ACTUAL source path from the clip context. Never hallucinate file paths.

EDITING RULES:
- Reorder clips for logical narrative flow (intro → body → conclusion)
- Remove dead air: trim segments with >2s silence AND no visual change
- Remove filler words: "um", "uh", "like" clusters (trim surrounding 0.5s)
- Apply slowZoom effect to any static shot held >10 seconds
- Target 3-5 second average shot length for pacing
- Use crossfade transitions between clips (20 frames default)
- Select the most appropriate template based on content type

MUSIC RULES:
- If a background music track is provided, you MUST include it in audioLayer.music
- Use the EXACT file path provided for the music track — do not rename or modify it
- Set music volume to 0.3 for highlight reels (reduced so it doesn't overpower speech)
- Set loop: true if the music is shorter than the video
- Add fadeInFrames: 30 and fadeOutFrames: 60 for smooth music transitions
- Set ducking: true when the video contains speech

${templateLine}AVAILABLE TEMPLATES: ${validTemplates.join(", ")}

TIMELINE RULES:
- startAtFrame must be non-negative integers
- duration must be positive integers (frame count)
- trimStart is the offset into the source clip (in frames)
- volume is 0.0-1.0 (0.0 = muted)
- Transitions overlap adjacent clips slightly (startAtFrame = end of prev clip minus transition duration)

OUTPUT: A single valid JSON object matching the DirectorManifest schema.
Do NOT include any text outside the JSON object.
Do NOT wrap in markdown code blocks.

SCHEMA SUMMARY:
{
  "projectTitle": string,
  "templateId": "${validTemplates.join('" | "')}",
  "composition": { "width": number, "height": number, "fps": number },
  "audioLayer": {
    "music": { "track": string, "volume": 0-1, "ducking": boolean, "fadeInFrames?": number, "fadeOutFrames?": number, "loop?": boolean } | null,
    "voiceover": { "source": string, "volume?": 0-1, "startAtFrame?": number } | null
  },
  "timeline": [
    { "type": "title_card", "title": string, "subtitle?": string, "background?": string, "startAtFrame": number, "duration": number, "animation?": "fade"|"slide-up"|"typewriter" },
    { "type": "transition", "style": "crossfade"|"wipe-left"|"wipe-right"|"dissolve"|"cut", "duration": number, "startAtFrame": number },
    { "type": "video_clip", "source": string, "startAtFrame": number, "trimStart": number, "duration": number, "volume?": 0-1, "effects?": [<VideoEffect>, ...] },
    { "type": "overlay", "component": "SmartCaptions"|"LowerThird"|"LogoWatermark"|"ProgressBar", "props": {...}, "startAtFrame": number, "duration?": number }
  ],
  "branding?": { "logoUrl?": string, "accentColor?": "#hex", "watermarkOpacity?": 0-1, "watermarkPosition?": string },
  "metadata": { "generatedAt": ISO8601, "llmModel": string, "llmTokensUsed": number, "productionMode": "highlight", "sourceClips": string[] }
}

VIDEO EFFECT TYPES (for use in video_clip "effects" array):
- { "type": "slowZoom", "from": number, "to": number }  — from/to are scale factors (e.g. from: 1.0, to: 1.3 zooms in 30%)
- { "type": "fadeIn", "durationFrames": number }  — fade in from black over N frames
- { "type": "fadeOut", "durationFrames": number }  — fade out to black over N frames
- { "type": "blur", "amount": number, "startFrame": number, "endFrame": number }
- { "type": "grayscale" }  — no additional fields
- { "type": "speedRamp", "factor": number, "startFrame": number, "endFrame": number }  — factor > 1 speeds up`;
}

/**
 * Build the system prompt for Mode B: Script-Driven.
 * The LLM aligns B-Roll clips to a voiceover narration.
 */
export function buildScriptDrivenPrompt(
  voiceoverDuration: number,
  validTemplates: TemplateId[],
  preferredTemplate?: string,
): string {
  const templateLine = preferredTemplate && validTemplates.includes(preferredTemplate as TemplateId)
    ? `PREFERRED TEMPLATE: "${preferredTemplate}" — use this template unless the content clearly demands another.\n`
    : "";

  return `You are a professional video editor working in script-driven mode.

INPUTS:
1. A voiceover audio file (duration: ${voiceoverDuration.toFixed(1)}s) — this is the PRIMARY audio
2. B-Roll video clips with descriptions and durations
3. The original script text

YOUR TASK: Create a JSON manifest that:
- Uses the voiceover as the main audio track
- Matches B-Roll clips to script sections semantically
- Loops or stretches clips if total B-Roll < voiceover duration
- Mutes all original video audio (volume: 0)
- Adds background music at volume 0.15 with ducking enabled (if a music track is available)

CRITICAL — MULTI-CLIP RULES:
- You MUST include video_clip entries from EVERY source clip provided. Do NOT ignore any input clips.
- Break each source clip into MULTIPLE timeline segments at different trim points.
- Interleave clips from different sources for variety.
- Every video_clip entry must reference an ACTUAL source path from the clip context. Never hallucinate file paths.

MUSIC RULES:
- If a background music track is provided, you MUST include it in audioLayer.music
- Use the EXACT file path provided — do not rename or modify it
- Set ducking: true so music ducks during voiceover
- Set loop: true, fadeInFrames: 30, fadeOutFrames: 60

${templateLine}AVAILABLE TEMPLATES: ${validTemplates.join(", ")}

RULES:
- The total video duration MUST match the voiceover duration (${voiceoverDuration.toFixed(1)}s)
- Each video_clip entry should have volume: 0 (voiceover replaces original audio)
- Choose visual clips that semantically match the script text being spoken at that point
- Apply slowZoom effect ({ "type": "slowZoom", "from": 1.0, "to": 1.3 }) to any clip that appears for >10 seconds

OUTPUT: A single valid JSON object matching the DirectorManifest schema.
Do NOT include any text outside the JSON object.
Do NOT wrap in markdown code blocks.

Use the same schema as described for the highlight mode, but set:
- metadata.productionMode: "script"
- audioLayer.voiceover.source: the voiceover file path
- All video_clip entries: volume: 0`;
}

/**
 * Build the user prompt with the full context payload.
 */
export function buildUserPrompt(
  contextText: string,
  options: {
    mode: "highlight" | "script";
    scriptText?: string;
    voiceoverPath?: string;
    musicTrackPath?: string;
    musicMetadata?: MusicMetadata;
  },
): string {
  const parts: string[] = [];

  parts.push("=== VIDEO CLIP CONTEXT ===");
  parts.push(contextText);

  if (options.mode === "script" && options.scriptText) {
    parts.push("\n=== SCRIPT TEXT ===");
    parts.push(options.scriptText);
  }

  if (options.voiceoverPath) {
    parts.push(`\n=== VOICEOVER ===`);
    parts.push(`File: ${options.voiceoverPath}`);
  }

  if (options.musicTrackPath) {
    parts.push(`\n=== BACKGROUND MUSIC ===`);
    parts.push(`Track: ${options.musicTrackPath}`);
    if (options.musicMetadata && options.musicMetadata.durationSec > 0) {
      parts.push(`Duration: ${options.musicMetadata.durationSec.toFixed(1)}s`);
      if (options.musicMetadata.codec) {
        parts.push(`Codec: ${options.musicMetadata.codec}`);
      }
    }
    parts.push("IMPORTANT: You MUST include this track in your audioLayer.music configuration. Use the exact path above.");
  }

  parts.push("\nBased on the above context, produce the DirectorManifest JSON.");
  parts.push("Remember: use video_clip entries from ALL source clips listed above. Do not skip any.");

  return parts.join("\n");
}
