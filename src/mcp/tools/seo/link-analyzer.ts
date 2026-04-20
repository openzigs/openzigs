/**
 * Advanced Link Analysis (#845)
 *
 * Extracts and analyzes all links from crawled pages:
 * - Broken links (4xx/5xx responses)
 * - Redirect chains (3+ hops)
 * - Redirect loops
 * - BFS traversal from homepage for link depth
 * - Orphan pages (0 incoming internal links)
 * - Link distribution per page
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface LinkRecord {
  sourceUrl: string;
  targetUrl: string;
  anchorText: string;
  isInternal: boolean;
  statusCode?: number;
}

export interface BrokenLink {
  sourceUrl: string;
  targetUrl: string;
  anchorText: string;
  statusCode: number;
}

export interface RedirectChain {
  startUrl: string;
  chain: string[];
  finalUrl: string;
  hops: number;
  isLoop: boolean;
}

export interface OrphanPage {
  url: string;
  hasOutgoingLinks: boolean;
}

export interface LinkDepthEntry {
  url: string;
  depth: number;
}

export interface LinkDistribution {
  url: string;
  incomingCount: number;
  outgoingCount: number;
}

export interface LinkAnalysisResult {
  totalLinks: number;
  internalLinks: number;
  externalLinks: number;
  brokenLinks: BrokenLink[];
  redirectChains: RedirectChain[];
  orphanPages: OrphanPage[];
  linkDepths: LinkDepthEntry[];
  linkDistribution: LinkDistribution[];
}

// ── Link extraction from crawled pages ───────────────────────────────────

export interface CrawledPageLinks {
  url: string;
  links: Array<{
    href: string;
    text: string;
    isInternal: boolean;
  }>;
  statusCode?: number;
}

/**
 * Analyze links across all crawled pages.
 */
export function analyzeLinks(
  pages: CrawledPageLinks[],
  siteUrl: string,
): LinkAnalysisResult {
  const allLinks: LinkRecord[] = [];
  const statusMap = new Map<string, number>();

  for (const page of pages) {
    if (page.statusCode) {
      statusMap.set(normalizeUrl(page.url), page.statusCode);
    }
    for (const link of page.links) {
      allLinks.push({
        sourceUrl: page.url,
        targetUrl: link.href,
        anchorText: link.text,
        isInternal: link.isInternal,
        statusCode: statusMap.get(normalizeUrl(link.href)),
      });
    }
  }

  // Broken links: internal links to pages that returned 4xx/5xx
  const brokenLinks = findBrokenLinks(allLinks, statusMap);

  // Redirect chains (simplified: detect from status codes)
  const redirectChains = findRedirectChains(allLinks, statusMap);

  // Link depth via BFS from homepage
  const linkDepths = computeLinkDepths(pages, siteUrl);

  // Incoming link counts
  const incomingCounts = new Map<string, number>();
  const outgoingCounts = new Map<string, number>();

  for (const page of pages) {
    const normalized = normalizeUrl(page.url);
    outgoingCounts.set(
      normalized,
      page.links.filter((l) => l.isInternal).length,
    );
  }

  for (const link of allLinks) {
    if (!link.isInternal) continue;
    const target = normalizeUrl(link.targetUrl);
    incomingCounts.set(target, (incomingCounts.get(target) ?? 0) + 1);
  }

  // Orphan pages: crawled pages with 0 incoming internal links
  const orphanPages: OrphanPage[] = [];
  const homepageNorm = normalizeUrl(siteUrl);
  for (const page of pages) {
    const norm = normalizeUrl(page.url);
    if (norm === homepageNorm) continue; // homepage is always root
    if ((incomingCounts.get(norm) ?? 0) === 0) {
      orphanPages.push({
        url: page.url,
        hasOutgoingLinks: (outgoingCounts.get(norm) ?? 0) > 0,
      });
    }
  }

  // Link distribution
  const linkDistribution: LinkDistribution[] = pages.map((page) => {
    const norm = normalizeUrl(page.url);
    return {
      url: page.url,
      incomingCount: incomingCounts.get(norm) ?? 0,
      outgoingCount: outgoingCounts.get(norm) ?? 0,
    };
  });

  return {
    totalLinks: allLinks.length,
    internalLinks: allLinks.filter((l) => l.isInternal).length,
    externalLinks: allLinks.filter((l) => !l.isInternal).length,
    brokenLinks,
    redirectChains,
    orphanPages,
    linkDepths,
    linkDistribution,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function findBrokenLinks(
  links: LinkRecord[],
  statusMap: Map<string, number>,
): BrokenLink[] {
  const seen = new Set<string>();
  const broken: BrokenLink[] = [];

  for (const link of links) {
    if (!link.isInternal) continue;
    const target = normalizeUrl(link.targetUrl);
    if (seen.has(`${link.sourceUrl}→${target}`)) continue;
    seen.add(`${link.sourceUrl}→${target}`);

    const status = statusMap.get(target);
    if (status && status >= 400) {
      broken.push({
        sourceUrl: link.sourceUrl,
        targetUrl: link.targetUrl,
        anchorText: link.anchorText,
        statusCode: status,
      });
    }
  }
  return broken;
}

function findRedirectChains(
  links: LinkRecord[],
  statusMap: Map<string, number>,
): RedirectChain[] {
  // Detect redirect chains from 3xx status codes
  const redirectMap = new Map<string, string>();
  const chains: RedirectChain[] = [];

  for (const link of links) {
    const status = statusMap.get(normalizeUrl(link.targetUrl));
    if (status && status >= 300 && status < 400) {
      redirectMap.set(
        normalizeUrl(link.sourceUrl),
        normalizeUrl(link.targetUrl),
      );
    }
  }

  const visited = new Set<string>();
  for (const [startUrl] of redirectMap) {
    if (visited.has(startUrl)) continue;

    const chain: string[] = [startUrl];
    const chainSet = new Set<string>([startUrl]);
    let current = startUrl;
    let isLoop = false;

    while (redirectMap.has(current)) {
      const next = redirectMap.get(current)!;
      if (chainSet.has(next)) {
        isLoop = true;
        chain.push(next);
        break;
      }
      chain.push(next);
      chainSet.add(next);
      current = next;
    }

    if (chain.length >= 3 || isLoop) {
      chains.push({
        startUrl,
        chain,
        finalUrl: chain[chain.length - 1],
        hops: chain.length - 1,
        isLoop,
      });
    }

    for (const url of chain) visited.add(url);
  }

  return chains;
}

/**
 * BFS traversal from homepage to compute link depth for every page.
 */
export function computeLinkDepths(
  pages: CrawledPageLinks[],
  siteUrl: string,
): LinkDepthEntry[] {
  const homepageNorm = normalizeUrl(siteUrl);
  const adjacency = new Map<string, Set<string>>();

  for (const page of pages) {
    const source = normalizeUrl(page.url);
    if (!adjacency.has(source)) adjacency.set(source, new Set());
    for (const link of page.links) {
      if (link.isInternal) {
        adjacency.get(source)!.add(normalizeUrl(link.href));
      }
    }
  }

  const depths = new Map<string, number>();
  depths.set(homepageNorm, 0);
  const queue = [homepageNorm];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depths.get(current)!;
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      if (!depths.has(neighbor)) {
        depths.set(neighbor, currentDepth + 1);
        queue.push(neighbor);
      }
    }
  }

  // Include unreachable pages at depth Infinity
  const allUrls = new Set(pages.map((p) => normalizeUrl(p.url)));
  const results: LinkDepthEntry[] = [];
  for (const url of allUrls) {
    const page = pages.find((p) => normalizeUrl(p.url) === url);
    results.push({
      url: page?.url ?? url,
      depth: depths.get(url) ?? Infinity,
    });
  }

  return results.sort((a, b) => a.depth - b.depth);
}

// ── Redirect Chain Following (#858) ──────────────────────────────────────

export interface FollowedRedirectChain {
  startUrl: string;
  chain: string[];
  finalUrl: string;
  finalStatus: number;
  hops: number;
  isLoop: boolean;
  hasMixedScheme: boolean;
}

export interface RedirectChainIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  url?: string;
}

/**
 * Follow redirect chains via HEAD requests, up to maxHops.
 * Returns the full chain and detected issues.
 */
export async function followRedirectChain(
  url: string,
  maxHops = 10,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ chain: FollowedRedirectChain; issues: RedirectChainIssue[] }> {
  const chain: string[] = [url];
  const visited = new Set<string>([url]);
  let current = url;
  let finalStatus = 0;
  let isLoop = false;
  let hasMixedScheme = false;
  const issues: RedirectChainIssue[] = [];

  for (let hop = 0; hop < maxHops; hop++) {
    try {
      const resp = await fetchFn(current, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      finalStatus = resp.status;

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) break;

        let nextUrl: string;
        try {
          nextUrl = new URL(location, current).href;
        } catch {
          break;
        }

        // Detect mixed HTTP/HTTPS
        try {
          const currentScheme = new URL(current).protocol;
          const nextScheme = new URL(nextUrl).protocol;
          if (currentScheme !== nextScheme) {
            hasMixedScheme = true;
          }
        } catch {
          // ignore
        }

        if (visited.has(nextUrl)) {
          isLoop = true;
          chain.push(nextUrl);
          break;
        }

        visited.add(nextUrl);
        chain.push(nextUrl);
        current = nextUrl;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  // Generate issues
  if (isLoop) {
    issues.push({
      severity: "error",
      category: "redirects",
      message: `Redirect loop detected: ${chain.join(" → ")}`,
      url,
    });
  }
  if (chain.length > 3) {
    issues.push({
      severity: "warning",
      category: "redirects",
      message: `Long redirect chain (${chain.length - 1} hops): ${chain[0]} → ${chain[chain.length - 1]}`,
      url,
    });
  }
  if (hasMixedScheme) {
    issues.push({
      severity: "warning",
      category: "redirects",
      message: `Mixed HTTP/HTTPS redirect chain starting from ${url}`,
      url,
    });
  }
  if (finalStatus >= 400) {
    issues.push({
      severity: "error",
      category: "redirects",
      message: `Redirect chain ends with HTTP ${finalStatus}: ${chain.join(" → ")}`,
      url,
    });
  }

  return {
    chain: {
      startUrl: url,
      chain,
      finalUrl: chain[chain.length - 1],
      finalStatus,
      hops: chain.length - 1,
      isLoop,
      hasMixedScheme,
    },
    issues,
  };
}
