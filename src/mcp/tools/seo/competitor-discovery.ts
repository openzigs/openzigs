export type OrganicResult = {
  url: string;
  title: string;
  snippet: string;
  position: number;
};

export type SerpFeatures = {
  paa: string[];
  relatedSearches: string[];
  featuredSnippet?: string;
};

export type CompetitorDiscoveryResult = {
  organic: OrganicResult[];
  serpFeatures: SerpFeatures;
  provider: "serper" | "brave";
};

/**
 * Discover top competitors for a keyword using Serper.dev or Brave Search.
 * Serper is primary; Brave is the fallback when Serper key is unavailable.
 */
export async function discoverCompetitors(
  keyword: string,
  opts: { serperApiKey?: string; braveApiKey?: string },
): Promise<CompetitorDiscoveryResult> {
  if (opts.serperApiKey) {
    try {
      return await serperSearch(keyword, opts.serperApiKey);
    } catch {
      // Fall through to Brave
    }
  }

  if (opts.braveApiKey) {
    return braveSearch(keyword, opts.braveApiKey);
  }

  throw new Error("No search API key configured. Set SERPER_API_KEY or BRAVE_API_KEY.");
}

async function serperSearch(keyword: string, apiKey: string): Promise<CompetitorDiscoveryResult> {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: keyword, num: 5 }),
  });

  if (!resp.ok) {
    throw new Error(`Serper API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as SerperResponse;

  const organic: OrganicResult[] = (data.organic ?? []).slice(0, 5).map((r, i) => ({
    url: r.link,
    title: r.title,
    snippet: r.snippet ?? "",
    position: r.position ?? i + 1,
  }));

  const paa = (data.peopleAlsoAsk ?? []).map((q) => q.question);
  const relatedSearches = (data.relatedSearches ?? []).map((r) => r.query);
  const featuredSnippet = data.answerBox?.snippet ?? data.answerBox?.answer ?? undefined;

  return {
    organic,
    serpFeatures: { paa, relatedSearches, featuredSnippet },
    provider: "serper",
  };
}

async function braveSearch(keyword: string, apiKey: string): Promise<CompetitorDiscoveryResult> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(keyword)}&count=5`;

  const resp = await fetch(url, {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });

  if (!resp.ok) {
    throw new Error(`Brave Search API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as BraveSearchResponse;

  const organic: OrganicResult[] = (data.web?.results ?? []).slice(0, 5).map((r, i) => ({
    url: r.url,
    title: r.title,
    snippet: r.description ?? "",
    position: i + 1,
  }));

  return {
    organic,
    serpFeatures: { paa: [], relatedSearches: [], featuredSnippet: undefined },
    provider: "brave",
  };
}

// ── Serper response types ────────────────────────
type SerperResponse = {
  organic?: { link: string; title: string; snippet?: string; position?: number }[];
  peopleAlsoAsk?: { question: string }[];
  relatedSearches?: { query: string }[];
  answerBox?: { snippet?: string; answer?: string };
};

// ── Brave Search response types ──────────────────
type BraveSearchResponse = {
  web?: {
    results?: { url: string; title: string; description?: string }[];
  };
};
