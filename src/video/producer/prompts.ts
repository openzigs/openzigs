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

CRITICAL RULES — DURATION AND COVERAGE:
- The output video MUST use at least 70% of the combined source material duration.
- For example: if you have 80 seconds of source footage, the output video should be at least 56 seconds long.
- You MUST include video_clip entries from EVERY source clip provided. Do NOT ignore any input clips.
- Each source clip MUST be split into at least 5-8 segments (more if the clip is longer).
- Spread trimStart values EVENLY across the ENTIRE duration of each source clip (beginning, middle, and end — not just the first 30 seconds).
- Use shot lengths of 3-8 seconds (4-6 second average). Do NOT make all clips 2-3 seconds — that creates a jarring, choppy video.
- Interleave segments from different source clips for variety — do NOT play one entire clip before the next.
- Every video_clip entry must reference an ACTUAL source path from the clip context. Never hallucinate file paths.

DURATION CALCULATION RULE:
- Count total source duration from the clip context (sum of all clip durations).
- Your output timeline's total frame span (last clip's startAtFrame + duration) should be at least 70% of that, converted to frames at the composition's FPS.
- If you have 2 clips each ~40 seconds (80s total), your output should be at least 56 seconds (1680 frames at 30fps).

INTRO AND OUTRO TITLE CARDS (REQUIRED):
- You MUST include a title_card entry as the FIRST item in the timeline (startAtFrame: 0). This is the intro card.
  - Use the project title as the "title" field.
  - Add a relevant subtitle (e.g. a tagline, date, or topic summary).
  - Set duration to 90-120 frames (3-4 seconds).
  - Set animation to "fade" or "slide-up".
- You MUST include a title_card entry as the LAST item in the timeline (after all video clips). This is the outro/exit card.
  - Use a closing phrase as the title (e.g. "Thanks for watching", the brand name, or a call-to-action).
  - Set duration to 60-90 frames (2-3 seconds).
  - Set animation to "fade".
- Place a crossfade transition AFTER the intro title card and BEFORE the outro title card.

EDITING RULES:
- Reorder clips for logical narrative flow (intro → body → conclusion)
- Remove dead air: trim segments with >2s silence AND no visual change — but do NOT over-trim; keep most of the interesting content
- Remove filler words: "um", "uh", "like" clusters (trim surrounding 0.5s)
- Target 4-6 second average shot length for smooth, professional pacing
- Use crossfade transitions between clips (20 frames default)
- Select the most appropriate template based on content type

SPECIAL EFFECTS — CREATIVE DIRECTION:
You MUST use effects creatively to elevate the production quality. Do NOT produce a flat sequence of plain cuts. Apply effects based on the visual content and emotional context described in the keyframe descriptions:

- slowZoom: Apply Ken Burns-style slow zoom on static shots, product close-ups, landscapes, or any shot held >8 seconds. Use from: 1.0, to: 1.2 for subtle; from: 1.0, to: 1.4 for dramatic.
- fadeIn: Use on the very first clip AND after any title card. Also use after dramatic pauses or topic transitions (15-30 frames).
- fadeOut: Use on the final clip to close the video. Also use before title cards or section breaks (15-30 frames).
- blur: Apply animated blur transitions (amount: 8-15) for focus-pull effects between close-up and wide shots. Also use to emphasis speakers by blurring background shots (amount: 3-5).
- grayscale: Apply to flashback sequences, archival footage, B-roll establishing shots, or to create tonal contrast before a key moment.
- speedRamp: Use factor 1.5-2.0 to energize action sequences, montages, or time-lapse segments. Use factor 0.5-0.7 for dramatic slow-motion on impactful moments.

EFFECTS BEST PRACTICES:
- Aim for at least 40% of video_clip entries to have at least one effect.
- Layer effects: a clip can have BOTH slowZoom AND fadeIn simultaneously.
- Match effects to content: read the visual descriptions carefully to choose appropriate effects.
- Create visual rhythm: alternate between effect-heavy and clean shots for dynamic pacing.
- Use speedRamp sparingly (2-3 times max) for maximum impact.

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

VIDEO EFFECT TYPES (for use in video_clip "effects" array — APPLY GENEROUSLY):
- { "type": "slowZoom", "from": number, "to": number }  — Ken Burns zoom. from/to are scale factors (e.g. from: 1.0, to: 1.3 zooms in 30%). Use on >60% of static shots.
- { "type": "fadeIn", "durationFrames": number }  — fade in from black. Use 15-30 frames. Apply on opening + after title cards.
- { "type": "fadeOut", "durationFrames": number }  — fade out to black. Use 15-30 frames. Apply on closing + before section breaks.
- { "type": "blur", "amount": number, "startFrame": number, "endFrame": number }  — motion blur / focus pull. amount 3-5 for subtle, 8-15 for dramatic.
- { "type": "grayscale" }  — full desaturation. Use for flashbacks, contrast, or archival B-roll.
- { "type": "speedRamp", "factor": number, "startFrame": number, "endFrame": number }  — factor > 1 speeds up, < 1 slows down. Max 2-3 uses per video.`;
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

  // When voiceover was generated, the video must match its duration.
  // When no voiceover (TTS unavailable), the script still guides content
  // selection but clip durations determine total length.
  const hasVoiceover = voiceoverDuration > 0;

  const durationGuidance = hasVoiceover
    ? `- The total video duration MUST EXACTLY match the voiceover duration (${voiceoverDuration.toFixed(1)}s / ${Math.round(voiceoverDuration * 30)} frames at 30fps). Fill the entire duration with video clips.
- Each video_clip entry should have volume: 0 (voiceover replaces original audio)
- Calculate: you need enough video_clip segments to fill ${voiceoverDuration.toFixed(1)} seconds. At 4-6 seconds per clip, that is roughly ${Math.ceil(voiceoverDuration / 5)} clips minimum.`
    : `- Determine total video duration from the combined source clip durations — use at least 70% of the total source footage.
- Each video_clip entry should have volume: 0.8 (script provides narrative context but there is no voiceover audio)
- If the script text is provided, estimate its spoken duration (roughly 150 words per minute) and match the video length to it.`;

  const voiceoverInputLine = hasVoiceover
    ? `1. A voiceover audio file (duration: ${voiceoverDuration.toFixed(1)}s) — this is the PRIMARY audio`
    : `1. A script text — this guides which clips to show and in what order (NO voiceover audio is available)`;

  const voiceoverTaskLine = hasVoiceover
    ? `- Uses the voiceover as the main audio track`
    : `- Uses the script text to determine clip selection and ordering (no voiceover audio)`;

  return `You are a professional video editor working in script-driven mode.

INPUTS:
${voiceoverInputLine}
2. B-Roll video clips with descriptions and durations
3. The original script text

YOUR TASK: Create a JSON manifest that:
${voiceoverTaskLine}
- Matches B-Roll clips to script sections semantically
- Loops or stretches clips if total B-Roll < desired duration
- Adds background music at volume ${hasVoiceover ? "0.15" : "0.3"} with ducking ${hasVoiceover ? "enabled" : "disabled"} (if a music track is available)

INTRO AND OUTRO TITLE CARDS (REQUIRED):
- You MUST include a title_card entry as the FIRST item in the timeline (startAtFrame: 0). This is the intro card.
  - Use the project title as the "title" field.
  - Add a relevant subtitle (e.g. a tagline, topic summary, or episode info).
  - Set duration to 90-120 frames (3-4 seconds).
  - Set animation to "fade" or "slide-up".
- You MUST include a title_card entry as the LAST item in the timeline (after all video clips). This is the outro/exit card.
  - Use a closing phrase as the title (e.g. "Thanks for watching", the brand name, or a call-to-action).
  - Set duration to 60-90 frames (2-3 seconds).
  - Set animation to "fade".
- Place a crossfade transition AFTER the intro title card and BEFORE the outro title card.

CRITICAL — MULTI-CLIP AND DURATION RULES:
- You MUST include video_clip entries from EVERY source clip provided. Do NOT ignore any input clips.
- Break each source clip into at least 5-8 segments at different trim points spread evenly across the clip's full duration.
- Interleave clips from different sources for variety.
- Every video_clip entry must reference an ACTUAL source path from the clip context. Never hallucinate file paths.
- The output video MUST use at least 70% of the combined source material.
- Use shot lengths of 3-8 seconds (4-6 second average). Do NOT make all clips 2-3 seconds.
- Spread trimStart values across the ENTIRE duration of each clip.

MUSIC RULES:
- If a background music track is provided, you MUST include it in audioLayer.music
- Use the EXACT file path provided — do not rename or modify it
- Set ducking: ${hasVoiceover ? "true" : "false"} ${hasVoiceover ? "so music ducks during voiceover" : "(no voiceover to duck for)"}
- Set loop: true, fadeInFrames: 30, fadeOutFrames: 60

${templateLine}AVAILABLE TEMPLATES: ${validTemplates.join(", ")}

RULES:
${durationGuidance}
- Choose visual clips that semantically match the script text being spoken at that point

SPECIAL EFFECTS — CREATIVE DIRECTION:
You MUST use effects creatively to elevate the production quality. Do NOT produce a flat sequence of plain cuts. Apply effects based on the visual content described in the keyframe descriptions and the emotional context of the script:

- slowZoom: Apply Ken Burns-style slow zoom on B-roll, static shots, and any clip held >8 seconds. Match zoom direction to content: zoom IN on details being discussed, zoom OUT on establishing shots. Use from: 1.0-1.1, to: 1.2-1.4.
- fadeIn: Use on the opening clip and after title cards. Also use when the script transitions to a new topic (15-30 frames).
- fadeOut: Use on the closing clip. Also use before section transitions or dramatic pauses in the narration (15-30 frames).
- blur: Apply animated focus-pull effects when transitioning between detail shots and wide shots (amount: 8-15). Use subtle background blur (amount: 3-5) on clips showing speakers.
- grayscale: Apply to B-roll that represents the past, comparisons, or to create visual contrast before a key narrative beat.
- speedRamp: Use factor 1.5-2.0 for energetic montage segments. Use factor 0.5-0.7 for slow-motion on emotionally impactful moments.

EFFECTS BEST PRACTICES:
- Aim for at least 40% of video_clip entries to have at least one effect.
- Layer effects: a clip can have BOTH slowZoom AND fadeIn simultaneously.
- Match effects to script content: emphasize key words/phrases with visual effects.
- Create visual rhythm: alternate between effect-heavy and clean shots.
- Use speedRamp sparingly (2-3 times max) for maximum impact.

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
  "metadata": { "generatedAt": ISO8601, "llmModel": string, "llmTokensUsed": number, "productionMode": "script", "sourceClips": string[] }
}

VIDEO EFFECT TYPES (for use in video_clip "effects" array — APPLY GENEROUSLY):
- { "type": "slowZoom", "from": number, "to": number }  — Ken Burns zoom. from/to are scale factors. Use on >60% of static shots.
- { "type": "fadeIn", "durationFrames": number }  — fade in from black. Use 15-30 frames.
- { "type": "fadeOut", "durationFrames": number }  — fade out to black. Use 15-30 frames.
- { "type": "blur", "amount": number, "startFrame": number, "endFrame": number }  — focus pull / motion blur.
- { "type": "grayscale" }  — full desaturation for tonal contrast.
- { "type": "speedRamp", "factor": number, "startFrame": number, "endFrame": number }  — factor > 1 speeds up, < 1 slows down.

REQUIRED fields: projectTitle, templateId, composition, audioLayer, timeline, metadata.
${hasVoiceover ? "Set audioLayer.voiceover.source to the voiceover file path.\nSet all video_clip entries: volume: 0" : "Set audioLayer.voiceover to null (no voiceover audio available)."}`;
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
    /** Total duration of all source clips in seconds */
    totalSourceDuration?: number;
    /** Clip durations in seconds, keyed by source path */
    clipDurations?: Record<string, number>;
  },
): string {
  const parts: string[] = [];

  parts.push("=== VIDEO CLIP CONTEXT ===");
  parts.push(contextText);

  // Add explicit duration targets so the LLM knows how long to make the video
  if (options.totalSourceDuration && options.totalSourceDuration > 0) {
    const targetDuration = Math.round(options.totalSourceDuration * 0.75);
    const targetFrames = targetDuration * 30;
    parts.push(`\n=== DURATION TARGET ===`);
    parts.push(`Total source footage: ${options.totalSourceDuration.toFixed(1)} seconds`);
    parts.push(`MINIMUM output video duration: ${targetDuration} seconds (${targetFrames} frames at 30fps)`);
    parts.push(`You need approximately ${Math.ceil(targetDuration / 5)} video_clip segments (at ~5s avg each) to fill this.`);

    if (options.clipDurations) {
      parts.push(`\nPer-clip guidance:`);
      for (const [source, duration] of Object.entries(options.clipDurations)) {
        const basename = source.split("/").pop() ?? source;
        const minSegments = Math.max(5, Math.ceil(duration / 8));
        parts.push(`  ${basename} (${duration.toFixed(1)}s): create at least ${minSegments} segments, spread trimStart from 0 to ${Math.floor(duration * 30)} frames`);
      }
    }
  }

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
