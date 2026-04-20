/**
 * Competitive Discovery Pipeline (#867)
 *
 * Aggregates keywords from a site audit, searches SERP for each,
 * and produces a deduplicated, ranked list of competitor domains.
 */

import {
  discoverCompetitors,
  type CompetitorDiscoveryResult,
} from "./competitor-discovery.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface DiscoveredCompetitor {
  domain: string;
  url: string;
  title: string;
  snippet: string;
  bestPosition: number;
  keywordsFound: string[];
  frequencyScore: number;
}

export interface DiscoveryResult {
  targetDomain: string;
  keywordsSearched: string[];
  competitors: DiscoveredCompetitor[];
  serpFeatures: { paa: string[]; relatedSearches: string[] };
  requiresApiKey: boolean;
}

export interface AuditPageInput {
  url: string;
  keywords?: Array<{ word: string; score: number }>;
}

// ── Keyword aggregation ──────────────────────────────────────────────────

/**
 * Sum TF-IDF scores for each unique keyword across all pages,
 * then return the top N by aggregate score.
 */
export function aggregateKeywords(
  pages: AuditPageInput[],
  maxKeywords: number,
): Array<{ word: string; score: number }> {
  const scores = new Map<string, number>();

  for (const page of pages) {
    if (!page.keywords) continue;
    for (const kw of page.keywords) {
      const normalized = kw.word.toLowerCase().trim();
      if (!normalized) continue;
      scores.set(normalized, (scores.get(normalized) ?? 0) + kw.score);
    }
  }

  return [...scores.entries()]
    .map(([word, score]) => ({ word, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxKeywords);
}

// ── Main pipeline ────────────────────────────────────────────────────────

export async function discoverCompetitorsFromAudit(
  auditPages: AuditPageInput[],
  targetDomain: string,
  options?: { maxKeywords?: number; maxCompetitors?: number },
): Promise<DiscoveryResult> {
  const maxKeywords = Math.min(options?.maxKeywords ?? 10, 10);
  const maxCompetitors = options?.maxCompetitors ?? 10;

  const serperApiKey = process.env.SERPER_API_KEY;
  const braveApiKey = process.env.BRAVE_API_KEY;
  const requiresApiKey = !serperApiKey && !braveApiKey;

  if (requiresApiKey) {
    const topKw = aggregateKeywords(auditPages, maxKeywords);
    return {
      targetDomain,
      keywordsSearched: topKw.map((k) => k.word),
      competitors: [],
      serpFeatures: { paa: [], relatedSearches: [] },
      requiresApiKey: true,
    };
  }

  const topKeywords = aggregateKeywords(auditPages, maxKeywords);
  if (topKeywords.length === 0) {
    return {
      targetDomain,
      keywordsSearched: [],
      competitors: [],
      serpFeatures: { paa: [], relatedSearches: [] },
      requiresApiKey: false,
    };
  }

  // Search SERP for each keyword
  const allPaa: string[] = [];
  const allRelated: string[] = [];
  const domainMap = new Map<
    string,
    {
      url: string;
      title: string;
      snippet: string;
      bestPosition: number;
      keywordsFound: Set<string>;
    }
  >();

  for (const kw of topKeywords) {
    let result: CompetitorDiscoveryResult;
    try {
      result = await discoverCompetitors(kw.word, {
        serperApiKey,
        braveApiKey,
        targetDomain,
      });
    } catch {
      continue;
    }

    allPaa.push(...result.serpFeatures.paa);
    allRelated.push(...result.serpFeatures.relatedSearches);

    for (const organic of result.organic) {
      let domain: string;
      try {
        domain = new URL(organic.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }

      const existing = domainMap.get(domain);
      if (existing) {
        existing.keywordsFound.add(kw.word);
        if (organic.position < existing.bestPosition) {
          existing.bestPosition = organic.position;
          existing.url = organic.url;
          existing.title = organic.title;
          existing.snippet = organic.snippet;
        }
      } else {
        domainMap.set(domain, {
          url: organic.url,
          title: organic.title,
          snippet: organic.snippet,
          bestPosition: organic.position,
          keywordsFound: new Set([kw.word]),
        });
      }
    }
  }

  // Build sorted competitor list
  const competitors: DiscoveredCompetitor[] = [...domainMap.entries()]
    .map(([domain, data]) => ({
      domain,
      url: data.url,
      title: data.title,
      snippet: data.snippet,
      bestPosition: data.bestPosition,
      keywordsFound: [...data.keywordsFound],
      frequencyScore: data.keywordsFound.size,
    }))
    .sort((a, b) => {
      if (b.frequencyScore !== a.frequencyScore)
        return b.frequencyScore - a.frequencyScore;
      return a.bestPosition - b.bestPosition;
    })
    .slice(0, maxCompetitors);

  return {
    targetDomain,
    keywordsSearched: topKeywords.map((k) => k.word),
    competitors,
    serpFeatures: {
      paa: [...new Set(allPaa)],
      relatedSearches: [...new Set(allRelated)],
    },
    requiresApiKey: false,
  };
}
