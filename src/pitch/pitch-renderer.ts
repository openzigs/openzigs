/**
 * Pitch — server-side Reveal.js HTML renderer (Phase 4 / sub-issue #963).
 *
 * Pure function: takes a validated `Deck` + its `BrandKit` and emits the
 * markup that powers both the in-app preview (`embedded` mode) and the
 * static export pipeline (`standalone` mode, used by Phase 6 PDF/zip).
 *
 * SECURITY (research §10):
 *   - Every user-supplied string field is sanitized through `isomorphic-dompurify`.
 *     `FORBID_TAGS = ['script','iframe','object','embed']`,
 *     `FORBID_ATTR = ['onerror','onload','onclick','onmouseover',...all on*]`.
 *   - The `code` template intentionally bypasses dompurify and HTML-escapes
 *     the source text instead — no HTML markup is permitted inside `<pre><code>`,
 *     so the safest path is escape-only.
 *   - Logo `src` URLs are rendered through a strict allowlist
 *     (`http(s)://` or relative `/`-prefixed paths only); `data:`/`javascript:`
 *     URIs are dropped.
 *
 * Logo + brand-kit asset URLs are assumed to have already been
 * sniffed + sharp-re-encoded by the Phase-3 upload route.
 */
import {
  escapeAttr,
  escapeHtml,
  safeUrl,
  sanitizeRichText,
} from "./pitch-sanitize.js";
import type {
  BrandKit,
  Deck,
  Slide,
  SlideImage,
} from "./pitch-schema.js";

// ── Public surface ──────────────────────────────────────────────────────

export type RenderMode = "embedded" | "standalone";

export interface RenderOpts {
  /** Standalone mode only — Reveal.js theme. Default: `black`. */
  theme?: string;
  /** Standalone mode only — set to `false` to skip the inline init script. */
  autoInit?: boolean;
  /**
   * Per-slide background-image URLs to emit as Reveal.js
   * `data-background-image` attributes on the `<section>` (sub-issue #992).
   *
   * Keyed by slide index (the Deck JSON does not carry per-slide row
   * IDs — see `assembleDeck` in `pitch-repository.ts`). The caller
   * (route handlers in `src/api/pitch.ts`) joins the `pitch_slides`
   * table to the `pitch_assets` rows to produce the position→URL map.
   * When omitted or empty the renderer behaves exactly as before — pure
   * additive change.
   *
   * Each URL is re-validated through `safeUrl` here so an unsafe value
   * (e.g. `javascript:`) is silently dropped rather than emitted.
   */
  backgroundImageUrlBySlideIndex?: ReadonlyMap<number, string>;
}

export interface RenderResult {
  html: string;
  /** Number of `<section>` slides emitted (for tests / audit logs). */
  slideCount: number;
}

/**
 * Render a deck to a Reveal.js HTML string.
 *
 * `embedded` returns just the `<div class="reveal">…</div>` fragment so it
 * can be hydrated inside an existing Next.js page. `standalone` returns a
 * complete `<!doctype html>` document with reveal.js CSS/JS embedded
 * (CDN-loaded — Decktape can run it offline by pre-bundling).
 */
export function renderDeckToHtml(
  deck: Deck,
  brandKit: BrandKit,
  mode: RenderMode = "embedded",
  opts: RenderOpts = {},
): RenderResult {
  const bgMap = opts.backgroundImageUrlBySlideIndex;
  const slidesHtml = deck.slides
    .map((slide, index) => renderSlide(slide, bgMap?.get(index)))
    .join("\n");
  const wrapperStyle = brandKitInlineStyle(brandKit);
  const footer = brandKit.footerText
    ? `<footer class="pitch-footer">${sanitize(brandKit.footerText)}</footer>`
    : "";
  const logoTag = brandKitLogoTag(brandKit);

  const reveal = `<div class="reveal" data-deck-id="${attr(deck.id)}" data-aspect="${attr(
    deck.aspect_ratio,
  )}"><div class="slides">${slidesHtml}</div>${footer}${logoTag}</div>`;

  if (mode === "embedded") {
    return {
      html: `<div class="pitch-deck-wrap" style="${wrapperStyle}">${reveal}</div>`,
      slideCount: deck.slides.length,
    };
  }

  // standalone mode — full HTML document
  const theme = opts.theme && /^[a-z0-9-]+$/i.test(opts.theme) ? opts.theme : "black";
  const autoInit = opts.autoInit !== false;
  const initScript = autoInit
    ? `<script type="module">
import Reveal from "https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.esm.js";
new Reveal({ hash: false, controls: true, progress: true, transition: "slide" }).initialize();
</script>`
    : "";

  return {
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${sanitize(deck.title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/${theme}.css">
<style>${standaloneStyles()}</style>
</head>
<body style="${wrapperStyle}">
${reveal}
${initScript}
</body>
</html>`,
    slideCount: deck.slides.length,
  };
}

// ── Sanitization helpers ───────────────────────────────────────────────
// All sanitization config is centralized in `pitch-sanitize.ts`. Two thin
// re-exports below keep call sites readable inside the template renderers.

/** Re-export of {@link sanitizeRichText} — kept under the legacy name used
 *  by Phase 4 template renderers below. Exported for callers (and tests)
 *  that already imported the renderer-local helper. */
export const sanitize = sanitizeRichText;

/** Re-export of {@link escapeAttr} for attribute-context call sites. */
const attr = escapeAttr;

// ── Brand-kit helpers ──────────────────────────────────────────────────

function brandKitInlineStyle(kit: BrandKit): string {
  return [
    `--pitch-primary:${kit.primaryColor}`,
    `--pitch-secondary:${kit.secondaryColor}`,
    `--pitch-accent:${kit.accentColor}`,
    `--pitch-font-heading:${escapeHtml(kit.fontHeading)}`,
    `--pitch-font-body:${escapeHtml(kit.fontBody)}`,
  ].join(";");
}

function brandKitLogoTag(kit: BrandKit): string {
  const url = safeUrl(kit.logoUrl);
  if (!url) return "";
  return `<img class="pitch-logo" src="${attr(url)}" alt="${attr(kit.name)} logo">`;
}

function standaloneStyles(): string {
  // Minimal — most styling lives in reveal theme. Brand colors picked up via vars.
  return `
.reveal { font-family: var(--pitch-font-body, sans-serif); }
.reveal h1,.reveal h2,.reveal h3 { font-family: var(--pitch-font-heading, sans-serif); color: var(--pitch-primary); }
.reveal .pitch-accent { color: var(--pitch-accent); }
.reveal .pitch-footer { position: fixed; bottom: 8px; left: 16px; font-size: 12px; opacity: .6; }
.reveal .pitch-logo { position: fixed; top: 8px; right: 16px; max-height: 40px; }
.reveal .pitch-kpi { display:inline-block; padding: 1rem 1.5rem; margin: .5rem; border: 1px solid var(--pitch-accent); border-radius: 8px; }
.reveal table { border-collapse: collapse; width: 100%; }
.reveal table td, .reveal table th { border: 1px solid currentColor; padding: .25rem .5rem; }
`.trim();
}

// ── Per-template renderers ─────────────────────────────────────────────

function renderSlide(slide: Slide, backgroundUrl?: string): string {
  const sectionAttrs = sectionAttributes(slide, backgroundUrl);
  const body = renderTemplateBody(slide);
  const notes = slide.speaker_notes
    ? `<aside class="notes">${sanitize(slide.speaker_notes)}</aside>`
    : "";
  return `<section ${sectionAttrs}>${body}${notes}</section>`;
}

function sectionAttributes(slide: Slide, backgroundUrl?: string): string {
  const parts: string[] = [`data-template="${attr(slide.template)}"`];
  if (slide.transition && slide.transition !== "slide") {
    parts.push(`data-transition="${attr(slide.transition)}"`);
  }
  // Sub-issue #992 — background image URL is supplied by the caller (looked
  // up from `pitch_assets` kind=background). Re-validate through `safeUrl`
  // so a tampered URL never reaches the rendered HTML. When the URL is
  // missing, malformed, or `safeUrl`-rejected, the section is emitted
  // without the attribute and Reveal.js falls back to the theme background.
  if (backgroundUrl) {
    const safe = safeUrl(backgroundUrl);
    if (safe) {
      parts.push(`data-background-image="${attr(safe)}"`);
      parts.push(`data-background-size="cover"`);
      parts.push(`data-background-position="center"`);
    }
  }
  return parts.join(" ");
}

function renderTemplateBody(slide: Slide): string {
  switch (slide.template) {
    case "title":
      return renderTitle(slide);
    case "section_divider":
      return renderSectionDivider(slide);
    case "bullet_list":
      return renderBulletList(slide);
    case "two_column":
      return renderTwoColumn(slide);
    case "image_caption":
      return renderImageCaption(slide);
    case "quote":
      return renderQuote(slide);
    case "stats_kpi":
      return renderStatsKpi(slide);
    case "comparison_table":
      return renderComparisonTable(slide);
    case "timeline":
      return renderTimeline(slide);
    case "full_bleed":
      return renderFullBleed(slide);
    case "code":
      return renderCode(slide);
    case "qa":
      return renderQa(slide);
    case "chart":
      return renderChart(slide);
    case "mermaid":
      return renderMermaid(slide);
    default: {
      // Exhaustiveness guard — TS will warn if a template is added without a case.
      const _exhaustive: never = slide;
      void _exhaustive;
      return "";
    }
  }
}

// ── Template implementations ───────────────────────────────────────────

function renderTitle(s: Extract<Slide, { template: "title" }>): string {
  const { title, subtitle, eyebrow } = s.content;
  return [
    eyebrow ? `<p class="pitch-eyebrow pitch-accent" data-pitch-field="eyebrow">${sanitize(eyebrow)}</p>` : "",
    `<h1 data-pitch-field="title">${sanitize(title)}</h1>`,
    subtitle ? `<h3 data-pitch-field="subtitle">${sanitize(subtitle)}</h3>` : "",
  ].join("");
}

function renderSectionDivider(
  s: Extract<Slide, { template: "section_divider" }>,
): string {
  const { section_number, title } = s.content;
  return `<p class="pitch-section-num pitch-accent" data-pitch-field="section_number">${escapeHtml(String(section_number))}</p><h2 data-pitch-field="title">${sanitize(title)}</h2>`;
}

function renderBulletList(
  s: Extract<Slide, { template: "bullet_list" }>,
): string {
  const { heading, bullets, image } = s.content;
  const items = bullets
    .map((b, i) => `<li data-pitch-field="bullets.${i}">${sanitize(b)}</li>`)
    .join("");
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><ul>${items}</ul>${imageTag(image)}`;
}

function renderTwoColumn(
  s: Extract<Slide, { template: "two_column" }>,
): string {
  const { heading, left, right, left_image, right_image } = s.content;
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><div class="pitch-twocol" style="display:flex;gap:1rem;"><div data-pitch-field="left">${sanitize(left)}${imageTag(left_image)}</div><div data-pitch-field="right">${sanitize(right)}${imageTag(right_image)}</div></div>`;
}

function renderImageCaption(
  s: Extract<Slide, { template: "image_caption" }>,
): string {
  const { image, caption, heading } = s.content;
  return `${heading ? `<h2 data-pitch-field="heading">${sanitize(heading)}</h2>` : ""}${imageTag(image)}<p class="pitch-caption" data-pitch-field="caption">${sanitize(caption)}</p>`;
}

function renderQuote(s: Extract<Slide, { template: "quote" }>): string {
  const { quote, attribution, source } = s.content;
  return `<blockquote data-pitch-field="quote">${sanitize(quote)}</blockquote><p class="pitch-attribution" data-pitch-field="attribution">— ${sanitize(attribution)}${source ? `, ${sanitize(source)}` : ""}</p>`;
}

function renderStatsKpi(
  s: Extract<Slide, { template: "stats_kpi" }>,
): string {
  const { heading, kpis } = s.content;
  const cells = kpis
    .map(
      (k, i) =>
        `<div class="pitch-kpi" data-pitch-field="kpis.${i}"><div class="pitch-kpi-value">${sanitize(k.value)}</div><div class="pitch-kpi-label">${sanitize(k.label)}</div>${k.delta ? `<div class="pitch-kpi-delta pitch-accent">${sanitize(k.delta)}</div>` : ""}</div>`,
    )
    .join("");
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><div class="pitch-kpis" style="display:flex;flex-wrap:wrap;justify-content:center;">${cells}</div>`;
}

function renderComparisonTable(
  s: Extract<Slide, { template: "comparison_table" }>,
): string {
  const { heading, columns, rows } = s.content;
  const head = `<tr><th></th>${columns.map((c) => `<th>${sanitize(c)}</th>`).join("")}</tr>`;
  const body = rows
    .map(
      (r) =>
        `<tr><th>${sanitize(r.label)}</th>${r.cells.map((c) => `<td>${sanitize(c)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderTimeline(
  s: Extract<Slide, { template: "timeline" }>,
): string {
  const { heading, events } = s.content;
  const items = events
    .map(
      (e, i) =>
        `<li data-pitch-field="events.${i}"><strong class="pitch-accent">${sanitize(e.when)}</strong> — ${sanitize(e.what)}</li>`,
    )
    .join("");
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><ol class="pitch-timeline">${items}</ol>`;
}

function renderFullBleed(
  s: Extract<Slide, { template: "full_bleed" }>,
): string {
  const { image, overlay_text } = s.content;
  return `<div class="pitch-fullbleed" style="position:relative;">${imageTag(image)}${overlay_text ? `<div class="pitch-overlay" data-pitch-field="overlay_text">${sanitize(overlay_text)}</div>` : ""}</div>`;
}

function renderCode(s: Extract<Slide, { template: "code" }>): string {
  const { heading, language, code } = s.content;
  // dompurify intentionally NOT used here — `<pre><code>` is text-only,
  // escapeHtml is the safest path. Class name is locked to `language-{slug}`.
  const langSlug = String(language).replace(/[^a-z0-9_+-]/gi, "").slice(0, 20);
  return `${heading ? `<h3 data-pitch-field="heading">${sanitize(heading)}</h3>` : ""}<pre data-pitch-field="code"><code class="language-${langSlug}">${escapeHtml(code)}</code></pre>`;
}

function renderQa(s: Extract<Slide, { template: "qa" }>): string {
  const { heading, contact } = s.content;
  return `<h1 data-pitch-field="heading">${sanitize(heading)}</h1>${contact ? `<p class="pitch-contact" data-pitch-field="contact">${sanitize(contact)}</p>` : ""}`;
}

function renderChart(s: Extract<Slide, { template: "chart" }>): string {
  const { heading, chart_type, series } = s.content;
  // Encode the payload as base64 JSON so a client-side hydration step
  // can mount a Recharts component without re-fetching.
  const payload = Buffer.from(
    JSON.stringify({ chart_type, series }),
    "utf8",
  ).toString("base64");
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><div class="pitch-chart" data-chart-slide data-chart-type="${attr(chart_type)}" data-payload="${attr(payload)}" data-pitch-field="series"></div>`;
}

function renderMermaid(s: Extract<Slide, { template: "mermaid" }>): string {
  const { heading, diagram_type, source } = s.content;
  // Mermaid plugin parses the body — it's text-only too, so escape rather
  // than sanitize (sanitize would mangle the diagram syntax).
  return `${heading ? `<h3 data-pitch-field="heading">${sanitize(heading)}</h3>` : ""}<pre class="mermaid" data-diagram-type="${attr(diagram_type)}" data-pitch-field="source">${escapeHtml(source)}</pre>`;
}

function imageTag(img: SlideImage | undefined): string {
  if (!img) return "";
  const url = safeUrl(img.url);
  if (!url) return "";
  return `<img src="${attr(url)}" alt="${attr(img.alt)}" loading="lazy">`;
}
