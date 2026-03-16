/**
 * Converts Markdown formatting to platform-safe plain text using Unicode
 * transformations. Social platforms (LinkedIn, X/Twitter) do not
 * render Markdown — posting raw `**bold**` looks broken.  This utility
 * deterministically transforms common Markdown constructs into their Unicode
 * equivalents so posts look correct on every platform.
 */

// ── Unicode character maps ──

const BOLD_MAP: Record<string, string> = {};
const ITALIC_MAP: Record<string, string> = {};

// Mathematical Bold Sans-Serif (U+1D5D4–U+1D607)
const BOLD_UPPER_START = 0x1d5d4;
const BOLD_LOWER_START = 0x1d5ee;
const BOLD_DIGIT_START = 0x1d7ec;

// Mathematical Italic (U+1D434–U+1D467)
const ITALIC_UPPER_START = 0x1d434;
const ITALIC_LOWER_START = 0x1d44e;

for (let i = 0; i < 26; i++) {
  const upper = String.fromCharCode(65 + i);
  const lower = String.fromCharCode(97 + i);
  BOLD_MAP[upper] = String.fromCodePoint(BOLD_UPPER_START + i);
  BOLD_MAP[lower] = String.fromCodePoint(BOLD_LOWER_START + i);
  ITALIC_MAP[upper] = String.fromCodePoint(ITALIC_UPPER_START + i);
  ITALIC_MAP[lower] = String.fromCodePoint(ITALIC_LOWER_START + i);
}

// Mathematical italic has a special 'h' at U+210E
ITALIC_MAP["h"] = String.fromCodePoint(0x210e);

for (let i = 0; i < 10; i++) {
  BOLD_MAP[String(i)] = String.fromCodePoint(BOLD_DIGIT_START + i);
}

const toBold = (text: string): string =>
  [...text].map((ch) => BOLD_MAP[ch] ?? ch).join("");

const toItalic = (text: string): string =>
  [...text].map((ch) => ITALIC_MAP[ch] ?? ch).join("");

// ── Transformer ──

export function markdownToSocialText(markdown: string): string {
  let result = markdown;

  // Code blocks first (before any inline transforms touch backticks)
  result = result.replace(/```[\s\S]*?```/g, (block) => {
    return block.replace(/```\w*\n?/g, "").trim();
  });

  // Headers: # Text → BOLD UPPERCASE
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) =>
    toBold(heading.toUpperCase())
  );

  // Bold + Italic: ***text*** or ___text___
  result = result.replace(/\*{3}(.+?)\*{3}/g, (_m, t: string) => toBold(toItalic(t)));
  result = result.replace(/_{3}(.+?)_{3}/g, (_m, t: string) => toBold(toItalic(t)));

  // Bold: **text** or __text__
  result = result.replace(/\*{2}(.+?)\*{2}/g, (_m, t: string) => toBold(t));
  result = result.replace(/_{2}(.+?)_{2}/g, (_m, t: string) => toBold(t));

  // Italic: *text* or _text_
  result = result.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, (_m, t: string) => toItalic(t));
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, (_m, t: string) => toItalic(t));

  // Images before links (images start with !)
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[Image: $1]");

  // Links: [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Unordered lists: - item or * item → • item
  result = result.replace(/^[\s]*[-*]\s+/gm, "• ");

  // Ordered lists: 1. item → 1. item (keep as-is, already readable)

  // Blockquotes: > text → ❝text❞
  result = result.replace(/^>\s*(.+)$/gm, "❝$1❞");

  // Horizontal rules: --- or *** or ___ → ─────
  result = result.replace(/^[-*_]{3,}$/gm, "─────────────────────");

  // Inline code: `code` → code (just remove backticks)
  result = result.replace(/`([^`]+)`/g, "$1");

  // Strikethrough: ~~text~~ → text (no Unicode equivalent)
  result = result.replace(/~~(.+?)~~/g, "$1");

  return result;
}
