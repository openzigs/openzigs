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
};

/** Selectors for elements that are navigation/chrome, not article content. */
const NOISE_SELECTORS = [
  "nav", "header", "footer", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  ".sidebar", ".nav", ".footer", ".header", ".menu", ".breadcrumb",
  ".advertisement", ".ad", ".cookie-banner", ".popup",
  "script", "style", "noscript", "iframe", "svg",
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

  return Math.round(
    (206.835 - 1.015 * avgSentenceLen - 84.6 * avgSyllablesPerWord) * 10,
  ) / 10;
}

/** Approximate syllable count for an English word. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  let count = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .match(/[aeiouy]{1,2}/g)?.length ?? 0;
  if (count === 0) count = 1;
  return count;
}

/**
 * Extract structured content from raw HTML.
 * Strips navigation/footer/sidebar noise, extracts headings, body text,
 * and computes metrics.
 */
export function extractContent(html: string): ExtractedContent {
  const $ = cheerio.load(html);

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

  const bodyText = cleanText(textBlocks.join("\n\n"));

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
  };
}

/** Clean extracted text: collapse whitespace, strip stray HTML entities. */
export function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
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
      terms.push({ term: item.term, tfidf: Math.round(item.tfidf * 1000) / 1000 });
    }
  });

  return terms.slice(0, topN);
}
