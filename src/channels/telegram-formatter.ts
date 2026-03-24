/**
 * Telegram MarkdownV2 formatter.
 *
 * Converts standard Markdown (from LLM output) into Telegram's MarkdownV2 format.
 * Also generates mermaid.ink URLs for Mermaid code blocks and handles message
 * splitting at paragraph boundaries to stay under Telegram's 4096-char limit.
 *
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */

const TELEGRAM_MAX_LENGTH = 4096;

// Characters that need escaping in MarkdownV2 outside of code/pre blocks
const SPECIAL_CHARS = /([_[\]()~`>#+\-=|{}.!\\])/g;

/** Escape text for MarkdownV2 (outside of code/pre blocks). */
export const escapeMarkdownV2 = (text: string): string => {
  return text.replace(SPECIAL_CHARS, "\\$1");
};

/**
 * Convert a Mermaid diagram source to a mermaid.ink image URL.
 * The diagram is base64-encoded and rendered as a PNG link.
 */
export const mermaidToInkUrl = (source: string): string => {
  const encoded = Buffer.from(source.trim()).toString("base64url");
  return `https://mermaid.ink/img/${encoded}`;
};

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 *
 * Strategy: split text into segments (code blocks vs prose), then convert each
 * segment independently so escaping rules don't conflict.
 */
export const toTelegramMarkdownV2 = (text: string): string => {
  // Split into fenced code blocks and everything else
  const segments = splitCodeBlocks(text);
  const converted = segments.map((seg) => {
    if (seg.type === "code") {
      // Mermaid code blocks → mermaid.ink link
      if (seg.lang === "mermaid") {
        const url = mermaidToInkUrl(seg.content);
        return `[Diagram](${escapeMarkdownV2(url)})`;
      }
      // Preserve code blocks verbatim in pre tags (escape \ before ` to prevent double-escaping)
      const escapedContent = seg.content.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
      if (seg.lang) {
        return `\`\`\`${seg.lang}\n${escapedContent}\n\`\`\``;
      }
      return `\`\`\`\n${escapedContent}\n\`\`\``;
    }
    return convertProse(seg.content);
  });
  return converted.join("\n");
};

type Segment =
  | { type: "prose"; content: string }
  | { type: "code"; lang: string; content: string };

/** Split text into fenced code blocks and prose segments. */
const splitCodeBlocks = (text: string): Segment[] => {
  const segments: Segment[] = [];
  // Match fenced code blocks: ```lang\n...\n```
  const codeBlockRe = /^```(\w*)\n([\s\S]*?)^```/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "prose", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", lang: match[1], content: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "prose", content: text.slice(lastIndex) });
  }

  return segments;
};

/** Convert prose (non-code) Markdown to MarkdownV2. */
const convertProse = (text: string): string => {
  // Process inline code first to protect it from further escaping
  const inlineCodeParts = splitInlineCode(text);
  return inlineCodeParts
    .map((part) => {
      if (part.type === "code") {
        // Inline code: wrap in backticks, escape backticks inside
        const escaped = part.content.replace(/`/g, "\\`").replace(/\\/g, "\\\\");
        return `\`${escaped}\``;
      }
      return convertProseText(part.content);
    })
    .join("");
};

type InlinePart = { type: "text" | "code"; content: string };

const splitInlineCode = (text: string): InlinePart[] => {
  const parts: InlinePart[] = [];
  const re = /`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "code", content: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", content: text.slice(lastIndex) });
  }
  return parts;
};

/** Convert prose text (no code) to MarkdownV2 with formatting. */
const convertProseText = (text: string): string => {
  // Use Unicode private-use sentinels as markers — these won't appear in normal
  // text and aren't in SPECIAL_CHARS, so escapeMarkdownV2 leaves them alone.
  const S = "\uE000"; // start marker
  const E = "\uE001"; // end marker
  const D = "\uE002"; // delimiter within markers

  // Convert formatting BEFORE escaping special chars
  // Order matters: bold+italic first, then bold, then italic, then strikethrough

  // Bold+italic: ***text*** → sentinel-wrapped
  let result = text.replace(/\*\*\*(.+?)\*\*\*/g, `${S}BOLDITALIC${D}$1${E}BOLDITALIC${D}`);
  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, `${S}BOLD${D}$1${E}BOLD${D}`);
  // Italic: *text* or _text_
  result = result.replace(/\*(.+?)\*/g, `${S}ITALIC${D}$1${E}ITALIC${D}`);
  result = result.replace(/(?<![\\])_(.+?)_/g, `${S}ITALIC${D}$1${E}ITALIC${D}`);
  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, `${S}STRIKE${D}$1${E}STRIKE${D}`);
  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${S}LINK${D}$1${S}LINKURL${D}$2${E}LINK${D}`);
  // Headers: ## text → bold (Telegram has no headers)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, `${S}BOLD${D}$1${E}BOLD${D}`);

  // Now escape everything (sentinels pass through untouched)
  result = escapeMarkdownV2(result);

  // Restore formatting markers
  result = result.replace(new RegExp(`${S}BOLDITALIC${D}`, "g"), "*_");
  result = result.replace(new RegExp(`${E}BOLDITALIC${D}`, "g"), "_*");
  result = result.replace(new RegExp(`${S}BOLD${D}`, "g"), "*");
  result = result.replace(new RegExp(`${E}BOLD${D}`, "g"), "*");
  result = result.replace(new RegExp(`${S}ITALIC${D}`, "g"), "_");
  result = result.replace(new RegExp(`${E}ITALIC${D}`, "g"), "_");
  result = result.replace(new RegExp(`${S}STRIKE${D}`, "g"), "~");
  result = result.replace(new RegExp(`${E}STRIKE${D}`, "g"), "~");
  result = result.replace(new RegExp(`${S}LINK${D}`, "g"), "[");
  result = result.replace(new RegExp(`${S}LINKURL${D}`, "g"), "](");
  result = result.replace(new RegExp(`${E}LINK${D}`, "g"), ")");

  // Unordered list bullets: - item → • item
  result = result.replace(/^\\- /gm, "• ");

  return result;
};

/**
 * Split a formatted message into chunks that fit within Telegram's limit.
 * Prefers splitting at paragraph boundaries (double newlines), then single
 * newlines, then hard-cuts as a last resort.
 */
export const splitTelegramMessage = (text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIdx > maxLength * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 2);
      continue;
    }

    // Try to split at a single newline
    splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx > maxLength * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
      continue;
    }

    // Hard cut
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  return chunks;
};
