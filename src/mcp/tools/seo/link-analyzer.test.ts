import { describe, it, expect } from "vitest";
import {
  analyzeLinks,
  computeLinkDepths,
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
