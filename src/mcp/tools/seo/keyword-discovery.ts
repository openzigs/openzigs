import type { ExtractedContent } from "./html-extractor.js";

export type KeywordCandidate = {
  keyword: string;
  score: number;
  source: string;
  intent: "informational" | "transactional" | "navigational" | "commercial";
};

export type KeywordDiscoveryResult = {
  keyword: string;
  alternatives: string[];
  intent: string;
};

// ── Intent classification ────────────────────────────────────────────────

const TRANSACTIONAL_SIGNALS = [
  "buy",
  "price",
  "pricing",
  "cost",
  "cheap",
  "deal",
  "discount",
  "order",
  "purchase",
  "shop",
  "store",
  "coupon",
  "sale",
  "free trial",
];

const COMMERCIAL_SIGNALS = [
  "best",
  "top",
  "review",
  "comparison",
  "vs",
  "versus",
  "alternative",
  "recommend",
  "rated",
  "ranking",
  "benchmark",
];

const NAVIGATIONAL_SIGNALS = [
  "login",
  "sign in",
  "dashboard",
  "account",
  "download",
  "install",
  "official",
  "support",
  "contact",
  "docs",
  "documentation",
];

function classifyIntent(text: string): KeywordCandidate["intent"] {
  const lower = text.toLowerCase();
  if (TRANSACTIONAL_SIGNALS.some((s) => lower.includes(s)))
    return "transactional";
  if (COMMERCIAL_SIGNALS.some((s) => lower.includes(s))) return "commercial";
  if (NAVIGATIONAL_SIGNALS.some((s) => lower.includes(s)))
    return "navigational";
  return "informational";
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Extract meaningful phrases from the URL slug. */
function extractSlugKeywords(url: string): string[] {
  try {
    const { pathname } = new URL(url);
    const slug =
      pathname
        .replace(/\.[^/.]+$/, "") // strip file extension
        .replace(/^\/|\/$/g, "") // strip leading/trailing slashes
        .split("/")
        .pop() ?? "";

    if (!slug || slug.length < 3) return [];

    return [slug.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim()];
  } catch {
    return [];
  }
}

/** Remove common stop-word prefixes/suffixes from a phrase to normalize it. */
function cleanPhrase(phrase: string): string {
  const STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "and",
    "or",
    "but",
    "not",
    "no",
    "into",
    "as",
    "its",
    "it",
    "this",
    "that",
    "these",
    "those",
    "my",
    "your",
    "our",
    "their",
    "how",
    "what",
    "why",
    "when",
    "where",
    "which",
    "who",
  ]);

  const words = phrase.toLowerCase().trim().split(/\s+/);
  // Strip leading stop words
  while (words.length > 1 && STOP_WORDS.has(words[0])) words.shift();
  // Strip trailing stop words
  while (words.length > 1 && STOP_WORDS.has(words[words.length - 1]))
    words.pop();

  return words.join(" ");
}

/** Score and rank candidates, dedup by normalized form. */
function rankCandidates(candidates: KeywordCandidate[]): KeywordCandidate[] {
  const seen = new Map<string, KeywordCandidate>();

  for (const c of candidates) {
    const key = c.keyword.toLowerCase();
    const existing = seen.get(key);
    if (!existing || c.score > existing.score) {
      seen.set(key, c);
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}

// ── Main discovery function ─────────────────────────────────────────────

/**
 * Auto-detect the primary target keyword from extracted page content.
 *
 * Uses a multi-signal heuristic:
 * 1. Title/H1 text (highest authority)
 * 2. TF-IDF top keywords from body content
 * 3. URL slug phrases
 *
 * Returns the top keyword with alternatives and inferred search intent.
 */
export function discoverKeyword(
  content: ExtractedContent,
  url: string,
): KeywordDiscoveryResult | null {
  const candidates: KeywordCandidate[] = [];

  // Signal 1: Title / H1 — highest weight
  const h1 = content.headings.find((h) => h.level === 1);
  const titleText = h1?.text ?? content.title;

  if (titleText && titleText.length >= 3) {
    const cleaned = cleanPhrase(titleText);
    if (cleaned.length >= 3) {
      candidates.push({
        keyword: cleaned,
        score: 100,
        source: "title/h1",
        intent: classifyIntent(cleaned),
      });

      // Also extract shorter sub-phrases from the title (2–4 word windows)
      const words = cleaned.split(/\s+/);
      if (words.length > 4) {
        for (let size = 3; size <= Math.min(4, words.length - 1); size++) {
          for (let i = 0; i <= words.length - size; i++) {
            const subPhrase = words.slice(i, i + size).join(" ");
            candidates.push({
              keyword: subPhrase,
              score: 60 - (words.length - size) * 5,
              source: "title-phrase",
              intent: classifyIntent(subPhrase),
            });
          }
        }
      }
    }
  }

  // Signal 2: TF-IDF keywords — combine into 2–3 word phrases
  const topTerms = content.keywords.slice(0, 8);
  for (let i = 0; i < topTerms.length; i++) {
    const term = topTerms[i];
    // Single terms get moderate score
    candidates.push({
      keyword: term.term,
      score: 40 + term.tfidf * 10,
      source: "tfidf",
      intent: classifyIntent(term.term),
    });

    // Bigrams from adjacent TF-IDF terms
    if (i < topTerms.length - 1) {
      const bigram = `${term.term} ${topTerms[i + 1].term}`;
      candidates.push({
        keyword: bigram,
        score: 50 + (term.tfidf + topTerms[i + 1].tfidf) * 5,
        source: "tfidf-bigram",
        intent: classifyIntent(bigram),
      });
    }
  }

  // Signal 3: URL slug
  const slugKeywords = extractSlugKeywords(url);
  for (const slug of slugKeywords) {
    if (slug.length >= 3) {
      candidates.push({
        keyword: slug,
        score: 70,
        source: "url-slug",
        intent: classifyIntent(slug),
      });
    }
  }

  // Boost candidates that appear in both title and body
  for (const c of candidates) {
    const lower = c.keyword.toLowerCase();
    const bodyLower = content.bodyText.toLowerCase();
    const occurrences = bodyLower.split(lower).length - 1;
    if (occurrences >= 2) {
      c.score += Math.min(occurrences * 3, 15); // cap bonus at 15
    }
  }

  const ranked = rankCandidates(candidates);

  if (ranked.length === 0) return null;

  // Prefer multi-word phrases over single terms for SEO relevance
  const multiWord = ranked.filter((c) => c.keyword.split(/\s+/).length >= 2);
  const best = multiWord.length > 0 ? multiWord[0] : ranked[0];

  const alternatives = ranked
    .filter((c) => c.keyword !== best.keyword)
    .slice(0, 2)
    .map((c) => c.keyword);

  return {
    keyword: best.keyword,
    alternatives,
    intent: best.intent,
  };
}
