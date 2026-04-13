import { describe, it, expect, vi } from "vitest";
import {
  parseRobotsTxt,
  robotsPatternToRegex,
  isUrlAllowed,
  detectRobotsIssues,
  fetchRobotsTxt,
  type RobotsRule,
} from "./robots-checker.js";

// ── parseRobotsTxt ───────────────────────────────────────────────────────

describe("parseRobotsTxt", () => {
  it("parses standard user-agent blocks", () => {
    const raw = `
User-agent: Googlebot
Disallow: /private/
Allow: /private/public/

User-agent: *
Disallow: /admin/
`;
    const result = parseRobotsTxt(raw);
    expect(result.exists).toBe(true);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0].userAgent).toBe("Googlebot");
    expect(result.rules[0].disallow).toEqual(["/private/"]);
    expect(result.rules[0].allow).toEqual(["/private/public/"]);
    expect(result.rules[1].userAgent).toBe("*");
    expect(result.rules[1].disallow).toEqual(["/admin/"]);
  });

  it("parses sitemaps at top level and in user-agent blocks", () => {
    const raw = `
Sitemap: https://example.com/sitemap.xml

User-agent: *
Disallow: /tmp/
Sitemap: https://example.com/sitemap2.xml
`;
    const result = parseRobotsTxt(raw);
    expect(result.sitemaps).toContain("https://example.com/sitemap.xml");
    expect(result.sitemaps).toContain("https://example.com/sitemap2.xml");
    expect(result.sitemaps).toHaveLength(2);
  });

  it("deduplicates sitemaps", () => {
    const raw = `
Sitemap: https://example.com/sitemap.xml
User-agent: *
Disallow: /
Sitemap: https://example.com/sitemap.xml
`;
    const result = parseRobotsTxt(raw);
    expect(result.sitemaps).toHaveLength(1);
  });

  it("parses crawl-delay", () => {
    const raw = `
User-agent: *
Crawl-delay: 10
Disallow: /
`;
    const result = parseRobotsTxt(raw);
    expect(result.rules[0].crawlDelay).toBe(10);
  });

  it("ignores comments and blank lines", () => {
    const raw = `
# This is a comment
User-agent: *
Disallow: /secret/ # inline comment
`;
    const result = parseRobotsTxt(raw);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].disallow).toEqual(["/secret/"]);
  });

  it("skips empty disallow values", () => {
    const raw = `
User-agent: *
Disallow:
Allow: /
`;
    const result = parseRobotsTxt(raw);
    expect(result.rules[0].disallow).toEqual([]);
    expect(result.rules[0].allow).toEqual(["/"]);
  });

  it("handles malformed lines without colon", () => {
    const raw = `
User-agent: *
This is not a directive
Disallow: /test/
`;
    const result = parseRobotsTxt(raw);
    expect(result.rules[0].disallow).toEqual(["/test/"]);
  });
});

// ── robotsPatternToRegex ─────────────────────────────────────────────────

describe("robotsPatternToRegex", () => {
  it("converts wildcard * to regex .*", () => {
    const re = robotsPatternToRegex("/foo/*.html");
    expect(re.test("/foo/bar.html")).toBe(true);
    expect(re.test("/foo/baz.html")).toBe(true);
    expect(re.test("/baz/bar.html")).toBe(false);
  });

  it("anchors $ at end of pattern", () => {
    const re = robotsPatternToRegex("/exact$");
    expect(re.test("/exact")).toBe(true);
    expect(re.test("/exact/more")).toBe(false);
  });

  it("escapes regex special characters", () => {
    const re = robotsPatternToRegex("/path/with.dots");
    expect(re.test("/path/with.dots")).toBe(true);
    expect(re.test("/path/withXdots")).toBe(false);
  });

  it("matches path prefix by default", () => {
    const re = robotsPatternToRegex("/admin/");
    expect(re.test("/admin/")).toBe(true);
    expect(re.test("/admin/settings")).toBe(true);
    expect(re.test("/other/admin/")).toBe(false);
  });
});

// ── isUrlAllowed ─────────────────────────────────────────────────────────

describe("isUrlAllowed", () => {
  const rules: RobotsRule[] = [
    {
      userAgent: "*",
      allow: ["/public/"],
      disallow: ["/private/", "/tmp/"],
      sitemaps: [],
    },
  ];

  it("allows URLs not matching any rule", () => {
    const result = isUrlAllowed("/about", rules);
    expect(result.allowed).toBe(true);
  });

  it("disallows matching disallow patterns", () => {
    const result = isUrlAllowed("/private/secret", rules);
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBe("/private/");
  });

  it("allows matching allow patterns", () => {
    const result = isUrlAllowed("/public/file.html", rules);
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBe("/public/");
  });

  it("most specific path match wins", () => {
    const specificRules: RobotsRule[] = [
      {
        userAgent: "*",
        allow: ["/private/allowed/"],
        disallow: ["/private/"],
        sitemaps: [],
      },
    ];
    const result = isUrlAllowed("/private/allowed/page", specificRules);
    expect(result.allowed).toBe(true);
  });

  it("prefers specific user-agent over wildcard", () => {
    const uaRules: RobotsRule[] = [
      {
        userAgent: "*",
        allow: [],
        disallow: ["/blocked/"],
        sitemaps: [],
      },
      {
        userAgent: "Googlebot",
        allow: ["/blocked/"],
        disallow: [],
        sitemaps: [],
      },
    ];
    const result = isUrlAllowed("/blocked/page", uaRules, "Googlebot");
    expect(result.allowed).toBe(true);
  });

  it("returns allowed=true when no rules match any user-agent", () => {
    const emptyRules: RobotsRule[] = [
      {
        userAgent: "Bingbot",
        allow: [],
        disallow: ["/"],
        sitemaps: [],
      },
    ];
    const result = isUrlAllowed("/page", emptyRules, "Googlebot");
    expect(result.allowed).toBe(true);
  });
});

// ── detectRobotsIssues ───────────────────────────────────────────────────

describe("detectRobotsIssues", () => {
  it("warns when all URLs are blocked", () => {
    const result = {
      exists: true,
      rules: [{ userAgent: "*", allow: [], disallow: ["/"], sitemaps: [] }],
      sitemaps: [],
      raw: "",
    };
    const issues = detectRobotsIssues(result);
    expect(issues.some((i) => i.message.includes("blocks all URLs"))).toBe(
      true,
    );
  });

  it("warns when CSS/JS resources are blocked", () => {
    const result = {
      exists: true,
      rules: [
        {
          userAgent: "*",
          allow: [],
          disallow: ["/css/", "/js/bundle.js"],
          sitemaps: [],
        },
      ],
      sitemaps: [],
      raw: "",
    };
    const issues = detectRobotsIssues(result);
    expect(issues.filter((i) => i.message.includes("CSS/JS"))).toHaveLength(2);
  });

  it("returns no issues for clean robots.txt", () => {
    const result = {
      exists: true,
      rules: [
        { userAgent: "*", allow: [], disallow: ["/admin/"], sitemaps: [] },
      ],
      sitemaps: [],
      raw: "",
    };
    const issues = detectRobotsIssues(result);
    expect(issues).toHaveLength(0);
  });
});

// ── fetchRobotsTxt ───────────────────────────────────────────────────────

describe("fetchRobotsTxt", () => {
  it("fetches and parses robots.txt", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        "User-agent: *\nDisallow: /private/\nSitemap: https://example.com/sitemap.xml",
    });

    const result = await fetchRobotsTxt("https://example.com/page", mockFetch);
    expect(result.exists).toBe(true);
    expect(result.rules).toHaveLength(1);
    expect(result.sitemaps).toContain("https://example.com/sitemap.xml");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/robots.txt",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns not-found result on 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchRobotsTxt("https://example.com/", mockFetch);
    expect(result.exists).toBe(false);
    expect(result.rules).toEqual([]);
  });

  it("returns not-found result on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await fetchRobotsTxt("https://example.com/", mockFetch);
    expect(result.exists).toBe(false);
  });
});
