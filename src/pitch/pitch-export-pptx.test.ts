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
import JSZip from "jszip";
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

    // Use a *high-contrast* primary AND accent against a white slide
    // background so the readable-color token derivation passes both
    // straight through to the export.
    const kit = buildKit({
      accentColor: "#996600",
      primaryColor: "#123456",
      secondaryColor: "#ffffff",
    });
    const out = await exportDeckToPptx(
      buildDeck([makeSlide("title", { title: "T" })]),
      kit,
      { resizeImage, fetchImpl },
    );

    // Unzip the .pptx and concatenate every XML part — the brand colors
    // (sans `#`) must appear somewhere in the rendered XML payload.
    const xml = (await collectPptxXml(out.buffer)).toLowerCase();
    expect(xml).toContain("996600");
    expect(xml).toContain("123456");
  });

  // Sub-issue #1037 / Epic #1035 AC4 — when the brand kit is so
  // light-on-light that the raw primary/accent colors would be
  // unreadable on a white slide background, the PPTX export must fall
  // back to the contrast-safe heading/accent colors derived by
  // `buildReadableColorTokens`, and overlay text on the
  // section-divider's primary fill must use `onPrimary` (dark for a
  // light fill) instead of a hard-coded white.
  it("low-contrast brand kits route headings through the readable color tokens", async () => {
    const resizeImage = vi.fn();
    const fetchImpl = vi.fn();

    const kit = buildKit({
      // Pure-white primary/secondary/accent on a white slide bg = 1.0:1
      // contrast — illegible without the readable-token fallback.
      primaryColor: "#ffffff",
      secondaryColor: "#ffffff",
      accentColor: "#ffffff",
    });
    const deck = buildDeck([
      makeSlide("title", { title: "T", subtitle: "S", eyebrow: "E" }),
      makeSlide("section_divider", { section_number: 1, title: "Sec" }),
      makeSlide("comparison_table", {
        heading: "H",
        columns: ["A", "B"],
        rows: [{ label: "row", cells: ["x", "y"] }],
      }),
    ]);

    const out = await exportDeckToPptx(deck, kit, { resizeImage, fetchImpl });
    const xml = (await collectPptxXml(out.buffer)).toLowerCase();

    // Readable fallback (dark `#111827`) must appear, proving the
    // export consulted the readable token set instead of dropping the
    // raw white primary directly into the heading color slot. Without
    // the contrast guard, the section_divider title and table header
    // text would render invisibly white-on-white.
    expect(xml).toContain("111827");
  });

  // Regression: a *high*-contrast brand kit must still pass the
  // primary color through verbatim — readable-token derivation only
  // kicks in when contrast is too low.
  it("high-contrast brand kits keep their primary color in the export", async () => {
    const resizeImage = vi.fn();
    const fetchImpl = vi.fn();
    const kit = buildKit({
      primaryColor: "#0a1f44",
      accentColor: "#996600",
      secondaryColor: "#ffffff",
    });
    const out = await exportDeckToPptx(
      buildDeck([makeSlide("title", { title: "T" })]),
      kit,
      { resizeImage, fetchImpl },
    );
    const xml = (await collectPptxXml(out.buffer)).toLowerCase();
    expect(xml).toContain("0a1f44");
  });
});

/**
 * Unzip a `.pptx` buffer (which is a ZIP of XML parts) and concatenate
 * every textual XML/relationship file into a single string. Used by the
 * brand-color tests so they don't have to grovel through the deflated
 * raw bytes.
 */
async function collectPptxXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.values(zip.files).filter(
    (f) => !f.dir && /\.(xml|rels)$/i.test(f.name),
  );
  const parts = await Promise.all(files.map((f) => f.async("string")));
  return parts.join("\n");
}
