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
import { buildReadableColorTokens, resolveLogoPlacement } from "./pitch-renderer.js";
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

  // Sub-issue #1037 / Epic #1035 AC4 — PPTX export must honour the same
  // readable-color-token derivation that the HTML/presenter renderers
  // use, so a low-contrast brand kit cannot produce unreadable PPTX
  // slides. `tokens.heading` is contrast-safe vs the slide background
  // (white below); `tokens.accent` is contrast-safe for accent text;
  // `tokens.onPrimary` is the readable text color for surfaces filled
  // with the raw brand primary (section divider background, table
  // header fill, etc.).
  const tokens = buildReadableColorTokens(brandKit);
  const primary = stripHash(tokens.heading);
  const accent = stripHash(tokens.accent);
  const onPrimary = stripHash(tokens.onPrimary);
  const sectionBg = stripHash(brandKit.primaryColor);
  const tableHeaderFill = stripHash(brandKit.primaryColor);

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
    await renderPptxSlide(pres, slide, brandKit, primary, accent, onPrimary, sectionBg, tableHeaderFill, resize, fetchUrl);
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
  onPrimary: string,
  sectionBg: string,
  tableHeaderFill: string,
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
      // Sub-issue #1037 — section divider keeps the brand primary as the
      // slide background but overlays text in `onPrimary` (contrast-safe
      // for that exact color), not a hard-coded white that would vanish
      // on a light brand primary.
      s.background = { color: sectionBg };
      s.addText(`${slide.content.section_number}`, {
        x: MARGIN_X, y: 2.5, w: CONTENT_W, h: 1.0,
        fontSize: 80, color: accent, bold: true, align: "center",
        fontFace: brandKit.fontHeading,
      });
      s.addText(slide.content.title, {
        x: MARGIN_X, y: 3.8, w: CONTENT_W, h: 1.2,
        fontSize: 40, color: onPrimary, bold: true, align: "center",
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
      // Sub-issue #1037 — table header fill stays brand primary but
      // text color uses `onPrimary` so a light brand kit doesn't make
      // the header labels invisible against the fill.
      const headerRow = [
        { text: "", options: { bold: true, fill: { color: tableHeaderFill }, color: onPrimary } },
        ...slide.content.columns.map((c) => ({
          text: c, options: { bold: true, fill: { color: tableHeaderFill }, color: onPrimary },
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
    // ── Sub-issue #1046 ────────────────────────────────────────────
    case "pricing_table": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.7,
        fontSize: 26, color: primary, bold: true, fontFace: brandKit.fontHeading,
      });
      const tiers = slide.content.tiers;
      const colW = (CONTENT_W - 0.3 * (tiers.length - 1)) / tiers.length;
      tiers.forEach((tier, i) => {
        const x = MARGIN_X + i * (colW + 0.3);
        const fill = tier.highlighted ? accent : "F4F4F6";
        const fgPrice = tier.highlighted ? onPrimary : primary;
        s.addShape("rect", {
          x, y: 1.3, w: colW, h: 4.6,
          fill: { color: fill }, line: { color: tier.highlighted ? accent : "DDDDDD", width: 1 },
        });
        s.addText(tier.name, {
          x: x + 0.1, y: 1.4, w: colW - 0.2, h: 0.5,
          fontSize: 14, bold: true, color: fgPrice, align: "center",
          fontFace: brandKit.fontHeading,
        });
        s.addText(`${tier.price}${tier.period ? " " + tier.period : ""}`, {
          x: x + 0.1, y: 1.95, w: colW - 0.2, h: 0.6,
          fontSize: 22, bold: true, color: fgPrice, align: "center",
          fontFace: brandKit.fontHeading,
        });
        s.addText(
          tier.features.map((f) => ({ text: f, options: { bullet: true } })),
          {
            x: x + 0.15, y: 2.7, w: colW - 0.3, h: 2.6,
            fontSize: 11, color: tier.highlighted ? onPrimary : "333333",
            fontFace: brandKit.fontBody, paraSpaceAfter: 4,
          },
        );
        if (tier.cta) {
          s.addText(tier.cta, {
            x: x + 0.1, y: 5.4, w: colW - 0.2, h: 0.4,
            fontSize: 12, bold: true, color: tier.highlighted ? onPrimary : accent,
            align: "center", fontFace: brandKit.fontBody,
          });
        }
      });
      if (slide.content.footnote) {
        s.addText(slide.content.footnote, {
          x: MARGIN_X, y: 6.1, w: CONTENT_W, h: 0.4,
          fontSize: 10, italic: true, color: "888888", align: "center",
          fontFace: brandKit.fontBody,
        });
      }
      break;
    }
    case "big_number": {
      s.addText(slide.content.value, {
        x: MARGIN_X, y: 1.6, w: CONTENT_W, h: 2.4,
        fontSize: 110, bold: true, color: accent, align: "center", valign: "middle",
        fontFace: brandKit.fontHeading,
      });
      s.addText(slide.content.label, {
        x: MARGIN_X, y: 4.1, w: CONTENT_W, h: 0.7,
        fontSize: 22, color: primary, align: "center", bold: true,
        fontFace: brandKit.fontHeading,
      });
      if (slide.content.trend) {
        const arrow =
          slide.content.trend === "up" ? "▲" :
          slide.content.trend === "down" ? "▼" : "▬";
        s.addText(`${arrow} ${slide.content.trend_label ?? slide.content.trend}`, {
          x: MARGIN_X, y: 4.85, w: CONTENT_W, h: 0.4,
          fontSize: 14, color:
            slide.content.trend === "up" ? "15803D" :
            slide.content.trend === "down" ? "B91C1C" : "475569",
          align: "center", fontFace: brandKit.fontBody,
        });
      }
      if (slide.content.support) {
        s.addText(slide.content.support, {
          x: MARGIN_X + 1, y: 5.4, w: CONTENT_W - 2, h: 1.2,
          fontSize: 14, color: "555555", align: "center", italic: true,
          fontFace: brandKit.fontBody,
        });
      }
      break;
    }
    // ── Sub-issue #1049 ────────────────────────────────────────────
    case "team_grid": {
      const members = slide.content.members;
      if (slide.content.heading) {
        s.addText(slide.content.heading, {
          x: MARGIN_X, y: 0.3, w: CONTENT_W, h: 0.6,
          fontSize: 24, bold: true, color: primary,
          fontFace: brandKit.fontHeading,
        });
      }
      // Lay out as a grid sized for the count.
      const cols = members.length <= 4 ? members.length : members.length <= 8 ? 4 : 6;
      const rows = Math.ceil(members.length / cols);
      const cardW = (CONTENT_W - 0.2 * (cols - 1)) / cols;
      const cardH = Math.min(2.4, (SLIDE_H - 1.2) / rows - 0.2);
      members.forEach((m, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x = MARGIN_X + c * (cardW + 0.2);
        const y = 1.0 + r * (cardH + 0.2);
        s.addText(m.name, {
          x, y: y + cardH * 0.55, w: cardW, h: 0.4,
          fontSize: 14, bold: true, color: primary, align: "center",
          fontFace: brandKit.fontHeading,
        });
        s.addText(m.role, {
          x, y: y + cardH * 0.75, w: cardW, h: 0.35,
          fontSize: 11, color: "666666", align: "center", italic: true,
          fontFace: brandKit.fontBody,
        });
        if (m.bio) {
          s.addText(m.bio, {
            x, y: y + cardH * 0.95, w: cardW, h: 0.6,
            fontSize: 9, color: "555555", align: "center",
            fontFace: brandKit.fontBody,
          });
        }
      });
      break;
    }
    case "logo_grid": {
      if (slide.content.heading) {
        s.addText(slide.content.heading, {
          x: MARGIN_X, y: 0.3, w: CONTENT_W, h: 0.6,
          fontSize: 22, bold: true, color: primary,
          fontFace: brandKit.fontHeading,
        });
      }
      // Render alt-text labels as a grid (logo binaries skipped to keep
      // PPTX deterministic; URL fetch is best-effort and may be blocked).
      const logos = slide.content.logos;
      const cols = Math.min(6, logos.length);
      const rows = Math.ceil(logos.length / cols);
      const cellW = (CONTENT_W - 0.2 * (cols - 1)) / cols;
      const cellH = Math.min(0.9, (SLIDE_H - 1.6) / rows);
      logos.forEach((logo, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x = MARGIN_X + c * (cellW + 0.2);
        const y = 1.1 + r * (cellH + 0.15);
        s.addShape("rect", {
          x, y, w: cellW, h: cellH,
          fill: { color: "F4F4F6" }, line: { color: "DDDDDD", width: 1 },
        });
        s.addText(logo.alt, {
          x, y, w: cellW, h: cellH,
          fontSize: 10, color: "555555", align: "center", valign: "middle",
          fontFace: brandKit.fontBody,
        });
      });
      if (slide.content.caption) {
        s.addText(slide.content.caption, {
          x: MARGIN_X, y: SLIDE_H - 0.6, w: CONTENT_W, h: 0.4,
          fontSize: 10, italic: true, color: "888888", align: "center",
          fontFace: brandKit.fontBody,
        });
      }
      break;
    }
    // ── Sub-issue #1052 ────────────────────────────────────────────
    case "roadmap": {
      s.addText(slide.content.heading, {
        x: MARGIN_X, y: 0.3, w: CONTENT_W, h: 0.6,
        fontSize: 22, bold: true, color: primary, fontFace: brandKit.fontHeading,
      });
      const cols = slide.content.columns;
      const tracks = slide.content.tracks;
      const headerRow = ["", ...cols].map((c) => ({
        text: c,
        options: {
          bold: true,
          color: primary,
          fontFace: brandKit.fontHeading,
          align: "center" as const,
        },
      }));
      // Group items per cell.
      const cellMap: Record<string, string[]> = {};
      slide.content.items.forEach((it) => {
        const key = `${it.track}:${it.column}`;
        if (!cellMap[key]) cellMap[key] = [];
        const prefix =
          it.status === "done" ? "✓ " :
          it.status === "in_progress" ? "● " : "○ ";
        cellMap[key].push(prefix + it.label);
      });
      const bodyRows = tracks.map((trackName, ti) => {
        const row: Array<{ text: string; options?: Record<string, unknown> }> = [
          { text: trackName, options: { bold: true, color: onPrimary, fill: { color: primary }, align: "center" } },
        ];
        cols.forEach((_c, ci) => {
          const items = cellMap[`${ti}:${ci}`] ?? [];
          row.push({
            text: items.join("\n"),
            options: { fontSize: 9, color: "333333", fontFace: brandKit.fontBody, valign: "top" },
          });
        });
        return row;
      });
      s.addTable([headerRow, ...bodyRows], {
        x: MARGIN_X, y: 1.1, w: CONTENT_W,
        colW: Array(cols.length + 1).fill(CONTENT_W / (cols.length + 1)),
        border: { type: "solid", color: "DDDDDD", pt: 1 },
        fontSize: 10, fontFace: brandKit.fontBody,
      });
      break;
    }
    case "agenda": {
      const heading = slide.content.heading ?? "Agenda";
      s.addText(heading, {
        x: MARGIN_X, y: 0.4, w: CONTENT_W, h: 0.7,
        fontSize: 28, bold: true, color: primary, fontFace: brandKit.fontHeading,
      });
      // Resolve auto-mode by scanning the deck would need extra plumbing;
      // PPTX exporter only sees one slide at a time, so for "auto" we emit
      // an instructional placeholder. The HTML render path handles auto
      // correctly via its deck context.
      const items =
        slide.content.mode === "manual"
          ? slide.content.items ?? []
          : ["(auto-generated from section dividers in HTML render)"];
      s.addText(
        items.map((t) => ({
          text: t,
          options: { bullet: slide.content.numbered ? { type: "number" } : true },
        })),
        {
          x: MARGIN_X + 0.5, y: 1.4, w: CONTENT_W - 1, h: SLIDE_H - 2.0,
          fontSize: 18, color: "333333", fontFace: brandKit.fontBody, paraSpaceAfter: 8,
        },
      );
      break;
    }
  }

  if (slide.speaker_notes) {
    s.addNotes(slide.speaker_notes);
  }

  // Sub-issue #1051 \u2014 per-slide logo emission. Resolves placement via
  // the same rules the HTML renderer uses (per-slide override > kit
  // default, hidden on title/qa unless overridden). Failure to load the
  // logo is silently skipped so a missing asset never breaks the export.
  await emitSlideLogoAndOverrides(s, slide, brandKit, resize, fetchUrl);
}

/**
 * Sub-issue #1051 \u2014 corner-to-(X,Y) mapping for the per-slide logo.
 * Logo is rendered at ~0.6\" tall, anchored to the corner with a 0.3\"
 * margin. Returns `null` when the slide must not show a logo.
 */
export function pptxLogoCornerXY(
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right",
): { x: number; y: number; w: number; h: number } {
  const w = 1.0;
  const h = 0.6;
  const m = 0.3;
  switch (corner) {
    case "top-left":
      return { x: m, y: m, w, h };
    case "top-right":
      return { x: SLIDE_W - w - m, y: m, w, h };
    case "bottom-left":
      return { x: m, y: SLIDE_H - h - m, w, h };
    case "bottom-right":
    default:
      return { x: SLIDE_W - w - m, y: SLIDE_H - h - m, w, h };
  }
}

async function emitSlideLogoAndOverrides(
  s: PptxSlide,
  slide: Slide,
  brandKit: BrandKit,
  resize: typeof resizeImageForPptx,
  fetchUrl: (url: string) => Promise<Buffer>,
): Promise<void> {
  const placement = resolveLogoPlacement(slide, brandKit);
  if (placement !== "none" && brandKit.logoUrl) {
    const data = await loadImageDataUrl(brandKit.logoUrl, resize, fetchUrl);
    if (data) {
      const { x, y, w, h } = pptxLogoCornerXY(placement);
      s.addImage({ data, x, y, w, h, sizing: { type: "contain", w, h } });
    }
  }

  // Per-slide footer override beats the master footer.
  const footerOverride = slide.branding?.footerOverride;
  if (footerOverride) {
    s.addText(footerOverride, {
      x: 0.5, y: SLIDE_H - 0.35, w: SLIDE_W - 1.0, h: 0.25,
      fontSize: 9, color: "999999", align: "center",
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function stripHash(hex: string): string {
  // pptxgenjs validates color values with an uppercase-only `^[0-9A-F]{6}$`
  // regex; lowercase hex (e.g. `0a1f44`) is silently dropped + replaced
  // with `FFFFFF`. Normalise here so callers don't have to remember.
  const trimmed = hex.startsWith("#") ? hex.slice(1) : hex;
  return trimmed.toUpperCase();
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
