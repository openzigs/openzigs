/**
 * Director Mode — Blog Content Extractor
 * Issue #319: Fetch a blog post URL and extract structured content
 * (text, images, metadata) for the Blog-to-YouTube pipeline.
 *
 * Security: URLs are validated against SSRF patterns (private IPs, loopback, etc.)
 */

import { logger } from "../../logging/logger.js";

// ── Types ────────────────────────────────────────────────────

export interface BlogImage {
  /** Fully resolved URL */
  url: string;
  /** Alt text from the <img> tag */
  alt: string;
}

export interface BlogMetadata {
  /** <title> or og:title */
  title: string;
  /** meta description or og:description */
  description: string;
  /** og:image URL */
  ogImage: string | null;
  /** Canonical URL */
  canonicalUrl: string | null;
  /** Site name from og:site_name */
  siteName: string | null;
  /** Author from meta[name=author] */
  author: string | null;
}

export interface ExtractedBlog {
  /** Cleaned plain-text body (paragraphs separated by \n\n) */
  text: string;
  /** Extracted images with alt text */
  images: BlogImage[];
  /** Page metadata */
  metadata: BlogMetadata;
  /** The final URL after redirects */
  resolvedUrl: string;
  /** Word count */
  wordCount: number;
}

// ── SSRF Protection ──────────────────────────────────────────

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "metadata.google.internal",
  "169.254.169.254",
]);

function isPrivateIp(hostname: string): boolean {
  // IPv4 private ranges
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  // Link-local
  if (/^169\.254\./.test(hostname)) return true;
  return false;
}

function validateUrl(urlStr: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only http/https URLs are allowed, got ${parsed.protocol}`);
  }

  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Blocked host: ${parsed.hostname}`);
  }

  if (isPrivateIp(parsed.hostname)) {
    throw new Error(`Private/internal IP addresses are not allowed: ${parsed.hostname}`);
  }

  return parsed;
}

// ── HTML Extraction Helpers ──────────────────────────────────

/** Extract content of a meta tag by name or property attribute. */
function extractMeta(html: string, attr: string): string | null {
  //  Match meta tags with name="attr" or property="attr"
  const pattern = new RegExp(
    `<meta\\s+[^>]*(?:name|property)\\s*=\\s*["']${attr}["'][^>]*content\\s*=\\s*["']([^"']*)["']` +
    `|<meta\\s+[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${attr}["']`,
    "i",
  );
  const m = pattern.exec(html);
  return m?.[1] ?? m?.[2] ?? null;
}

/** Extract the content within the first matching tag, e.g. <article>...</article>. */
function extractTagContent(html: string, tag: string): string | null {
  const openPattern = new RegExp(`<${tag}[^>]*>`, "i");
  const closePattern = new RegExp(`</${tag}>`, "i");

  const openMatch = openPattern.exec(html);
  if (!openMatch) return null;

  const startIndex = openMatch.index + openMatch[0].length;
  const closeMatch = closePattern.exec(html.slice(startIndex));
  if (!closeMatch) return null;

  return html.slice(startIndex, startIndex + closeMatch.index);
}

/** Extract text content from the <title> tag. */
function extractTitle(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m?.[1]?.trim() ?? "";
}

/** Extract all <img> tags with src and alt. */
function extractImages(html: string, baseUrl: string): BlogImage[] {
  const images: BlogImage[] = [];
  const imgRegex = /<img\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    if (!src) continue;

    // Skip tiny icons, tracking pixels, logos
    if (/1x1|pixel|tracking|logo|favicon|icon|badge|avatar/i.test(src)) continue;

    // Resolve relative URLs
    let fullUrl: string;
    try {
      fullUrl = new URL(src, baseUrl).href;
    } catch {
      continue;
    }

    // Extract alt text
    const altMatch = /alt\s*=\s*["']([^"']*)["']/i.exec(match[0]);
    const alt = altMatch?.[1]?.trim() ?? "";

    images.push({ url: fullUrl, alt });
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return images.filter((img) => {
    if (seen.has(img.url)) return false;
    seen.add(img.url);
    return true;
  });
}

/**
 * Convert a block of HTML to clean plain text.
 * Preserves paragraph structure by converting block elements to \n\n.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script, style, nav, footer, header, aside
  text = text.replace(/<(script|style|nav|footer|header|aside|noscript|iframe)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Handle headings — add newlines and keep text
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n$1\n\n");

  // Paragraph & div boundaries
  text = text.replace(/<\/?(p|div|section|article|blockquote|li|tr|br\s*\/?)[^>]*>/gi, "\n\n");

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "");

  // Normalize whitespace: collapse internal spaces per line, then collapse blank lines
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

// ── Main Extractor ───────────────────────────────────────────

/**
 * Fetch a blog post URL and extract its content.
 *
 * @param url - The blog post URL to fetch
 * @returns Extracted blog content with text, images, and metadata
 */
export async function extractBlog(url: string): Promise<ExtractedBlog> {
  const validated = validateUrl(url);

  logger.info(`[BlogExtractor] Fetching: ${validated.href}`);

  const response = await fetch(validated.href, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OpenZigs/1.0; +https://github.com/mgcronin/openzigs)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} for ${validated.href}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`Unexpected content type: ${contentType}. Expected HTML.`);
  }

  const html = await response.text();
  const resolvedUrl = response.url || validated.href;

  logger.info(`[BlogExtractor] Received ${html.length} chars from ${resolvedUrl}`);

  // ── Extract metadata ──
  const metadata: BlogMetadata = {
    title: extractMeta(html, "og:title") ?? extractTitle(html),
    description: extractMeta(html, "og:description") ?? extractMeta(html, "description") ?? "",
    ogImage: extractMeta(html, "og:image"),
    canonicalUrl: extractMeta(html, "og:url"),
    siteName: extractMeta(html, "og:site_name"),
    author: extractMeta(html, "author"),
  };

  // ── Extract main content ──
  // Attempt to find <article> first, then <main>, then <body>
  const articleHtml =
    extractTagContent(html, "article") ??
    extractTagContent(html, "main") ??
    extractTagContent(html, "body") ??
    html;

  const text = htmlToText(articleHtml);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // ── Extract images ──
  const images = extractImages(articleHtml, resolvedUrl);

  // Prepend og:image if present and not already in list
  if (metadata.ogImage) {
    try {
      const ogUrl = new URL(metadata.ogImage, resolvedUrl).href;
      if (!images.some((img) => img.url === ogUrl)) {
        images.unshift({ url: ogUrl, alt: metadata.title });
      }
    } catch {
      // Invalid og:image URL — skip
    }
  }

  logger.info(
    `[BlogExtractor] Extracted: "${metadata.title}" — ${wordCount} words, ${images.length} images`,
  );

  return {
    text,
    images,
    metadata,
    resolvedUrl,
    wordCount,
  };
}
