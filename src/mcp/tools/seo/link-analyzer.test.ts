import { describe, it, expect, vi } from "vitest";
import {
  analyzeLinks,
  computeLinkDepths,
  followRedirectChain,
  type CrawledPageLinks,
} from "./link-analyzer.js";

function makePages(): CrawledPageLinks[] {
  return [
    {
      url: "https://example.com",
      statusCode: 200,
      links: [
        { href: "https://example.com/about", text: "About", isInternal: true },
        { href: "https://example.com/blog", text: "Blog", isInternal: true },
        { href: "https://external.com", text: "External", isInternal: false },
      ],
    },
    {
      url: "https://example.com/about",
      statusCode: 200,
      links: [
        { href: "https://example.com", text: "Home", isInternal: true },
        {
          href: "https://example.com/contact",
          text: "Contact",
          isInternal: true,
        },
      ],
    },
    {
      url: "https://example.com/blog",
      statusCode: 200,
      links: [
        { href: "https://example.com", text: "Home", isInternal: true },
        {
          href: "https://example.com/blog/post-1",
          text: "Post 1",
          isInternal: true,
        },
      ],
    },
    {
      url: "https://example.com/blog/post-1",
      statusCode: 200,
      links: [
        { href: "https://example.com/blog", text: "Blog", isInternal: true },
      ],
    },
    {
      url: "https://example.com/contact",
      statusCode: 200,
      links: [],
    },
    {
      url: "https://example.com/orphan",
      statusCode: 200,
      links: [{ href: "https://example.com", text: "Home", isInternal: true }],
    },
  ];
}

describe("analyzeLinks", () => {
  it("counts total, internal, and external links", () => {
    const result = analyzeLinks(makePages(), "https://example.com");
    // 3 + 2 + 2 + 1 + 0 + 1 = 9 total links
    expect(result.totalLinks).toBe(9);
    expect(result.internalLinks).toBe(8);
    expect(result.externalLinks).toBe(1);
  });

  it("identifies orphan pages with no incoming internal links", () => {
    const result = analyzeLinks(makePages(), "https://example.com");
    const orphanUrls = result.orphanPages.map((o) => o.url);
    expect(orphanUrls).toContain("https://example.com/orphan");
  });

  it("homepage is never marked as orphan", () => {
    const result = analyzeLinks(makePages(), "https://example.com");
    const orphanUrls = result.orphanPages.map((o) => o.url);
    expect(orphanUrls).not.toContain("https://example.com");
  });

  it("computes link distribution for each page", () => {
    const result = analyzeLinks(makePages(), "https://example.com");
    expect(result.linkDistribution.length).toBe(6);

    const homepage = result.linkDistribution.find(
      (d) => d.url === "https://example.com",
    );
    expect(homepage).toBeDefined();
    expect(homepage!.outgoingCount).toBe(2); // about + blog (internal only)
  });

  it("detects broken links for 4xx status codes", () => {
    const pages: CrawledPageLinks[] = [
      {
        url: "https://example.com",
        statusCode: 200,
        links: [
          {
            href: "https://example.com/broken",
            text: "Broken",
            isInternal: true,
          },
        ],
      },
      {
        url: "https://example.com/broken",
        statusCode: 404,
        links: [],
      },
    ];
    const result = analyzeLinks(pages, "https://example.com");
    expect(result.brokenLinks).toHaveLength(1);
    expect(result.brokenLinks[0].statusCode).toBe(404);
  });
});

describe("computeLinkDepths", () => {
  it("assigns depth 0 to homepage", () => {
    const depths = computeLinkDepths(makePages(), "https://example.com");
    const homepage = depths.find((d) => d.url === "https://example.com");
    expect(homepage).toBeDefined();
    expect(homepage!.depth).toBe(0);
  });

  it("assigns depth 1 to direct children of homepage", () => {
    const depths = computeLinkDepths(makePages(), "https://example.com");
    const about = depths.find((d) => d.url === "https://example.com/about");
    const blog = depths.find((d) => d.url === "https://example.com/blog");
    expect(about!.depth).toBe(1);
    expect(blog!.depth).toBe(1);
  });

  it("assigns depth 2 to grandchildren", () => {
    const depths = computeLinkDepths(makePages(), "https://example.com");
    const post = depths.find(
      (d) => d.url === "https://example.com/blog/post-1",
    );
    const contact = depths.find((d) => d.url === "https://example.com/contact");
    expect(post!.depth).toBe(2);
    expect(contact!.depth).toBe(2);
  });

  it("assigns Infinity to unreachable pages", () => {
    const depths = computeLinkDepths(makePages(), "https://example.com");
    const orphan = depths.find((d) => d.url === "https://example.com/orphan");
    expect(orphan!.depth).toBe(Infinity);
  });

  it("returns sorted results by depth", () => {
    const depths = computeLinkDepths(makePages(), "https://example.com");
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i].depth).toBeGreaterThanOrEqual(depths[i - 1].depth);
    }
  });
});

// ── followRedirectChain (#858) ───────────────────────────────────────────

describe("followRedirectChain", () => {
  it("follows a simple redirect chain", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: "https://example.com/b" }),
      })
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: "https://example.com/c" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });

    const result = await followRedirectChain(
      "https://example.com/a",
      10,
      mockFetch,
    );
    expect(result.chain.chain).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(result.chain.hops).toBe(2);
    expect(result.chain.finalStatus).toBe(200);
    expect(result.chain.isLoop).toBe(false);
  });

  it("detects redirect loops", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: "https://example.com/b" }),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: "https://example.com/a" }),
      });

    const result = await followRedirectChain(
      "https://example.com/a",
      10,
      mockFetch,
    );
    expect(result.chain.isLoop).toBe(true);
    expect(result.issues.some((i) => i.message.includes("loop"))).toBe(true);
  });

  it("warns on long redirect chains (>2 hops)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: "https://example.com/b" }),
      })
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: "https://example.com/c" }),
      })
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: "https://example.com/d" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });

    const result = await followRedirectChain(
      "https://example.com/a",
      10,
      mockFetch,
    );
    expect(result.chain.hops).toBe(3);
    expect(
      result.issues.some((i) => i.message.includes("Long redirect chain")),
    ).toBe(true);
  });

  it("detects mixed HTTP/HTTPS", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: "https://example.com/page" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });

    const result = await followRedirectChain(
      "http://example.com/page",
      10,
      mockFetch,
    );
    expect(result.chain.hasMixedScheme).toBe(true);
    expect(
      result.issues.some((i) => i.message.includes("Mixed HTTP/HTTPS")),
    ).toBe(true);
  });

  it("reports error when chain ends in 4xx/5xx", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: "https://example.com/broken" }),
      })
      .mockResolvedValueOnce({
        status: 404,
        headers: new Headers(),
      });

    const result = await followRedirectChain(
      "https://example.com/old",
      10,
      mockFetch,
    );
    expect(result.chain.finalStatus).toBe(404);
    expect(result.issues.some((i) => i.message.includes("HTTP 404"))).toBe(
      true,
    );
  });

  it("returns 0 hops when no redirect", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
    });

    const result = await followRedirectChain(
      "https://example.com/direct",
      10,
      mockFetch,
    );
    expect(result.chain.hops).toBe(0);
    expect(result.issues).toHaveLength(0);
  });
});
