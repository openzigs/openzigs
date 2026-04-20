/**
 * Internal Linking Suggestions Engine (#881)
 *
 * Cross-references page content to suggest internal links.
 * Uses TF-IDF keyword matching to find related pages,
 * prioritizing orphan pages and deep pages (BFS depth > 3).
 */

import natural from "natural";

const TfIdf = natural.TfIdf;

// ── Types ────────────────────────────────────────────────────────────────

export interface LinkSuggestionPage {
  url: string;
  title: string;
  bodyText: string;
  incomingInternalLinks: number;
  depth: number;
}

export interface LinkSuggestion {
  sourcePage: string;
  targetPage: string;
  suggestedAnchor: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

// ── Linking Suggestion Engine ────────────────────────────────────────────

/**
 * Generate internal linking suggestions by cross-referencing TF-IDF keywords
 * across all audited pages. Prioritizes orphan pages and deep pages.
 */
export function generateLinkingSuggestions(
  pages: LinkSuggestionPage[],
): LinkSuggestion[] {
  if (pages.length < 2) return [];

  // Build TF-IDF index
  const tfidf = new TfIdf();
  for (const page of pages) {
    tfidf.addDocument(page.bodyText);
  }

  // Extract top keywords per page
  const pageKeywords: Map<number, string[]> = new Map();
  for (let i = 0; i < pages.length; i++) {
    const terms: Array<{ term: string; measure: number }> = [];
    tfidf.listTerms(i).forEach((item) => {
      if (item.term.length > 3) {
        terms.push({ term: item.term, measure: item.tfidf });
      }
    });
    terms.sort((a, b) => b.measure - a.measure);
    pageKeywords.set(
      i,
      terms.slice(0, 10).map((t) => t.term),
    );
  }

  const suggestions: LinkSuggestion[] = [];
  const seen = new Set<string>();

  for (let sourceIdx = 0; sourceIdx < pages.length; sourceIdx++) {
    const sourceKeywords = pageKeywords.get(sourceIdx) ?? [];
    if (sourceKeywords.length === 0) continue;

    for (let targetIdx = 0; targetIdx < pages.length; targetIdx++) {
      if (sourceIdx === targetIdx) continue;

      const pairKey = `${sourceIdx}→${targetIdx}`;
      if (seen.has(pairKey)) continue;

      const targetKeywords = pageKeywords.get(targetIdx) ?? [];
      const overlap = sourceKeywords.filter((kw) =>
        targetKeywords.includes(kw),
      );

      if (overlap.length === 0) continue;

      // Check if the source page already has content mentioning target keywords
      const sourceText = pages[sourceIdx].bodyText.toLowerCase();
      const matchingKeywords = overlap.filter((kw) =>
        sourceText.includes(kw.toLowerCase()),
      );

      if (matchingKeywords.length === 0) continue;

      const target = pages[targetIdx];
      const suggestedAnchor = target.title || matchingKeywords[0];

      // Determine priority
      const isOrphan = target.incomingInternalLinks === 0;
      const isDeep = target.depth > 3;
      let priority: LinkSuggestion["priority"] = "low";
      if (isOrphan) priority = "high";
      else if (isDeep) priority = "medium";
      else if (matchingKeywords.length >= 3) priority = "medium";

      // Build reason
      const reasons: string[] = [];
      if (isOrphan) reasons.push("orphan page (no incoming links)");
      if (isDeep) reasons.push(`deep page (depth ${target.depth})`);
      reasons.push(
        `${matchingKeywords.length} matching keyword(s): ${matchingKeywords.slice(0, 3).join(", ")}`,
      );

      seen.add(pairKey);
      suggestions.push({
        sourcePage: pages[sourceIdx].url,
        targetPage: target.url,
        suggestedAnchor,
        reason: reasons.join("; "),
        priority,
      });
    }
  }

  // Sort by priority (high → medium → low), then by number of matching keywords
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  suggestions.sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority],
  );

  return suggestions.slice(0, 50); // Cap at 50 suggestions
}
