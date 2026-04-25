/**
 * pitch-export-md — unit tests (Phase 6 / sub-issue #973).
 *
 * Verifies all 14 templates produce sensible Markdown, that XSS payloads
 * stay as plain text, and that empty fields don't produce empty headings.
 */
import { describe, it, expect } from "vitest";
import { exportDeckToMarkdown, escapeMdCell } from "./pitch-export-md.js";
import { DeckSchema, SlideSchema, type Deck, type Slide } from "./pitch-schema.js";

function deckWith(slides: Slide[], overrides: Partial<Deck> = {}): Deck {
  return DeckSchema.parse({
    id: "deck-md",
    title: "MD Test Deck",
    brand_kit_id: "kit-1",
    aspect_ratio: "16:9",
    slides,
    metadata: { source_script: "", tone: "formal", audience: "Investors" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeSlide(template: Slide["template"], content: unknown, notes = ""): Slide {
  return SlideSchema.parse({
    template,
    content,
    speaker_notes: notes,
    transition: "slide",
    fragments: [],
  } as unknown);
}

describe("exportDeckToMarkdown", () => {
  it("returns buffer + filename + markdown content type", () => {
    const out = exportDeckToMarkdown(
      deckWith([makeSlide("title", { title: "Hi" })]),
    );
    expect(out.contentType).toBe("text/markdown; charset=utf-8");
    expect(out.filename).toBe("MD_Test_Deck.md");
    expect(out.buffer).toBeInstanceOf(Buffer);
    const text = out.buffer.toString("utf8");
    expect(text).toContain("# MD Test Deck");
    expect(text).toContain("Audience: Investors");
  });

  it("renders all 14 templates without throwing", () => {
    const slides: Slide[] = [
      makeSlide("title", { title: "Title" }),
      makeSlide("section_divider", { section_number: 1, title: "Sec" }),
      makeSlide("bullet_list", { heading: "H", bullets: ["a", "b"] }),
      makeSlide("two_column", { heading: "H", left: "L", right: "R" }),
      makeSlide("image_caption", {
        image: { prompt: "prompt", url: "https://x/y.png", alt: "alt" },
        caption: "cap",
      }),
      makeSlide("quote", { quote: "Q", attribution: "A" }),
      makeSlide("stats_kpi", {
        heading: "H",
        kpis: [{ value: "1", label: "L" }, { value: "2", label: "L2" }],
      }),
      makeSlide("comparison_table", {
        heading: "H",
        columns: ["A", "B"],
        rows: [{ label: "R1", cells: ["x", "y"] }],
      }),
      makeSlide("timeline", {
        heading: "H",
        events: [{ when: "Q1", what: "Launch" }, { when: "Q2", what: "Scale" }],
      }),
      makeSlide("full_bleed", {
        image: { prompt: "prompt", url: "https://x/y.png", alt: "alt" },
      }),
      makeSlide("code", { language: "ts", code: "const x = 1" }),
      makeSlide("qa", {}),
      makeSlide("chart", {
        heading: "H",
        chart_type: "bar",
        series: [{ name: "S", data: [{ x: "a", y: 1 }] }],
      }),
      makeSlide("mermaid", {
        diagram_type: "flowchart",
        source: "graph TD\nA-->B",
      }),
    ];
    const out = exportDeckToMarkdown(deckWith(slides));
    const text = out.buffer.toString("utf8");
    expect(text).toContain("# Title");
    expect(text).toContain("Section 1: Sec");
    expect(text).toContain("- a");
    expect(text).toContain("**Left:**");
    expect(text).toContain("![alt](https://x/y.png)");
    expect(text).toContain("> Q");
    expect(text).toContain("**1** — L");
    expect(text).toContain("|  | A | B |");
    expect(text).toContain("**Q1** — Launch");
    expect(text).toContain("```ts");
    expect(text).toContain("Questions?");
    expect(text).toContain("_Chart: bar_");
    expect(text).toContain("```mermaid");
  });

  it("escapes embedded triple-backticks in code blocks", () => {
    const slide = makeSlide("code", {
      language: "js",
      code: "evil ``` end",
    });
    const text = exportDeckToMarkdown(deckWith([slide])).buffer.toString("utf8");
    // The user-supplied triple-backtick must no longer appear adjacent —
    // zero-width separators are inserted between each backtick so the
    // fenced block cannot close prematurely.
    expect(text).not.toContain("evil ``` end");
    expect(text).toContain("evil");
    expect(text).toContain("\u200B`\u200B`\u200B`");
  });

  it("XSS payloads are preserved as plain text — markdown renderers must escape on render", () => {
    const slide = makeSlide("bullet_list", {
      heading: "<script>alert(1)</script>",
      bullets: ["<img onerror=x>"],
    });
    const text = exportDeckToMarkdown(deckWith([slide])).buffer.toString("utf8");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("<img onerror=x>");
  });

  it("empty speaker notes don't produce an empty notes block", () => {
    const text = exportDeckToMarkdown(
      deckWith([makeSlide("title", { title: "T" })]),
    ).buffer.toString("utf8");
    expect(text).not.toContain("Speaker notes:");
  });

  it("empty optional fields don't produce empty headings", () => {
    const text = exportDeckToMarkdown(
      deckWith([makeSlide("image_caption", {
        image: { prompt: "img", url: "https://x/y.png", alt: "a" },
        caption: "",
      })]),
    ).buffer.toString("utf8");
    expect(text).not.toMatch(/^### \s*$/m);
  });
});

// ── escapeMdCell (Phase 7 — sub-issue #977) ────────────────────────────

describe("escapeMdCell", () => {
  it("escapes pipe characters", () => {
    expect(escapeMdCell("a | b")).toBe("a \\| b");
  });

  it("escapes backslashes BEFORE pipes (avoid double-escape)", () => {
    expect(escapeMdCell("a\\b")).toBe("a\\\\b");
    expect(escapeMdCell("a\\|b")).toBe("a\\\\\\|b");
  });

  it("converts newlines to <br>", () => {
    expect(escapeMdCell("line1\nline2")).toBe("line1<br>line2");
    expect(escapeMdCell("line1\r\nline2")).toBe("line1<br>line2");
    expect(escapeMdCell("line1\rline2")).toBe("line1<br>line2");
  });

  it("returns empty string for null/undefined", () => {
    expect(escapeMdCell(null as unknown as string)).toBe("");
    expect(escapeMdCell(undefined as unknown as string)).toBe("");
  });

  it("regression — comparison_table with pipes/newlines does not break the table", () => {
    const slide = makeSlide("comparison_table", {
      heading: "Pricing",
      columns: ["Plan | Tier", "Cost\nUSD"],
      rows: [
        { label: "Pro | Plus", cells: ["$10|month", "Yes\nincl. tax"] },
      ],
    });
    const text = exportDeckToMarkdown(deckWith([slide])).buffer.toString("utf8");
    // Each table row should have exactly N+1 unescaped pipes (where N is
    // the number of columns) — i.e. no user-supplied raw pipe leaks
    // through.
    const tableLines = text
      .split("\n")
      .filter((l) => l.trim().startsWith("|"));
    expect(tableLines.length).toBeGreaterThan(0);
    for (const line of tableLines) {
      // Count UNESCAPED pipes only.
      const unescaped = line.replace(/\\\|/g, "").match(/\|/g) ?? [];
      // 2 columns plus the row label = 3 user-cell columns, plus
      // bounding pipes = 4 unescaped pipes per row.
      expect(unescaped.length).toBe(4);
    }
    // The cell with newline must have been collapsed to <br>.
    expect(text).toContain("Yes<br>incl. tax");
    expect(text).toContain("Cost<br>USD");
  });
});
