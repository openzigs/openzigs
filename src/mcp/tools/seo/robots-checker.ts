/**
 * Robots.txt Parser & Meta Robots Checker (#852)
 *
 * Fetches and parses robots.txt to check URL access rules.
 * Also interprets meta robots and X-Robots-Tag directives.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
  sitemaps: string[];
  crawlDelay?: number;
}

export interface RobotsTxtResult {
  exists: boolean;
  rules: RobotsRule[];
  sitemaps: string[];
  raw: string;
}

export interface RobotsCheckResult {
  url: string;
  allowed: boolean;
  matchedRule?: string;
  userAgent: string;
}

// ── Parser ───────────────────────────────────────────────────────────────

/**
 * Parse raw robots.txt content into structured rules.
 */
export function parseRobotsTxt(raw: string): RobotsTxtResult {
  const rules: RobotsRule[] = [];
  const globalSitemaps: string[] = [];
  let current: RobotsRule | null = null;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === "user-agent") {
      if (
        current &&
        (current.allow.length > 0 || current.disallow.length > 0)
      ) {
        rules.push(current);
      }
      current = { userAgent: value, allow: [], disallow: [], sitemaps: [] };
    } else if (current) {
      switch (directive) {
        case "allow":
          if (value) current.allow.push(value);
          break;
        case "disallow":
          if (value) current.disallow.push(value);
          break;
        case "sitemap":
          if (value) {
            current.sitemaps.push(value);
            globalSitemaps.push(value);
          }
          break;
        case "crawl-delay": {
          const delay = parseFloat(value);
          if (Number.isFinite(delay)) current.crawlDelay = delay;
          break;
        }
      }
    } else if (directive === "sitemap" && value) {
      globalSitemaps.push(value);
    }
  }

  if (
    current &&
    (current.allow.length > 0 ||
      current.disallow.length > 0 ||
      current.sitemaps.length > 0)
  ) {
    rules.push(current);
  }

  return {
    exists: true,
    rules,
    sitemaps: [...new Set(globalSitemaps)],
    raw,
  };
}

/**
 * Convert a robots.txt path pattern to a regex.
 * Supports * (wildcard) and $ (end-of-URL anchor).
 */
export function robotsPatternToRegex(pattern: string): RegExp {
  let escaped = pattern
    .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  if (escaped.endsWith("\\$")) {
    escaped = escaped.slice(0, -2) + "$";
  }
  return new RegExp(`^${escaped}`);
}

/**
 * Check whether a URL path is allowed based on robots.txt rules.
 * Follows the Google robots.txt specification:
 *   - Most specific path match wins
 *   - Allow takes precedence over Disallow at equal specificity
 */
export function isUrlAllowed(
  urlPath: string,
  rules: RobotsRule[],
  userAgent = "Googlebot",
): RobotsCheckResult {
  const ua = userAgent.toLowerCase();
  const applicableRules = rules.filter(
    (r) => r.userAgent === "*" || r.userAgent.toLowerCase() === ua,
  );

  // Prefer specific user-agent rules over wildcard
  const specificRules = applicableRules.filter(
    (r) => r.userAgent.toLowerCase() === ua,
  );
  const ruleSets = specificRules.length > 0 ? specificRules : applicableRules;

  if (ruleSets.length === 0) {
    return { url: urlPath, allowed: true, userAgent };
  }

  let bestMatch = { length: -1, allowed: true, pattern: "" };

  for (const ruleSet of ruleSets) {
    for (const pattern of ruleSet.allow) {
      const regex = robotsPatternToRegex(pattern);
      if (regex.test(urlPath) && pattern.length > bestMatch.length) {
        bestMatch = { length: pattern.length, allowed: true, pattern };
      }
    }
    for (const pattern of ruleSet.disallow) {
      const regex = robotsPatternToRegex(pattern);
      if (regex.test(urlPath) && pattern.length > bestMatch.length) {
        bestMatch = { length: pattern.length, allowed: false, pattern };
      }
    }
  }

  if (bestMatch.length === -1) {
    return { url: urlPath, allowed: true, userAgent };
  }

  return {
    url: urlPath,
    allowed: bestMatch.allowed,
    matchedRule: bestMatch.pattern,
    userAgent,
  };
}

/**
 * Detect common issues in robots.txt rules.
 */
export interface RobotsIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
}

export function detectRobotsIssues(result: RobotsTxtResult): RobotsIssue[] {
  const issues: RobotsIssue[] = [];

  for (const rule of result.rules) {
    // Wildcard blocks everything
    if (rule.disallow.includes("/") && rule.allow.length === 0) {
      issues.push({
        severity: "warning",
        category: "robots",
        message: `robots.txt blocks all URLs for User-agent: ${rule.userAgent}`,
      });
    }

    // Blocks CSS/JS resources
    for (const path of rule.disallow) {
      if (
        /\.(css|js)(\?|$)/i.test(path) ||
        path.includes("/css") ||
        path.includes("/js")
      ) {
        issues.push({
          severity: "warning",
          category: "robots",
          message: `robots.txt blocks CSS/JS resources (${path}) for ${rule.userAgent} — may affect rendering`,
        });
      }
    }
  }

  return issues;
}

/**
 * Fetch robots.txt from a site root.
 * Returns a parsed result or a not-found result.
 */
export async function fetchRobotsTxt(
  siteUrl: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<RobotsTxtResult> {
  try {
    const origin = new URL(siteUrl).origin;
    const resp = await fetchFn(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return { exists: false, rules: [], sitemaps: [], raw: "" };
    }
    const raw = await resp.text();
    return parseRobotsTxt(raw);
  } catch {
    return { exists: false, rules: [], sitemaps: [], raw: "" };
  }
}
