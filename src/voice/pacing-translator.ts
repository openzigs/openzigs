/**
 * Director Mode — Pacing Tag Translator
 * Issue #320: Custom bracket syntax for TTS pacing control.
 *
 * Bracket syntax survives the ScriptSanitizer (which strips all HTML/XML tags)
 * and is translated to engine-specific formats after sanitization.
 *
 * Supported tags:
 *   [PAUSE: 0.5s]  → SSML <break time="500ms"/> or silence padding
 *   [PAUSE: 2s]    → SSML <break time="2000ms"/> or silence padding
 *   [SPEED: 1.2x]  → SSML <prosody rate="120%"> or per-segment speed override
 *   [SPEED: 0.8x]  → SSML <prosody rate="80%"> or per-segment speed override
 *   [/SPEED]       → closes SSML <prosody> block (or resets speed to default)
 *   [VOICE: id]    → switches voice preset for subsequent text (local TTS only)
 *   *word*         → SSML <emphasis>word</emphasis>
 */

import { logger } from "../logging/logger.js";

// ── Regexes ───────────────────────────────────────────────────

/** Matches [PAUSE: Xs] or [PAUSE: X.Xs] where X is 0.1–10. */
export const PAUSE_RE = /\[PAUSE:\s*(\d+(?:\.\d+)?)s\]/gi;

/** Matches *word* or *multiple words* for emphasis (no nested asterisks). */
export const EMPHASIS_RE = /\*([^*]+)\*/g;

/** Matches [SPEED: Xx] where X is 0.5–2.0. */
export const SPEED_RE = /\[SPEED:\s*(\d+(?:\.\d+)?)x\]/gi;

/** Matches [/SPEED] to close a speed region. */
export const SPEED_END_RE = /\[\/SPEED\]/gi;

/** Matches [VOICE: id] where id is a voice preset identifier. */
export const VOICE_RE = /\[VOICE:\s*([a-z]{1,2}_[a-z]+)\]/gi;

// ── Types ─────────────────────────────────────────────────────

/** A text segment followed by an optional silence gap (for local TTS engines). */
export interface PacingSegment {
  text: string;
  pauseAfterMs: number;
  /** Per-segment speed override (0.5–2.0). Undefined means use global config. */
  speed?: number;
  /** Per-segment voice preset override. Undefined means use global config. */
  voice?: string;
}

/** Result of translating pacing tags. */
export interface PacingTranslation {
  /** SSML string ready for Google Cloud TTS. */
  ssml: string;
  /** Ordered segments for local TTS engines that don't support SSML. */
  plainSegments: PacingSegment[];
  /** Whether any pacing tags were found. */
  hasTags: boolean;
}

/**
 * All supported narration directives, for UI autocomplete.
 */
export const NARRATION_DIRECTIVES = [
  { tag: "[PAUSE: 0.5s]", label: "Short pause", description: "Insert a 0.5 second silence" },
  { tag: "[PAUSE: 1s]", label: "Pause", description: "Insert a 1 second silence" },
  { tag: "[PAUSE: 2s]", label: "Long pause", description: "Insert a 2 second silence" },
  { tag: "[SPEED: 0.8x]", label: "Slow down", description: "Reduce speaking rate to 80%" },
  { tag: "[SPEED: 1.2x]", label: "Speed up", description: "Increase speaking rate to 120%" },
  { tag: "[SPEED: 1.5x]", label: "Fast", description: "Increase speaking rate to 150%" },
  { tag: "[/SPEED]", label: "Reset speed", description: "Return to normal speaking rate" },
  { tag: "[VOICE: af_heart]", label: "Voice: Warm Female", description: "Switch to warm, expressive voice" },
  { tag: "[VOICE: af_nova]", label: "Voice: Energetic Female", description: "Switch to bright, energetic voice" },
  { tag: "[VOICE: af_sarah]", label: "Voice: Gentle Female", description: "Switch to soft, gentle voice" },
  { tag: "[VOICE: am_adam]", label: "Voice: Authoritative Male", description: "Switch to deep, authoritative voice" },
  { tag: "[VOICE: am_liam]", label: "Voice: Friendly Male", description: "Switch to casual, friendly voice" },
  { tag: "[VOICE: bm_daniel]", label: "Voice: Broadcast Male", description: "Switch to deep, broadcast voice" },
  { tag: "*word*", label: "Emphasis", description: "Emphasize a word or phrase (Google TTS)" },
] as const;

// ── Constants ─────────────────────────────────────────────────

const MIN_PAUSE_SEC = 0.1;
const MAX_PAUSE_SEC = 10;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;

// ── Public API ────────────────────────────────────────────────

/**
 * Detect whether the given text contains any pacing tags.
 */
export function hasPacingTags(text: string): boolean {
  // Reset lastIndex for all global regexes before testing
  PAUSE_RE.lastIndex = 0;
  EMPHASIS_RE.lastIndex = 0;
  SPEED_RE.lastIndex = 0;
  SPEED_END_RE.lastIndex = 0;
  VOICE_RE.lastIndex = 0;
  return PAUSE_RE.test(text) || EMPHASIS_RE.test(text) || SPEED_RE.test(text) || VOICE_RE.test(text);
}

/**
 * Translate bracket pacing tags into both SSML and plain segment representations.
 *
 * @param sanitizedText - Text that has already passed through ScriptSanitizer
 * @returns PacingTranslation with SSML and plain segments
 */
export function translatePacingTags(sanitizedText: string): PacingTranslation {
  if (!sanitizedText || sanitizedText.trim().length === 0) {
    return { ssml: "<speak></speak>", plainSegments: [], hasTags: false };
  }

  // Reset lastIndex for all global regexes
  PAUSE_RE.lastIndex = 0;
  EMPHASIS_RE.lastIndex = 0;
  SPEED_RE.lastIndex = 0;
  SPEED_END_RE.lastIndex = 0;
  VOICE_RE.lastIndex = 0;

  const foundTags = PAUSE_RE.test(sanitizedText) || EMPHASIS_RE.test(sanitizedText)
    || SPEED_RE.test(sanitizedText) || VOICE_RE.test(sanitizedText);
  // Reset lastIndex after test() calls (they're global regexes)
  PAUSE_RE.lastIndex = 0;
  EMPHASIS_RE.lastIndex = 0;
  SPEED_RE.lastIndex = 0;
  SPEED_END_RE.lastIndex = 0;
  VOICE_RE.lastIndex = 0;

  if (!foundTags) {
    return {
      ssml: `<speak>${escapeXml(sanitizedText)}</speak>`,
      plainSegments: [{ text: sanitizedText.trim(), pauseAfterMs: 0 }],
      hasTags: false,
    };
  }

  // Build SSML
  const ssml = buildSsml(sanitizedText);

  // Build plain segments (split at pause/speed/voice points)
  const plainSegments = buildPlainSegments(sanitizedText);

  return { ssml, plainSegments, hasTags: true };
}

// ── Internal helpers ──────────────────────────────────────────

/**
 * Build SSML string from text with bracket tags.
 *
 * [PAUSE: Xs]  → <break time="Xms"/>
 * [SPEED: Xx]  → <prosody rate="X%">
 * [/SPEED]     → </prosody>
 * [VOICE: id]  → stripped (no SSML equivalent for local voices)
 * *word*       → <emphasis>word</emphasis>
 */
function buildSsml(text: string): string {
  let ssml = text;

  // Replace pause tags with SSML breaks
  ssml = ssml.replace(PAUSE_RE, (_match, seconds: string) => {
    const sec = clampPause(parseFloat(seconds));
    const ms = Math.round(sec * 1000);
    return `<break time="${ms}ms"/>`;
  });

  // Replace speed tags with SSML prosody
  ssml = ssml.replace(SPEED_RE, (_match, factor: string) => {
    const rate = clampSpeed(parseFloat(factor));
    const pct = Math.round(rate * 100);
    return `<prosody rate="${pct}%">`;
  });
  ssml = ssml.replace(SPEED_END_RE, () => `</prosody>`);

  // Strip voice tags (no SSML equivalent — only affects local TTS)
  ssml = ssml.replace(VOICE_RE, "");

  // Replace emphasis tags
  ssml = ssml.replace(EMPHASIS_RE, (_match, word: string) => {
    return `<emphasis>${escapeXml(word)}</emphasis>`;
  });

  // Escape any remaining XML-unsafe characters in the non-tag text.
  const parts = ssml.split(/(<break time="\d+ms"\/>|<emphasis>.*?<\/emphasis>|<prosody rate="\d+%">|<\/prosody>)/g);
  const escaped = parts.map((part) => {
    if (part.startsWith("<break") || part.startsWith("<emphasis") || part.startsWith("<prosody") || part === "</prosody>") {
      return part;
    }
    return escapeXml(part);
  });

  return `<speak>${escaped.join("")}</speak>`;
}

/**
 * Build plain text segments split at pause, speed, and voice boundaries.
 * Each segment has text to synthesize plus optional speed/voice overrides.
 */
function buildPlainSegments(text: string): PacingSegment[] {
  const segments: PacingSegment[] = [];

  // Strip emphasis markers for plain text (local TTS doesn't support them)
  const plain = text.replace(EMPHASIS_RE, "$1");
  EMPHASIS_RE.lastIndex = 0;

  // Tokenize: split into text parts and directive tokens
  const ALL_DIRECTIVES_RE = /(\[PAUSE:\s*\d+(?:\.\d+)?s\]|\[SPEED:\s*\d+(?:\.\d+)?x\]|\[\/SPEED\]|\[VOICE:\s*[a-z]{1,2}_[a-z]+\])/gi;
  const parts = plain.split(ALL_DIRECTIVES_RE);

  let currentSpeed: number | undefined;
  let currentVoice: string | undefined;

  for (const part of parts) {
    // Check if this part is a directive
    PAUSE_RE.lastIndex = 0;
    SPEED_RE.lastIndex = 0;
    SPEED_END_RE.lastIndex = 0;
    VOICE_RE.lastIndex = 0;

    const pauseMatch = PAUSE_RE.exec(part);
    if (pauseMatch) {
      // Add pause to the previous segment if it exists
      const pauseMs = Math.round(clampPause(parseFloat(pauseMatch[1])) * 1000);
      if (segments.length > 0) {
        segments[segments.length - 1].pauseAfterMs = pauseMs;
      } else {
        // Pause at the very start — create an empty segment just for the pause
        segments.push({ text: "", pauseAfterMs: pauseMs, speed: currentSpeed, voice: currentVoice });
      }
      continue;
    }

    const speedMatch = SPEED_RE.exec(part);
    if (speedMatch) {
      currentSpeed = clampSpeed(parseFloat(speedMatch[1]));
      continue;
    }

    if (SPEED_END_RE.test(part)) {
      currentSpeed = undefined;
      continue;
    }

    const voiceMatch = VOICE_RE.exec(part);
    if (voiceMatch) {
      currentVoice = voiceMatch[1];
      continue;
    }

    // Regular text
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      segments.push({
        text: trimmed,
        pauseAfterMs: 0,
        speed: currentSpeed,
        voice: currentVoice,
      });
    }
  }

  return segments;
}

/**
 * Clamp pause duration to the valid range and log a warning if out of bounds.
 */
function clampPause(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    logger.warn(`[PacingTranslator] Invalid pause duration: ${seconds}s — using ${MIN_PAUSE_SEC}s`);
    return MIN_PAUSE_SEC;
  }
  if (seconds < MIN_PAUSE_SEC) {
    logger.warn(`[PacingTranslator] Pause ${seconds}s below minimum — clamping to ${MIN_PAUSE_SEC}s`);
    return MIN_PAUSE_SEC;
  }
  if (seconds > MAX_PAUSE_SEC) {
    logger.warn(`[PacingTranslator] Pause ${seconds}s above maximum — clamping to ${MAX_PAUSE_SEC}s`);
    return MAX_PAUSE_SEC;
  }
  return seconds;
}

/**
 * Clamp speed factor to the valid range (0.5–2.0).
 */
function clampSpeed(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) {
    logger.warn(`[PacingTranslator] Invalid speed: ${factor}x — using 1.0x`);
    return 1.0;
  }
  if (factor < MIN_SPEED) {
    logger.warn(`[PacingTranslator] Speed ${factor}x below minimum — clamping to ${MIN_SPEED}x`);
    return MIN_SPEED;
  }
  if (factor > MAX_SPEED) {
    logger.warn(`[PacingTranslator] Speed ${factor}x above maximum — clamping to ${MAX_SPEED}x`);
    return MAX_SPEED;
  }
  return factor;
}

/**
 * Escape XML special characters in text content.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
