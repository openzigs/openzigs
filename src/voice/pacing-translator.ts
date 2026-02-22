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
 *   *word*         → SSML <emphasis>word</emphasis>
 */

import { logger } from "../logging/logger.js";

// ── Regexes ───────────────────────────────────────────────────

/** Matches [PAUSE: Xs] or [PAUSE: X.Xs] where X is 0.1–10. */
export const PAUSE_RE = /\[PAUSE:\s*(\d+(?:\.\d+)?)s\]/gi;

/** Matches *word* or *multiple words* for emphasis (no nested asterisks). */
export const EMPHASIS_RE = /\*([^*]+)\*/g;

// ── Types ─────────────────────────────────────────────────────

/** A text segment followed by an optional silence gap (for local TTS engines). */
export interface PacingSegment {
  text: string;
  pauseAfterMs: number;
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

// ── Constants ─────────────────────────────────────────────────

const MIN_PAUSE_SEC = 0.1;
const MAX_PAUSE_SEC = 10;

// ── Public API ────────────────────────────────────────────────

/**
 * Detect whether the given text contains any pacing tags.
 */
export function hasPacingTags(text: string): boolean {
  return PAUSE_RE.test(text) || EMPHASIS_RE.test(text);
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

  const foundTags = PAUSE_RE.test(sanitizedText) || EMPHASIS_RE.test(sanitizedText);
  // Reset lastIndex after test() calls (they're global regexes)
  PAUSE_RE.lastIndex = 0;
  EMPHASIS_RE.lastIndex = 0;

  if (!foundTags) {
    return {
      ssml: `<speak>${escapeXml(sanitizedText)}</speak>`,
      plainSegments: [{ text: sanitizedText.trim(), pauseAfterMs: 0 }],
      hasTags: false,
    };
  }

  // Build SSML
  const ssml = buildSsml(sanitizedText);

  // Build plain segments (split at pause points)
  const plainSegments = buildPlainSegments(sanitizedText);

  return { ssml, plainSegments, hasTags: true };
}

// ── Internal helpers ──────────────────────────────────────────

/**
 * Build SSML string from text with bracket tags.
 *
 * [PAUSE: Xs] → <break time="Xms"/>
 * *word*      → <emphasis>word</emphasis>
 */
function buildSsml(text: string): string {
  let ssml = text;

  // Replace pause tags with SSML breaks
  ssml = ssml.replace(PAUSE_RE, (_match, seconds: string) => {
    const sec = clampPause(parseFloat(seconds));
    const ms = Math.round(sec * 1000);
    return `<break time="${ms}ms"/>`;
  });

  // Replace emphasis tags
  ssml = ssml.replace(EMPHASIS_RE, (_match, word: string) => {
    return `<emphasis>${escapeXml(word)}</emphasis>`;
  });

  // Escape any remaining XML-unsafe characters in the non-tag text.
  // We need to be careful not to double-escape the tags we just inserted.
  // Strategy: split on our inserted tags, escape the text parts, rejoin.
  const parts = ssml.split(/(<break time="\d+ms"\/>|<emphasis>.*?<\/emphasis>)/g);
  const escaped = parts.map((part) => {
    if (part.startsWith("<break") || part.startsWith("<emphasis")) {
      return part; // Already SSML — leave as-is
    }
    return escapeXml(part);
  });

  return `<speak>${escaped.join("")}</speak>`;
}

/**
 * Build plain text segments split at pause boundaries.
 * Each segment is text to synthesize; pauseAfterMs indicates
 * how much silence to insert after that segment's audio.
 */
function buildPlainSegments(text: string): PacingSegment[] {
  const segments: PacingSegment[] = [];

  // Strip emphasis markers for plain text (local TTS doesn't support them)
  const plain = text.replace(EMPHASIS_RE, "$1");
  EMPHASIS_RE.lastIndex = 0;

  // Split on PAUSE tags
  const parts = plain.split(PAUSE_RE);
  // split with a capture group alternates: text, captured seconds, text, captured seconds, ...

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Text part
      const trimmed = parts[i].trim();
      if (trimmed.length > 0) {
        // Check if next part is a pause duration
        const pauseSec = i + 1 < parts.length ? clampPause(parseFloat(parts[i + 1])) : 0;
        const pauseMs = Math.round(pauseSec * 1000);
        segments.push({ text: trimmed, pauseAfterMs: pauseMs });
      }
    }
    // Odd indices are the captured pause durations — already consumed above
  }

  // If the text ends with a pause and no trailing text, the last segment
  // still needs its pause value set correctly (already handled by the loop).

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
 * Escape XML special characters in text content.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
