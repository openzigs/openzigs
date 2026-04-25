/**
 * pitch-export-pptx — unit tests (Phase 6 / sub-issue #972).
 *
 * Uses real `pptxgenjs` (pure-JS, runs cleanly in Node) but stubs out
 * the `sharp`-backed image resize + remote fetch. Verifies:
 *   - Each of the 14 templates exports without throwing
 *   - Brand colors are wired into the master slide
 *   - `resizeImage` is called for image-bearing templates
 *   - Output buffer is non-empty + starts with the PK zip header
 *   - Oversized images are rejected (resize stub throws)
 */
import { describe, it, expect, vi } from "vitest";
import { exportDeckToPptx } from "./pitch-export-pptx.js";
import {
  DeckSchema,
  BrandKitSchema,
  SlideSchema,
  type Deck,
  type Slide,
  type BrandKit,
} from "./pitch-schema.js";

const PNG_TINY = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function buildKit(overrides: Partial<BrandKit> = {}): BrandKit {
  return BrandKitSchema.parse({
    id: "kit-1",
    name: "Default",
    primaryColor: "#112233",
    secondaryColor: "#445566",
    accentColor: "#ff8800",
    fontHeading: "Inter",
    fontBody: "Roboto",
    logoUrl: null,
    watermarkUrl: null,
    footerText: "Confidential",
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

function buildDeck(slides: Slide[], overrides: Partial<Deck> = {}): Deck {
  return DeckSchema.parse({
    id: "deck-pptx",
    title: "PPTX Test",
    brand_kit_id: "kit-1",
    aspect_ratio: "16:9",
    slides,
    metadata: { source_script: "", tone: "formal" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

const allTemplates: Slide[] = [
  makeSlide("title", { title: "T", subtitle: "S", eyebrow: "E" }, "intro"),
  makeSlide("section_divider", { section_number: 2, title: "Sec" }),
  makeSlide("bullet_list", { heading: "H", bullets: ["a", "b", "c"] }),
  makeSlide("two_column", { heading: "H", left: "L copy", right: "R copy" }),
  makeSlide("image_caption", {
    image: { prompt: "prompt", url: "https://x/y.png", alt: "alt" },
    caption: "cap",
    heading: "H",
  }),
  makeSlide("quote", { quote: "Q", attribution: "A", source: "Src" }),
  makeSlide("stats_kpi", {
    heading: "H",
    kpis: [
      { value: "$1B", label: "ARR", delta: "+20%" },
      { value: "99%", label: "Uptime" },
    ],
  }),
  makeSlide("comparison_table", {
    heading: "H",
    columns: ["Us", "Them"],
    rows: [{ label: "Speed", cells: ["fast", "slow"] }],
  }),
  makeSlide("timeline", {
    heading: "H",
    events: [{ when: "Q1", what: "Launch" }, { when: "Q2", what: "Scale" }],
  }),
  makeSlide("full_bleed", {
    image: { prompt: "prompt", url: "https://x/y.png", alt: "alt" },
    overlay_text: "Overlay",
  }),
  makeSlide("code", { language: "ts", code: "const x = 1\nfn()" }),
  makeSlide("qa", { contact: "hi@example.com" }),
  makeSlide("chart", {
    heading: "H",
    chart_type: "bar",
    series: [
      { name: "S1", data: [{ x: "a", y: 1 }, { x: "b", y: 2 }] },
    ],
  }),
  makeSlide("mermaid", {
    heading: "Diagram",
    diagram_type: "flowchart",
    source: "graph TD\nA-->B",
  }),
];

describe("exportDeckToPptx", () => {
  it("exports all 14 templates without throwing and returns a real .pptx buffer", async () => {
    const resizeImage = vi
      .fn()
      .mockResolvedValue({ dataUrl: `data:image/png;base64,${PNG_TINY.toString("base64")}`, bytes: 100 });
    const fetchImpl = vi.fn().mockResolvedValue(PNG_TINY);

    const out = await exportDeckToPptx(
      buildDeck(allTemplates),
      buildKit(),
      { resizeImage, fetchImpl },
    );

    expect(out.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(out.filename).toBe("PPTX_Test.pptx");
    expect(out.buffer.length).toBeGreaterThan(1000);
    // .pptx is a zip — magic bytes are "PK\x03\x04"
    expect(out.buffer.slice(0, 2).toString("utf8")).toBe("PK");
    // image_caption + full_bleed both have URLs → 2 fetch + 2 resize calls
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(resizeImage).toHaveBeenCalledTimes(2);
  });

  it("propagates oversized image rejections from the resize step", async () => {
    const resizeImage = vi
      .fn()
      .mockRejectedValue(new Error("Image exceeds 100 bytes after resize (1000)"));
    const fetchImpl = vi.fn().mockResolvedValue(PNG_TINY);

    // The export catches per-image failures and substitutes null so the
    // overall deck still ships — verify by running an image_caption deck.
    const out = await exportDeckToPptx(
      buildDeck([allTemplates[4]!]),
      buildKit(),
      { resizeImage, fetchImpl },
    );
    expect(out.buffer.length).toBeGreaterThan(0);
    expect(resizeImage).toHaveBeenCalled();
  });

  it("skips images when fetch fails and still produces a deck", async () => {
    const resizeImage = vi
      .fn()
      .mockResolvedValue({ dataUrl: "data:image/png;base64,xxx", bytes: 100 });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const out = await exportDeckToPptx(
      buildDeck([allTemplates[4]!]),
      buildKit(),
      { resizeImage, fetchImpl },
    );
    expect(out.buffer.length).toBeGreaterThan(0);
    expect(resizeImage).not.toHaveBeenCalled();
  });

  it("brand colors flow through to the master slide (smoke check via XML inspection)", async () => {
    const resizeImage = vi
      .fn()
      .mockResolvedValue({ dataUrl: "data:image/png;base64,xxx", bytes: 100 });
    const fetchImpl = vi.fn().mockResolvedValue(PNG_TINY);

    const kit = buildKit({ accentColor: "#abcdef", primaryColor: "#123456" });
    const out = await exportDeckToPptx(
      buildDeck([makeSlide("title", { title: "T" })]),
      kit,
      { resizeImage, fetchImpl },
    );

    // Inspect the underlying zip text — brand colors (sans `#`) should
    // appear somewhere in the XML payload.
    const text = out.buffer.toString("latin1");
    expect(text.toLowerCase()).toContain("abcdef");
    expect(text.toLowerCase()).toContain("123456");
  });
});
