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

// ── Non-content domain blocklist ─────────────────────────────────────────

const NON_CONTENT_DOMAINS = new Set([
  "amazon.com", "walmart.com", "target.com", "ebay.com", "etsy.com",
  "aliexpress.com", "alibaba.com", "bestbuy.com", "homedepot.com", "lowes.com",
  "wayfair.com", "overstock.com", "costco.com", "samsclub.com", "kohls.com",
  "pinterest.com", "youtube.com", "facebook.com", "instagram.com", "twitter.com",
  "x.com", "tiktok.com", "reddit.com", "linkedin.com", "tumblr.com",
  "quora.com", "medium.com", "wikipedia.org", "wikihow.com",
  "yelp.com", "tripadvisor.com", "glassdoor.com",
]);

function isContentCompetitor(url: string, targetDomain: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (hostname === targetDomain) return false;
    if (NON_CONTENT_DOMAINS.has(hostname)) return false;
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.includes("/dp/") || pathname.includes("/product/") || pathname.includes("/shop/")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover top competitors for a keyword using Serper.dev or Brave Search.
 * Serper is primary; Brave is the fallback when Serper key is unavailable.
 */
export async function discoverCompetitors(
  keyword: string,
  opts: { serperApiKey?: string; braveApiKey?: string; targetDomain?: string },
): Promise<CompetitorDiscoveryResult> {
  if (opts.serperApiKey) {
    try {
      const result = await serperSearch(keyword, opts.serperApiKey);
      return filterResult(result, opts.targetDomain);
    } catch {
      // Fall through to Brave
    }
  }

  if (opts.braveApiKey) {
    const result = await braveSearch(keyword, opts.braveApiKey);
    return filterResult(result, opts.targetDomain);
  }

  throw new Error("No search API key configured. Set SERPER_API_KEY or BRAVE_API_KEY.");
}

function filterResult(
  result: CompetitorDiscoveryResult,
  targetDomain?: string,
): CompetitorDiscoveryResult {
  if (!targetDomain) return result;
  const domain = targetDomain.replace(/^www\./, "");
  return {
    ...result,
    organic: result.organic
      .filter((r) => isContentCompetitor(r.url, domain))
      .slice(0, 5),
  };
}

async function serperSearch(keyword: string, apiKey: string): Promise<CompetitorDiscoveryResult> {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: keyword, num: 10 }),
  });

  if (!resp.ok) {
    throw new Error(`Serper API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as SerperResponse;

  const organic: OrganicResult[] = (data.organic ?? []).slice(0, 10).map((r, i) => ({
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
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(keyword)}&count=10`;

  const resp = await fetch(url, {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });

  if (!resp.ok) {
    throw new Error(`Brave Search API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as BraveSearchResponse;

  const organic: OrganicResult[] = (data.web?.results ?? []).slice(0, 10).map((r, i) => ({
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
