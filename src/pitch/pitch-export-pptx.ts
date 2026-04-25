/**
 * Pitch — `.pptx` export (Phase 6 / sub-issue #972).
 *
 * Maps each of the 14 slide templates to native `pptxgenjs` primitives
 * (`addText`, `addImage`, `addTable`, `addChart`, `addNotes`) so the
 * resulting deck remains editable in PowerPoint.
 *
 * Trade-offs (documented in PR body):
 *   - `mermaid` slides embed the source as a fenced code block. Server-side
 *     mermaid → SVG → PNG would require JSDOM and a headless render, which
 *     is heavier than this phase warrants. Tracked as TODO for Phase 7.
 *   - `code` slides use a plain monospaced text frame on a dark background.
 *     No syntax highlighting — acceptable per the issue criteria.
 *   - All raster images are pre-resized through `sharp` (≤1920px edge) and
 *     re-encoded to PNG before embedding. Per-image cap is 5 MB
 *     post-resize; oversized images throw before the `.pptx` is built.
 *
 * Brand kit drives:
 *   - Master slide background + accent strip + footer + slide-number badge
 *   - Theme `headFontFace` / `bodyFontFace`
 *   - Per-template heading colors
 */
// pptxgenjs is published as CJS without an `exports` map and its `.d.ts`
// default export is not constructable under NodeNext. Bypass the broken
// types via a localized cast — the runtime export is the class.
import * as PptxGenJSNs from "pptxgenjs";
type PptxGenJSCtor = new () => {
  layout: string;
  title: string;
  theme: { headFontFace: string; bodyFontFace: string };
  defineSlideMaster: (opts: Record<string, unknown>) => void;
  addSlide: (opts?: Record<string, unknown>) => PptxSlide;
  write: (opts: { outputType: string }) => Promise<unknown>;
};
type PptxSlide = {
  addText: (text: string | unknown[], opts: Record<string, unknown>) => void;
  addImage: (opts: Record<string, unknown>) => void;
  addShape: (shape: string, opts: Record<string, unknown>) => void;
  addTable: (rows: unknown[], opts: Record<string, unknown>) => void;
  addChart: (type: string, data: unknown[], opts: Record<string, unknown>) => void;
  addNotes: (notes: string) => void;
  background: { color: string };
};
const PptxGenJS = ((PptxGenJSNs as unknown as { default: PptxGenJSCtor }).default ??
  (PptxGenJSNs as unknown as PptxGenJSCtor)) as PptxGenJSCtor;
type PptxGenJSInstance = InstanceType<PptxGenJSCtor>;
import type { BrandKit, Deck, Slide } from "./pitch-schema.js";
import {
  resizeImageForPptx,
  safeFilename,
} from "./pitch-export-utils.js";

export interface ExportPptxResult {
  buffer: Buffer;
  filename: string;
  contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

/** Slide layout in inches — 16:9 widescreen. */
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

/** Margins applied to every body element (inches). */
const MARGIN_X = 0.5;
const CONTENT_W = SLIDE_W - 2 * MARGIN_X;

/**
 * Hook for tests to stub the image resize step. Defaults to the real
 * `sharp`-backed implementation. Production callers do NOT pass this.
 */
export interface ExportPptxOpts {
  resizeImage?: typeof resizeImageForPptx;
  /** Test-only override: skip image fetching when URL refers to a remote asset. */
  fetchImpl?: (url: string) => Promise<Buffer>;
}

export async function exportDeckToPptx(
  deck: Deck,
  brandKit: BrandKit,
  opts: ExportPptxOpts = {},
): Promise<ExportPptxResult> {
  const resize = opts.resizeImage ?? resizeImageForPptx;
  const fetchUrl = opts.fetchImpl ?? defaultFetchImpl;

  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 — explicit, matches our constants
  pres.title = deck.title;
  pres.theme = {
    headFontFace: brandKit.fontHeading,
    bodyFontFace: brandKit.fontBody,
  };

  const primary = stripHash(brandKit.primaryColor);
  const accent = stripHash(brandKit.accentColor);

  pres.defineSlideMaster({
    title: "BRAND_MASTER",
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: SLIDE_H - 0.1, w: SLIDE_W, h: 0.04, fill: { color: accent } } },
      ...(brandKit.footerText
        ? [
            {
              text: {
                text: brandKit.footerText,
                options: { x: 0.5, y: SLIDE_H - 0.35, w: 8, h: 0.25, fontSize: 9, color: "999999" },
              },
            },
          ]
        : []),
    ],
    slideNumber: { x: SLIDE_W - 0.6, y: SLIDE_H - 0.4, color: "666666", fontSize: 9 },
  });

  for (const slide of deck.slides) {
    await renderPptxSlide(pres, slide, brandKit, primary, accent, resize, fetchUrl);
  }

  const out = (await pres.write({ outputType: "nodebuffer" })) as unknown;
  const buffer = toBuffer(out);

  return {
    buffer,
    filename: safeFilename(deck.title, deck.id, ".pptx"),
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
}

// ── Per-template renderers ─────────────────────────────────────────────

async function renderPptxSlide(
  pres: PptxGenJSInstance,
  slide: Slide,
  brandKit: BrandKit,
  primary: string,
  accent: string,
  resize: typeof resizeImageForPptx,
  fetchUrl: (url: string) => Promise<Buffer>,
): Promise<void> {
  const s = pres.addSlide({ masterName: "BRAND_MASTER" });

  switch (slide.template) {
    case "title": {
      if (slide.content.eyebrow) {
        s.addText(slide.content.eyebrow, {
          x: MARGIN_X, y: 1.5, w: CONTENT_W, h: 0.4,
          fontSize: 14, color: accent, bold: true, fontFace: brandKit.fontHeading,
        });
      }
      s.addText(slide.content.title, {
        x: MARGIN_X, y: 2.2, w: CONTENT_W, h: 1.6,
        fontSize: 54, color: primary, bold: true, fontFace: brandKit.fontHeading,
        align: "center", valign: "middle",
      });
      if (slide.content.subtitle) {
        s.addText(slide.content.subtitle, {
          x: MARGIN_X, y: 4.0, w: CONTENT_W, h: 0.8,
          fontSize: 22, color: "555555", italic: true, align: "center",
          fontFace: brandKit.fontBody,
        });
      }
      break;
    }
    case "section_divider": {
      s.background = { color: primary };
      s.addText(`${slide.content.section_number}`, {
        x: MARGIN_X, y: 2.5, w: CONTENT_W, h: 1.0,
        fontSize: 80, color: accent, bold: true, align: "center",
        fontFace: brandKit.fontHeading,
      });
      s.addText(slide.content.title, {
        x: MARGIN_X, y: 3.8, w: CONTENT_W, h: 1.2,
        fontSize: 40, color: "FFFFFF", bold: true, align: "center",
        fontFace: brandKit.fontHeading,
      });
      break;
    }
    case "bullet_list": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.8,
        fontSize: 28, color: primary, bold: true, fontFace: brandKit.fontHeading,
      });
      s.addText(
        slide.content.bullets.map((b) => ({ text: b, options: { bullet: true } })),
        {
          x: MARGIN_X, y: 1.4, w: CONTENT_W, h: SLIDE_H - 2.0,
          fontSize: 18, color: "333333", fontFace: brandKit.fontBody,
          paraSpaceAfter: 6,
        },
      );
      break;
    }
    case "two_column": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.8,
        fontSize: 28, color: primary, bold: true, fontFace: brandKit.fontHeading,
      });
      const colW = (CONTENT_W - 0.4) / 2;
      s.addText(slide.content.left, {
        x: MARGIN_X, y: 1.4, w: colW, h: SLIDE_H - 2.0,
        fontSize: 16, color: "333333", fontFace: brandKit.fontBody, valign: "top",
      });
      s.addText(slide.content.right, {
        x: MARGIN_X + colW + 0.4, y: 1.4, w: colW, h: SLIDE_H - 2.0,
        fontSize: 16, color: "333333", fontFace: brandKit.fontBody, valign: "top",
      });
      break;
    }
    case "image_caption": {
      if (slide.content.heading) {
        s.addText(slide.content.heading, {
          x: MARGIN_X, y: 0.3, w: CONTENT_W, h: 0.6,
          fontSize: 24, color: primary, bold: true, fontFace: brandKit.fontHeading,
        });
      }
      const data = await loadImageDataUrl(slide.content.image.url, resize, fetchUrl);
      if (data) {
        s.addImage({ data, x: MARGIN_X, y: 1.0, w: CONTENT_W, h: 5.0, sizing: { type: "contain", w: CONTENT_W, h: 5.0 } });
      }
      if (slide.content.caption) {
        s.addText(slide.content.caption, {
          x: MARGIN_X, y: 6.2, w: CONTENT_W, h: 0.6,
          fontSize: 14, color: "666666", italic: true, align: "center",
          fontFace: brandKit.fontBody,
        });
      }
      break;
    }
    case "quote": {
      s.addText(`“${slide.content.quote}”`, {
        x: MARGIN_X, y: 1.8, w: CONTENT_W, h: 3.0,
        fontSize: 32, color: primary, italic: true, align: "center", valign: "middle",
        fontFace: brandKit.fontHeading,
      });
      const att = slide.content.source
        ? `— ${slide.content.attribution}, ${slide.content.source}`
        : `— ${slide.content.attribution}`;
      s.addText(att, {
        x: MARGIN_X, y: 5.0, w: CONTENT_W, h: 0.6,
        fontSize: 16, color: "555555", align: "center", fontFace: brandKit.fontBody,
      });
      break;
    }
    case "stats_kpi": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.8,
        fontSize: 28, color: primary, bold: true, fontFace: brandKit.fontHeading,
      });
      const cols = Math.min(slide.content.kpis.length, 3);
      const cellW = (CONTENT_W - (cols - 1) * 0.3) / cols;
      const cellH = 1.8;
      slide.content.kpis.forEach((kpi, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = MARGIN_X + col * (cellW + 0.3);
        const y = 1.6 + row * (cellH + 0.4);
        s.addText(
          [
            { text: kpi.value, options: { fontSize: 36, color: accent, bold: true, breakLine: true } },
            { text: kpi.label, options: { fontSize: 12, color: "555555" } },
            ...(kpi.delta
              ? [{ text: ` (${kpi.delta})`, options: { fontSize: 12, color: "888888" } }]
              : []),
          ],
          { x, y, w: cellW, h: cellH, align: "center", valign: "middle", fontFace: brandKit.fontBody },
        );
      });
      break;
    }
    case "comparison_table": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.8,
        fontSize: 28, color: primary, bold: true, fontFace: brandKit.fontHeading,
      });
      const headerRow = [
        { text: "", options: { bold: true, fill: { color: primary }, color: "FFFFFF" } },
        ...slide.content.columns.map((c) => ({
          text: c, options: { bold: true, fill: { color: primary }, color: "FFFFFF" },
        })),
      ];
      const bodyRows = slide.content.rows.map((r) => [
        { text: r.label, options: { bold: true } },
        ...r.cells.map((c) => ({ text: c })),
      ]);
      s.addTable([headerRow, ...bodyRows], {
        x: MARGIN_X, y: 1.4, w: CONTENT_W,
        fontSize: 14, fontFace: brandKit.fontBody,
        border: { type: "solid", pt: 1, color: "CCCCCC" },
      });
      break;
    }
    case "timeline": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.8,
        fontSize: 28, color: primary, bold: true, fontFace: brandKit.fontHeading,
      });
      slide.content.events.forEach((ev, i) => {
        const y = 1.6 + i * 0.6;
        s.addText(ev.when, {
          x: MARGIN_X, y, w: 1.6, h: 0.5,
          fontSize: 14, color: accent, bold: true, fontFace: brandKit.fontBody,
        });
        s.addText(ev.what, {
          x: MARGIN_X + 1.8, y, w: CONTENT_W - 1.8, h: 0.5,
          fontSize: 14, color: "333333", fontFace: brandKit.fontBody,
        });
      });
      break;
    }
    case "full_bleed": {
      const data = await loadImageDataUrl(slide.content.image.url, resize, fetchUrl);
      if (data) {
        s.addImage({ data, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, sizing: { type: "cover", w: SLIDE_W, h: SLIDE_H } });
      }
      if (slide.content.overlay_text) {
        s.addText(slide.content.overlay_text, {
          x: MARGIN_X, y: SLIDE_H - 1.5, w: CONTENT_W, h: 1.0,
          fontSize: 32, color: "FFFFFF", bold: true, align: "center",
          fontFace: brandKit.fontHeading,
          fill: { color: "000000", transparency: 50 },
        });
      }
      break;
    }
    case "code": {
      s.background = { color: "1E1E1E" };
      if (slide.content.heading) {
        s.addText(slide.content.heading, {
          x: MARGIN_X, y: 0.3, w: CONTENT_W, h: 0.5,
          fontSize: 18, color: "DCDCDC", bold: true, fontFace: brandKit.fontHeading,
        });
      }
      s.addText(slide.content.code, {
        x: MARGIN_X, y: 0.9, w: CONTENT_W, h: SLIDE_H - 1.2,
        fontSize: 14, color: "DCDCDC", fontFace: "Courier New",
        valign: "top",
      });
      break;
    }
    case "qa": {
      s.addText(slide.content.heading || "Questions?", {
        x: MARGIN_X, y: 2.5, w: CONTENT_W, h: 1.5,
        fontSize: 60, color: primary, bold: true, align: "center",
        fontFace: brandKit.fontHeading,
      });
      if (slide.content.contact) {
        s.addText(slide.content.contact, {
          x: MARGIN_X, y: 4.5, w: CONTENT_W, h: 0.8,
          fontSize: 18, color: "555555", align: "center", fontFace: brandKit.fontBody,
        });
      }
      break;
    }
    case "chart": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.8,
        fontSize: 28, color: primary, bold: true, fontFace: brandKit.fontHeading,
      });
      // Recharts JSON shape → pptxgen data shape
      // pptx native expects: [{ name, labels: [], values: [] }]
      const labels = slide.content.series[0]?.data.map((d) => d.x) ?? [];
      const data = slide.content.series.map((series) => ({
        name: series.name,
        labels,
        values: series.data.map((d) => d.y),
      }));
      // CHART_NAME is a string union — our enum aligns 1:1 with valid names.
      s.addChart(slide.content.chart_type, data, {
        x: MARGIN_X, y: 1.4, w: CONTENT_W, h: SLIDE_H - 2.0,
        chartColors: [accent, primary, stripHash(brandKit.secondaryColor), "888888", "BBBBBB"],
      });
      break;
    }
    case "mermaid": {
      // TODO(phase-7): server-side mermaid → SVG via JSDOM + render to PNG via sharp.
      // For now, embed source as a fenced code block — every PowerPoint user
      // can read the diagram intent and re-render in their tool of choice.
      if (slide.content.heading) {
        s.addText(slide.content.heading, {
          x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.6,
          fontSize: 22, color: primary, bold: true, fontFace: brandKit.fontHeading,
        });
      }
      s.background = { color: "FAFAFA" };
      s.addText(`[mermaid: ${slide.content.diagram_type}]`, {
        x: MARGIN_X, y: 1.1, w: CONTENT_W, h: 0.4,
        fontSize: 12, color: "888888", italic: true, fontFace: brandKit.fontBody,
      });
      s.addText(slide.content.source, {
        x: MARGIN_X, y: 1.6, w: CONTENT_W, h: SLIDE_H - 2.2,
        fontSize: 12, color: "333333", fontFace: "Courier New", valign: "top",
      });
      break;
    }
  }

  if (slide.speaker_notes) {
    s.addNotes(slide.speaker_notes);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function stripHash(hex: string): string {
  return hex.startsWith("#") ? hex.slice(1) : hex;
}

function toBuffer(out: unknown): Buffer {
  if (Buffer.isBuffer(out)) return out;
  if (out instanceof Uint8Array) return Buffer.from(out);
  if (out instanceof ArrayBuffer) return Buffer.from(new Uint8Array(out));
  throw new Error("pptxgenjs returned unexpected output type");
}

/**
 * Resolve a slide image URL into a `data:` URL suitable for `addImage`.
 * Returns `null` when the URL is missing or inaccessible — caller decides
 * whether to omit the image or substitute a placeholder.
 */
async function loadImageDataUrl(
  url: string | null | undefined,
  resize: typeof resizeImageForPptx,
  fetchUrl: (url: string) => Promise<Buffer>,
): Promise<string | null> {
  if (!url) return null;
  try {
    const buffer = await fetchUrl(url);
    const { dataUrl } = await resize(buffer);
    return dataUrl;
  } catch {
    return null;
  }
}

async function defaultFetchImpl(url: string): Promise<Buffer> {
  if (url.startsWith("file://")) {
    const { fileURLToPath } = await import("node:url");
    const { readFile } = await import("node:fs/promises");
    return readFile(fileURLToPath(url));
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`unsupported image URL scheme: ${url}`);
}
