/**
 * pitch-renderer.test.ts — sub-issue #963 acceptance tests.
 *
 * Coverage targets:
 *   - All 14 templates render without throwing
 *   - XSS payloads in every user-supplied string field are neutralized
 *   - Brand kit colors / fonts present as inline CSS variables
 *   - `embedded` vs `standalone` mode emit correct outer markup
 *   - Missing logo handled gracefully (no `<img>` emitted, no exception)
 *   - URL allowlist drops `javascript:` and `data:` URIs from images
 */
import { describe, it, expect } from "vitest";
import { renderDeckToHtml, sanitize } from "./pitch-renderer.js";
import {
  DeckSchema,
  SlideSchema,
  type BrandKit,
  type Deck,
  type Slide,
} from "./pitch-schema.js";

const XSS = '<script>alert("xss")</script><img src=x onerror=alert(1)>';

const KIT: BrandKit = {
  id: "kit-1",
  name: "Test Kit",
  primaryColor: "#112233",
  secondaryColor: "#445566",
  accentColor: "#778899",
  fontHeading: "Inter",
  fontBody: "Roboto",
  logoUrl: "https://example.com/logo.png",
  watermarkUrl: null,
  footerText: "© Test Co",
};

const KIT_NO_LOGO: BrandKit = { ...KIT, logoUrl: null, footerText: null };

function buildDeck(slides: Slide[]): Deck {
  return DeckSchema.parse({
    id: "deck-x",
    title: "Test Deck",
    brand_kit_id: KIT.id,
    aspect_ratio: "16:9",
    slides,
    metadata: { source_script: "", tone: "formal" },
    created_at: "2026-04-25T00:00:00Z",
    updated_at: "2026-04-25T00:00:00Z",
  });
}

function s(template: string, content: Record<string, unknown>): Slide {
  return SlideSchema.parse({
    template,
    content,
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  });
}

const ALL_TEMPLATES: Slide[] = [
  s("title", { title: "Hello", subtitle: "Sub", eyebrow: "Eyebrow" }),
  s("section_divider", { section_number: 1, title: "Part 1" }),
  s("bullet_list", { heading: "H", bullets: ["one", "two"] }),
  s("two_column", { heading: "H", left: "L", right: "R" }),
  s("image_caption", {
    image: { prompt: "hero", url: "https://x/y.png", alt: "alt" },
    caption: "cap",
  }),
  s("quote", { quote: "Q", attribution: "A", source: "S" }),
  s("stats_kpi", {
    heading: "H",
    kpis: [
      { value: "10", label: "users" },
      { value: "20", label: "growth", delta: "+5%" },
    ],
  }),
  s("comparison_table", {
    heading: "H",
    columns: ["A", "B"],
    rows: [{ label: "row1", cells: ["a1", "b1"] }],
  }),
  s("timeline", {
    heading: "H",
    events: [
      { when: "Q1", what: "ship" },
      { when: "Q2", what: "scale" },
    ],
  }),
  s("full_bleed", {
    image: { prompt: "hero", url: "https://x/y.png", alt: "a" },
    overlay_text: "OV",
  }),
  s("code", { language: "ts", code: "const x = 1;" }),
  s("qa", { heading: "Questions?" }),
  s("chart", {
    heading: "H",
    chart_type: "bar",
    series: [{ name: "s1", data: [{ x: "Jan", y: 10 }] }],
  }),
  s("mermaid", { diagram_type: "flowchart", source: "graph TD;A-->B;" }),
];

describe("renderDeckToHtml", () => {
  it("renders all 14 templates", () => {
    const deck = buildDeck(ALL_TEMPLATES);
    const out = renderDeckToHtml(deck, KIT, "embedded");
    expect(out.slideCount).toBe(14);
    for (const t of [
      "title",
      "section_divider",
      "bullet_list",
      "two_column",
      "image_caption",
      "quote",
      "stats_kpi",
      "comparison_table",
      "timeline",
      "full_bleed",
      "code",
      "qa",
      "chart",
      "mermaid",
    ]) {
      expect(out.html).toContain(`data-template="${t}"`);
    }
  });

  it("embedded mode emits a fragment, not a full document", () => {
    const out = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "embedded");
    expect(out.html.startsWith("<div class=\"pitch-deck-wrap\"")).toBe(true);
    expect(out.html).not.toContain("<!doctype");
    expect(out.html).not.toContain("<html");
  });

  it("standalone mode emits a full HTML document with reveal.js link + init script", () => {
    const out = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "standalone");
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
    expect(out.html).toContain("reveal.js@5/dist/reveal.css");
    expect(out.html).toContain("Reveal");
    expect(out.html).toContain("initialize");
  });

  it("standalone mode honors theme option (allowlist)", () => {
    const ok = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "standalone", {
      theme: "white",
    });
    expect(ok.html).toContain("/theme/white.css");

    // Reject malicious theme — falls back to default `black`.
    const bad = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "standalone", {
      theme: "../../etc/passwd",
    });
    expect(bad.html).toContain("/theme/black.css");
  });

  it("autoInit=false suppresses the inline init script", () => {
    const out = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "standalone", {
      autoInit: false,
    });
    expect(out.html).not.toContain("Reveal({");
  });

  it("applies brand-kit colors as inline CSS variables", () => {
    const out = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "embedded");
    expect(out.html).toContain("--pitch-primary:#112233");
    expect(out.html).toContain("--pitch-secondary:#445566");
    expect(out.html).toContain("--pitch-accent:#778899");
    expect(out.html).toContain("--pitch-font-heading:Inter");
    expect(out.html).toContain("--pitch-font-body:Roboto");
  });

  it("renders the brand kit logo when present", () => {
    const out = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "embedded");
    expect(out.html).toContain('class="pitch-logo"');
    expect(out.html).toContain('src="https://example.com/logo.png"');
  });

  it("omits logo when brand kit has no logoUrl", () => {
    const out = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT_NO_LOGO, "embedded");
    expect(out.html).not.toContain('class="pitch-logo"');
  });

  it("emits footer when present, omits when null", () => {
    const withFooter = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT, "embedded");
    expect(withFooter.html).toContain("© Test Co");
    const without = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), KIT_NO_LOGO, "embedded");
    expect(without.html).not.toContain("pitch-footer");
  });

  it("emits speaker notes inside <aside class=\"notes\">", () => {
    const slide = SlideSchema.parse({
      template: "title",
      content: { title: "Hi" },
      speaker_notes: "Talk slowly.",
      transition: "slide",
      fragments: [],
    });
    const out = renderDeckToHtml(buildDeck([slide]), KIT, "embedded");
    expect(out.html).toContain('<aside class="notes">Talk slowly.</aside>');
  });

  it("sets data-transition when slide transition is non-default", () => {
    const slide = SlideSchema.parse({
      template: "title",
      content: { title: "Hi" },
      speaker_notes: "",
      transition: "fade",
      fragments: [],
    });
    const out = renderDeckToHtml(buildDeck([slide]), KIT, "embedded");
    expect(out.html).toContain('data-transition="fade"');
  });
});

describe("renderDeckToHtml — XSS hardening", () => {
  it("strips <script> from a title slide", () => {
    const slide = SlideSchema.parse({
      template: "title",
      content: { title: XSS, subtitle: XSS, eyebrow: XSS },
      speaker_notes: XSS,
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT, "embedded").html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("alert(");
  });

  it("strips XSS from bullet list bullets", () => {
    const slide = SlideSchema.parse({
      template: "bullet_list",
      content: { heading: XSS, bullets: [XSS, "safe"] },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT, "embedded").html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
  });

  it("strips XSS from quote attribution + source", () => {
    const slide = SlideSchema.parse({
      template: "quote",
      content: { quote: XSS, attribution: XSS, source: XSS },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT, "embedded").html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
  });

  it("strips XSS from comparison table cells", () => {
    const SHORT_XSS = "<script>x</script>";
    const slide = SlideSchema.parse({
      template: "comparison_table",
      content: {
        heading: SHORT_XSS,
        columns: [SHORT_XSS, "ok"],
        rows: [{ label: SHORT_XSS, cells: [SHORT_XSS, "ok"] }],
      },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT, "embedded").html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
  });

  it("HTML-escapes (does not parse) code blocks", () => {
    const slide = SlideSchema.parse({
      template: "code",
      content: { language: "ts", code: "<script>alert(1)</script>" },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT, "embedded").html;
    // The literal text is preserved — but as escaped entities, NOT a real <script>
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
  });

  it("HTML-escapes mermaid source", () => {
    const slide = SlideSchema.parse({
      template: "mermaid",
      content: { diagram_type: "flowchart", source: "<script>x</script>" },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT, "embedded").html;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  it("clamps language slug to safe characters in the class attribute", () => {
    const slide = SlideSchema.parse({
      template: "code",
      content: { language: "ts\" onload=alert(1)", code: "const x=1;" },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT, "embedded").html;
    expect(html).toContain('class="language-tsonloadalert1"');
    expect(html).not.toContain('onload=');
  });

  it("strips XSS from brand kit footer text", () => {
    const evilKit: BrandKit = { ...KIT, footerText: XSS };
    const html = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), evilKit, "embedded").html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
  });

  it("rejects javascript:/data: URLs from inline images", () => {
    const slide = SlideSchema.parse({
      template: "image_caption",
      content: {
        // url passes Zod (it's a valid URL string) but our renderer
        // must drop it because the scheme is not in the allowlist.
        image: {
          prompt: "hero",
          url: "javascript:alert(1)",
          alt: "x",
        },
        caption: "cap",
      },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    });
    const html = renderDeckToHtml(buildDeck([slide]), KIT_NO_LOGO, "embedded").html;
    expect(html).not.toContain("javascript:");
    // Image tag is omitted entirely when URL is rejected
    expect(html).not.toMatch(/<img[^>]+src=/);
  });

  it("rejects javascript: scheme on logoUrl", () => {
    const evilKit: BrandKit = {
      ...KIT,
      logoUrl: "javascript:alert(1)" as unknown as string,
    };
    const html = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), evilKit, "embedded").html;
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("pitch-logo");
  });

  it("allows relative-path logo URLs (already-uploaded assets)", () => {
    const localKit: BrandKit = { ...KIT, logoUrl: "/brand-kits/abc.png" };
    const html = renderDeckToHtml(buildDeck([ALL_TEMPLATES[0]]), localKit, "embedded").html;
    expect(html).toContain('src="/brand-kits/abc.png"');
  });
});

describe("sanitize() — exposed helper", () => {
  it("removes script tags from a free string", () => {
    expect(sanitize(XSS)).not.toContain("<script>");
  });
  it("returns empty string for null/undefined", () => {
    expect(sanitize(null)).toBe("");
    expect(sanitize(undefined)).toBe("");
  });
});
