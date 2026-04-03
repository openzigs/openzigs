import * as cheerio from "cheerio";
import natural from "natural";

const TfIdf = natural.TfIdf;

export type Heading = {
  level: number;
  text: string;
};

export type KeywordEntry = {
  term: string;
  tfidf: number;
};

export type MetaTag = { name: string; content: string };
export type ImageInfo = {
  src: string;
  alt: string;
  hasAlt: boolean;
  altStatus: "present" | "empty" | "missing";
  isAriaHidden: boolean;
  isLazyLoaded: boolean;
};
export type SchemaMarkup = { type: string; properties: string[] };
export type LinkInfo = { href: string; text: string; isInternal: boolean };

export type ExtractedContent = {
  title: string;
  headings: Heading[];
  bodyText: string;
  wordCount: number;
  headingCount: number;
  paragraphCount: number;
  readingTime: number;
  keywords: KeywordEntry[];
  readabilityScore: number;
  metaTitle: string;
  metaDescription: string;
  metaTags: MetaTag[];
  images: ImageInfo[];
  imagesWithoutAlt: number;
  imagesMissingAlt: number;
  imagesEmptyAlt: number;
  imagesAriaHidden: number;
  imagesLazyLoaded: number;
  schemaMarkup: SchemaMarkup[];
  internalLinks: LinkInfo[];
  externalLinks: LinkInfo[];
  internalLinkCount: number;
  externalLinkCount: number;
};

/** Selectors for elements that are navigation/chrome, not article content. */
const NOISE_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  ".sidebar",
  ".nav",
  ".footer",
  ".header",
  ".menu",
  ".breadcrumb",
  ".advertisement",
  ".ad",
  ".cookie-banner",
  ".popup",
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
];

/**
 * Flesch-Kincaid Reading Ease score.
 * Higher = easier to read (60–70 is standard).
 */
export function fleschKincaid(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const syllables = words.reduce((acc, w) => acc + countSyllables(w), 0);

  if (sentences.length === 0 || words.length === 0) return 0;

  const avgSentenceLen = words.length / sentences.length;
  const avgSyllablesPerWord = syllables / words.length;

  return (
    Math.round(
      (206.835 - 1.015 * avgSentenceLen - 84.6 * avgSyllablesPerWord) * 10,
    ) / 10
  );
}

/** Approximate syllable count for an English word. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  let count =
    w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").match(/[aeiouy]{1,2}/g)
      ?.length ?? 0;
  if (count === 0) count = 1;
  return count;
}

const MAX_JSONLD_DEPTH = 5;

/**
 * Recursively extract all `@type` entries from a JSON-LD object.
 * Handles `@graph` arrays (Yoast/WordPress pattern) and nested typed
 * entities like `publisher`, `mainEntity`, etc.
 */
export function extractJsonLdTypes(
  obj: unknown,
  out: SchemaMarkup[],
  depth = 0,
): void {
  if (depth > MAX_JSONLD_DEPTH || obj == null || typeof obj !== "object")
    return;
  if (Array.isArray(obj)) {
    for (const entry of obj) {
      extractJsonLdTypes(entry, out, depth + 1);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Handle @graph wrapper
  if (Array.isArray(record["@graph"])) {
    for (const entry of record["@graph"]) {
      extractJsonLdTypes(entry, out, depth + 1);
    }
  }

  // Extract this node's @type
  const type = record["@type"];
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    for (const t of types) {
      if (typeof t === "string") {
        const properties = Object.keys(record).filter(
          (k) => !k.startsWith("@"),
        );
        out.push({ type: t, properties });
      }
    }
  }

  // Recurse into nested typed objects (publisher, mainEntity, etc.)
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("@")) continue;
    if (value != null && typeof value === "object") {
      extractJsonLdTypes(value, out, depth + 1);
    }
  }
}

/**
 * Extract structured content from raw HTML.
 * Strips navigation/footer/sidebar noise, extracts headings, body text,
 * and computes metrics.
 */
export function extractContent(
  html: string,
  sourceUrl?: string,
): ExtractedContent {
  const $ = cheerio.load(html);

  // ── Pre-noise-removal extraction (meta, schema, images, links) ─────

  // Meta title from <title> tag
  const metaTitle = $("title").first().text().trim();

  // Meta description
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ?? "";

  // All meta tags with name+content
  const metaTags: MetaTag[] = [];
  $("meta[name][content]").each((_i, el) => {
    const name = $(el).attr("name")?.trim() ?? "";
    const content = $(el).attr("content")?.trim() ?? "";
    if (name && content) {
      metaTags.push({ name, content });
    }
  });

  // Schema markup (JSON-LD)
  const schemaMarkup: SchemaMarkup[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        extractJsonLdTypes(item, schemaMarkup);
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  });

  // Images
  const images: ImageInfo[] = [];
  $("img").each((_i, el) => {
    const src = $(el).attr("src")?.trim() ?? "";
    const rawAlt = $(el).attr("alt");
    const alt = rawAlt?.trim() ?? "";
    const altStatus: ImageInfo["altStatus"] =
      rawAlt === undefined ? "missing" : alt.length > 0 ? "present" : "empty";
    const hasAlt = altStatus === "present";
    const isAriaHidden = $(el).attr("aria-hidden") === "true";
    const isLazyLoaded =
      $(el).attr("data-src") !== undefined ||
      $(el).attr("data-srcset") !== undefined;
    if (src) {
      images.push({ src, alt, hasAlt, altStatus, isAriaHidden, isLazyLoaded });
    }
  });
  const imagesWithoutAlt = images.filter((img) => !img.hasAlt).length;
  const imagesMissingAlt = images.filter(
    (img) => img.altStatus === "missing",
  ).length;
  const imagesEmptyAlt = images.filter(
    (img) => img.altStatus === "empty",
  ).length;
  const imagesAriaHidden = images.filter((img) => img.isAriaHidden).length;
  const imagesLazyLoaded = images.filter((img) => img.isLazyLoaded).length;

  // Links — classify as internal vs external
  let sourceHostname: string | undefined;
  if (sourceUrl) {
    try {
      sourceHostname = new URL(sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      // Invalid sourceUrl — all links will be classified as external
    }
  }
  const internalLinks: LinkInfo[] = [];
  const externalLinks: LinkInfo[] = [];
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href")?.trim() ?? "";
    const text = $(el).text().trim();
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("data:") ||
      href.startsWith("vbscript:")
    )
      return;
    let isInternal = false;
    if (sourceHostname) {
      try {
        const linkHost = new URL(href, sourceUrl).hostname.replace(
          /^www\./,
          "",
        );
        isInternal = linkHost === sourceHostname;
      } catch {
        // relative urls are internal
        isInternal = !href.startsWith("http");
      }
    }
    const info: LinkInfo = { href, text, isInternal };
    if (isInternal) {
      internalLinks.push(info);
    } else {
      externalLinks.push(info);
    }
  });

  // ── Noise removal ──────────────────────────────────────────────────

  // Remove noise elements
  for (const sel of NOISE_SELECTORS) {
    $(sel).remove();
  }

  // Extract title
  const title = $("h1").first().text().trim() || $("title").text().trim() || "";

  // Extract headings
  const headings: Heading[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_i, el) => {
    const tagName = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const level = parseInt(tagName.replace("h", ""), 10);
    const text = $(el).text().trim();
    if (text && !isNaN(level)) {
      headings.push({ level, text });
    }
  });

  // Extract body text from paragraphs and list items
  const textBlocks: string[] = [];
  $("p, li, td, blockquote").each((_i, el) => {
    const text = $(el).text().trim();
    if (text.length > 10) {
      textBlocks.push(text);
    }
  });

  // Cheerio's .text() already decodes HTML entities — no entity re-decoding needed.
  const bodyText = textBlocks.join("\n\n").replace(/\s+/g, " ").trim();

  // Compute metrics
  const words = bodyText.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const headingCount = headings.length;
  const paragraphCount = textBlocks.length;
  const readingTime = Math.max(1, Math.round(wordCount / 238)); // avg reading speed

  // TF-IDF keyword extraction
  const keywords = extractKeywords(bodyText);

  // Readability
  const readabilityScore = fleschKincaid(bodyText);

  return {
    title,
    headings,
    bodyText,
    wordCount,
    headingCount,
    paragraphCount,
    readingTime,
    keywords,
    readabilityScore,
    metaTitle,
    metaDescription,
    metaTags,
    images,
    imagesWithoutAlt,
    imagesMissingAlt,
    imagesEmptyAlt,
    imagesAriaHidden,
    imagesLazyLoaded,
    schemaMarkup,
    internalLinks,
    externalLinks,
    internalLinkCount: internalLinks.length,
    externalLinkCount: externalLinks.length,
  };
}

/** Clean extracted text: collapse whitespace, strip stray HTML entities. */
export function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract top keywords using TF-IDF. */
export function extractKeywords(text: string, topN = 15): KeywordEntry[] {
  const tfidf = new TfIdf();
  tfidf.addDocument(text);

  const terms: KeywordEntry[] = [];
  tfidf.listTerms(0).forEach((item) => {
    // Skip very short terms and stopwords
    if (item.term.length >= 3) {
      terms.push({
        term: item.term,
        tfidf: Math.round(item.tfidf * 1000) / 1000,
      });
    }
  });

  return terms.slice(0, topN);
}
