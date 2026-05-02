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

export type RenderMode = "embedded" | "present" | "standalone";

export interface RenderOpts {
  /** Standalone mode only — Reveal.js theme. Default: `black`. */
  theme?: string;
  /** Standalone mode only — set to `false` to skip the inline init script. */
  autoInit?: boolean;
  backgroundImageUrlBySlideIndex?: ReadonlyMap<number, string>;
  /**
   * Sub-issue #996 — when set, render only the slide at this 0-based
   * index in `deck.slides`. Out-of-range indices yield an empty deck
   * (zero slides) instead of throwing so a stale slide-rail tile cannot
   * 500 the server. The bg-URL map is filtered alongside.
   */
  slideIndex?: number;
  /**
   * Bug-fix 2026-04-28 — embedded/present mode initial slide index. The
   * editor canvas passes this so the iframe boots showing the slide the
   * user just clicked in the rail (instead of always restarting at 0).
   * The renderer also injects a `postMessage` listener so the parent can
   * navigate without rebuilding the iframe — see embedded init script.
   */
  initialSlideIndex?: number;
}

export interface ReadableColorTokens {
  background: string;
  text: string;
  muted: string;
  heading: string;
  accent: string;
  onPrimary: string;
  onAccent: string;
  surface: string;
  surfaceText: string;
  /**
   * Bug-fix (post-PR-#1041 walkthrough): foreground color for text that
   * sits on top of a background image. The renderer pairs this with a
   * deterministic dark scrim (see `.pitch-has-bg::before` in
   * {@link embeddedChromeStyles}) so legibility does not depend on the
   * image's average luminance — a brand "primary" cannot disappear on a
   * matching-tone image because the scrim guarantees enough contrast for
   * white text. Always `#ffffff` today; left as a token so future work
   * can derive it from sampled image luminance without churning callers.
   */
  onImage: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(parseHexColor(foreground));
  const bg = relativeLuminance(parseHexColor(background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export function buildReadableColorTokens(kit: BrandKit): ReadableColorTokens {
  const background = isHexColor(kit.secondaryColor) ? kit.secondaryColor : "#ffffff";
  const primary = isHexColor(kit.primaryColor) ? kit.primaryColor : "#111827";
  const accentRaw = isHexColor(kit.accentColor) ? kit.accentColor : "#2563eb";
  const text = readableTextColor(background);
  const muted = text === "#111827" ? "#4b5563" : "#e5e7eb";
  const heading = contrastRatio(primary, background) >= 4.5 ? primary : text;
  const accent = contrastRatio(accentRaw, background) >= 4.5 ? accentRaw : text;
  return {
    background,
    text,
    muted,
    heading,
    accent,
    onPrimary: readableTextColor(primary),
    onAccent: readableTextColor(accentRaw),
    surface: text === "#111827" ? "rgba(255,255,255,0.78)" : "rgba(255,255,255,0.92)",
    surfaceText: "#111827",
    // Pinned to white because it always rides on top of the dark scrim
    // emitted for `.pitch-has-bg` sections — see `embeddedChromeStyles`.
    onImage: "#ffffff",
  };
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

  // Sub-issue #996 — single-slide thumbnail filter. We slice the slide
  // array (and the bg-URL map) instead of mutating either input. An
  // out-of-range index becomes an empty deck so a stale slide id from the
  // rail does not 500 the server.
  let slidesToRender: readonly Slide[] = deck.slides;
  let bgMapToUse: ReadonlyMap<number, string> | undefined = bgMap;
  if (opts.slideIndex !== undefined) {
    const idx = opts.slideIndex;
    if (idx < 0 || idx >= deck.slides.length) {
      slidesToRender = [];
      bgMapToUse = undefined;
    } else {
      slidesToRender = [deck.slides[idx] as Slide];
      const url = bgMap?.get(idx);
      bgMapToUse = url ? new Map([[0, url]]) : undefined;
    }
  }

  const slidesHtml = slidesToRender
    .map((slide, index) => renderSlide(slide, bgMapToUse?.get(index)))
    .join("\n");
  const wrapperStyle = brandKitInlineStyle(brandKit);
  const footer = brandKit.footerText
    ? `<footer class="pitch-footer">${sanitize(brandKit.footerText)}</footer>`
    : "";
  const watermark = brandKit.watermarkUrl
    ? `<div class="pitch-watermark" aria-hidden="true" style="background-image:url(${attr(
        safeUrl(brandKit.watermarkUrl) ?? "",
      )})"></div>`
    : "";
  const logoTag = brandKitLogoTag(brandKit);

  const reveal = `<div class="reveal" data-deck-id="${attr(deck.id)}" data-aspect="${attr(
    deck.aspect_ratio,
  )}"><div class="slides">${slidesHtml}</div>${footer}${watermark}${logoTag}</div>`;

  // Pick a theme: caller-supplied wins for any mode (allowlist [a-z0-9-]).
  // Embedded/present default to `white` for a presentation-grade light
  // background that pairs well with the brand-color overrides; standalone
  // keeps the historical `black` default to avoid breaking PDF exports.
  const theme = opts.theme && /^[a-z0-9-]+$/i.test(opts.theme)
    ? opts.theme
    : mode === "standalone"
      ? "black"
      : "white";
  const autoInit = opts.autoInit !== false;

  if (mode === "embedded" || mode === "present") {
    // Sub-issue #997 — embedded/present preview is loaded inside an
    // `<iframe srcDoc=...>` (so it doesn't pollute the parent page's
    // styles). Reveal.js requires its own CSS + theme + init script to
    // actually lay out and scale slides; without those the page renders
    // as bare unstyled HTML (the bug reported on 2026-04-28). Emitting
    // a full HTML document here makes the iframe fully self-contained.
    //
    // The chrome `<style>` block stays — its rules layer on top of
    // reveal.css to apply brand colors at full saturation.
    //
    // Bug-fix 2026-04-28: navigate to `initialSlideIndex` post-init AND
    // install a `postMessage` listener so the parent canvas can drive
    // slide navigation without rebuilding the iframe (the rail click
    // handler simply postMessages `{type:"openzigs:navigate",index:N}`).
    // Origin check is intentionally lax (`*`) because we accept that the
    // iframe's origin equals the parent's (both served from
    // localhost:3000 / the admin host) and the message contract is
    // narrow — only an integer index is consumed.
    const initialIndex = Number.isInteger(opts.initialSlideIndex)
      ? Math.max(0, Math.min(opts.initialSlideIndex as number, slidesToRender.length - 1))
      : 0;
    const embeddedInit = autoInit
      ? `<script type="module">
import Reveal from "https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.esm.js";
const deck = new Reveal({ embedded: ${mode === "embedded" ? "true" : "false"}, hash: false, controls: ${mode === "present" ? "true" : "false"}, progress: ${mode === "present" ? "true" : "false"}, transition: "slide" });
await deck.initialize();
if (${initialIndex} > 0) { try { deck.slide(${initialIndex}); } catch {} }
window.addEventListener("message", (e) => {
  const data = e && e.data;
  if (!data || data.type !== "openzigs:navigate") return;
  const idx = Number(data.index);
  if (Number.isInteger(idx) && idx >= 0) { try { deck.slide(idx); } catch {} }
});
// Notify parent that the deck is ready so it can flush any queued
// navigation messages that arrived before initialize() resolved.
try { window.parent.postMessage({ type: "openzigs:reveal-ready" }, "*"); } catch {}
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
${brandKitFontsLink(brandKit)}
<style>${embeddedChromeStyles()}</style>
</head>
<body style="${wrapperStyle};margin:0;background:transparent;">
<div class="pitch-deck-wrap pitch-deck-wrap--${mode}" style="${wrapperStyle}">${reveal}</div>
${embeddedInit}
</body>
</html>`,
      slideCount: slidesToRender.length,
    };
  }

  // standalone mode — full HTML document
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
${brandKitFontsLink(brandKit)}
<style>${standaloneStyles()}</style>
</head>
<body style="${wrapperStyle}">
<div class="pitch-deck-wrap pitch-deck-wrap--standalone" style="${wrapperStyle}">${reveal}</div>
${initScript}
</body>
</html>`,
    slideCount: slidesToRender.length,
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
  // Issue #1007 — sanitize font family names tightly before they reach
  // the CSS variable. `escapeHtml` only protects HTML context; in CSS
  // context a hostile family name like `Inter"</style><script>...` would
  // still appear as a literal substring in the page source even if it
  // can't execute. Strip everything outside the safe character set.
  const safeFont = (raw: string): string =>
    String(raw ?? "").replace(/[^A-Za-z0-9 ,'-]/g, "").slice(0, 80);
  const tokens = buildReadableColorTokens(kit);
  return [
    `--pitch-primary:${kit.primaryColor}`,
    `--pitch-secondary:${tokens.background}`,
    `--pitch-accent:${kit.accentColor}`,
    `--pitch-text:${tokens.text}`,
    `--pitch-muted:${tokens.muted}`,
    `--pitch-heading:${tokens.heading}`,
    `--pitch-accent-readable:${tokens.accent}`,
    `--pitch-on-primary:${tokens.onPrimary}`,
    `--pitch-on-accent:${tokens.onAccent}`,
    `--pitch-surface:${tokens.surface}`,
    `--pitch-surface-text:${tokens.surfaceText}`,
    `--pitch-on-image:${tokens.onImage}`,
    `--pitch-font-heading:${safeFont(kit.fontHeading)}`,
    `--pitch-font-body:${safeFont(kit.fontBody)}`,
  ].join(";");
}

function isHexColor(input: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(input);
}

function parseHexColor(input: string): Rgb {
  if (!isHexColor(input)) return { r: 255, g: 255, b: 255 };
  return {
    r: Number.parseInt(input.slice(1, 3), 16),
    g: Number.parseInt(input.slice(3, 5), 16),
    b: Number.parseInt(input.slice(5, 7), 16),
  };
}

function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function readableTextColor(background: string): "#111827" | "#ffffff" {
  return contrastRatio("#111827", background) >= contrastRatio("#ffffff", background)
    ? "#111827"
    : "#ffffff";
}

/**
 * Issue #1007 — emit a Google Fonts <link> for the brand kit's heading
 * and body font families. Without this the embedded preview falls back
 * to the host's default serif (the `Times`-looking screenshot reported
 * on 2026-04-28). Google Fonts gracefully ignores unknown families
 * (returns 200 with empty CSS) so this is safe even when the kit's
 * fonts are bespoke / self-hosted.
 *
 * Family names are filtered to a strict allowlist (letters, digits,
 * spaces, hyphens) before being URL-encoded — no user-supplied value
 * reaches the URL without sanitization.
 */
function brandKitFontsLink(kit: BrandKit): string {
  const families = new Set<string>();
  for (const f of [kit.fontHeading, kit.fontBody]) {
    if (!f) continue;
    const cleaned = String(f)
      .trim()
      // Strip any CSS fallback list — keep the first family only.
      .split(",")[0]
      ?.replace(/["']/g, "")
      .trim();
    if (!cleaned) continue;
    if (!/^[A-Za-z0-9 -]+$/.test(cleaned)) continue;
    families.add(cleaned);
  }
  if (families.size === 0) return "";
  const params = Array.from(families)
    .map(
      (name) =>
        `family=${encodeURIComponent(name)}:wght@400;600;700`,
    )
    .join("&");
  const href = `https://fonts.googleapis.com/css2?${params}&display=swap`;
  return [
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="${href}">`,
  ].join("");
}

/**
 * Issue #1007 — convert a free-text body string (as the AI emits it for
 * `two_column` left/right) into structured HTML. If the text contains
 * line-prefixed bullet markers (`•`, `-`, `*`, `–`) on ≥2 lines, render
 * a `<ul>`; otherwise wrap newline-separated paragraphs in `<p>`. Plain
 * single-line input becomes a single `<p>` (no list, no wrapping).
 *
 * The returned HTML is then sanitized through `sanitizeRichText` like
 * every other rendered field — `<ul>`/`<li>`/`<p>` are in the allowlist.
 */
export function renderRichBody(input: string): string {
  const text = String(input ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Recognise lines that start with a bullet glyph or dash (followed by
  // optional whitespace). Multiple-character glyphs (`->`, `=>`) are
  // intentionally NOT matched — those usually mean something else.
  const bulletPattern = /^[•\-*\u2013\u2014]\s*/;
  const bulletLines = lines.filter((l) => bulletPattern.test(l));
  if (lines.length >= 2 && bulletLines.length >= 2) {
    const items = lines
      .map((l) => l.replace(bulletPattern, "").trim())
      .filter((l) => l.length > 0)
      .map((l) => `<li>${sanitize(l)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  if (lines.length > 1) {
    return lines.map((l) => `<p>${sanitize(l)}</p>`).join("");
  }
  // Single-line plain prose — sanitize handles inline tags.
  return sanitize(text);
}

function brandKitLogoTag(kit: BrandKit): string {
  const url = safeUrl(kit.logoUrl);
  if (!url) return "";
  return `<img class="pitch-logo" src="${attr(url)}" alt="${attr(kit.name)} logo">`;
}

function standaloneStyles(): string {
  // Issue #1007 — share the embedded chrome styles in standalone exports
  // (HTML / PDF) so a shared deck looks identical to the in-app preview.
  // The wrapper class is `pitch-deck-wrap` (no `--embedded` modifier) so
  // the layout rules that need full viewport (display:flex, height:100vh)
  // are intentionally NOT inherited — Reveal handles its own sizing in
  // standalone. We therefore re-emit only the type/spacing/component
  // rules that don't depend on the embedded chrome wrapper.
  return embeddedChromeStyles();
}

/**
 * Sub-issue #997 — chrome for the in-app embedded preview.
 *
 * The wrapper class is `pitch-deck-wrap--embedded` (or `--present`); the
 * styles below intentionally apply to BOTH so the preview and the
 * fullscreen present-mode renderer pick up the same brand chrome and
 * brand colors at full saturation. The Reveal.js dark default desaturates
 * heading colors via `text-shadow` + `--r-heading-color`; we override the
 * Reveal CSS variables with the brand kit's primary/secondary/accent so
 * deck imagery feels on-brand.
 *
 * The block is a static string literal — no user-supplied value is
 * concatenated in, so this introduces no XSS surface beyond the existing
 * `<style>` tag emitted in standalone mode.
 */
function embeddedChromeStyles(): string {
  // Issue #1007 — design polish. Apply a real type scale, generous
  // slide padding, accent-bar signature, equal-width two-column layout,
  // and KPI/quote/title pattern styling. The block stays a static
  // string literal so no user value reaches CSS context.
  return `
/* Bug-fix 2026-04-28 — fill the iframe viewport so Reveal doesn't
   collapse to ~84px and scale down to 0.2x. */
html, body { height: 100%; margin: 0; padding: 0; }
.pitch-deck-wrap { box-sizing: border-box; padding: 0; background: transparent; }
.pitch-deck-wrap--embedded,
.pitch-deck-wrap--present {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
}
.pitch-deck-wrap--embedded .reveal,
.pitch-deck-wrap--present .reveal,
.pitch-deck-wrap--standalone .reveal {
  border-radius: 12px;
  background: var(--pitch-secondary, #f8fafc);
  position: relative;
  overflow: hidden;
}
.pitch-deck-wrap--embedded .reveal,
.pitch-deck-wrap--present .reveal {
  flex: 1 1 auto;
  min-height: 0;
  box-shadow: 0 12px 40px rgba(0,0,0,0.18);
}
/* Accent signature: a 6px brand bar across the top of every deck. */
.pitch-deck-wrap--embedded .reveal::before,
.pitch-deck-wrap--present .reveal::before,
.pitch-deck-wrap--standalone .reveal::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 6px;
  background: linear-gradient(90deg, var(--pitch-primary), var(--pitch-accent));
  z-index: 5;
}
.pitch-deck-wrap .reveal {
  --r-heading-color: var(--pitch-heading);
  --r-link-color: var(--pitch-accent-readable);
  --r-selection-background-color: var(--pitch-accent-readable);
  --r-main-color: var(--pitch-text);
  --r-main-font-size: 28px;
  --r-heading-font-weight: 700;
  --r-heading-line-height: 1.15;
  --r-block-margin: 24px;
  font-family: var(--pitch-font-body, "Inter", system-ui, sans-serif);
  color: var(--pitch-text);
}
/* Generous slide padding (~7% of slide). Reveal scales the .slides
   container, so padding works against the logical 960×700 viewport. */
.pitch-deck-wrap .reveal .slides > section,
.pitch-deck-wrap .reveal .slides > section > section {
  box-sizing: border-box;
  padding: 64px 72px 88px 72px;
  text-align: left;
}
.pitch-deck-wrap .reveal h1,
.pitch-deck-wrap .reveal h2,
.pitch-deck-wrap .reveal h3,
.pitch-deck-wrap .reveal h4 {
  font-family: var(--pitch-font-heading, "Inter", system-ui, sans-serif);
  color: var(--pitch-heading);
  text-shadow: none;
  text-transform: none;
  letter-spacing: 0;
  line-height: 1.15;
  margin-top: 0;
}
.pitch-deck-wrap .reveal h1 { font-size: 3.2em; margin-bottom: 0.4em; }
.pitch-deck-wrap .reveal h2 { font-size: 2.2em; margin-bottom: 0.5em; }
.pitch-deck-wrap .reveal h3 { font-size: 1.5em; margin-bottom: 0.4em; }
.pitch-deck-wrap .reveal p,
.pitch-deck-wrap .reveal li {
  line-height: 1.5;
  font-size: 0.95em;
}
.pitch-deck-wrap .reveal ul {
  list-style: none;
  padding-left: 0;
  margin: 0;
}
.pitch-deck-wrap .reveal ul > li {
  position: relative;
  padding: 0.25em 0 0.25em 1.4em;
}
.pitch-deck-wrap .reveal ul > li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.75em;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--pitch-accent-readable);
}
.pitch-deck-wrap .reveal ol { padding-left: 1.4em; }
.pitch-deck-wrap .reveal .pitch-accent { color: var(--pitch-accent-readable); }
/* ── Title slide pattern ─────────────────────────────────────── */
.pitch-deck-wrap .reveal .slides > section.pitch-tpl-title {
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.pitch-deck-wrap .reveal .pitch-eyebrow {
  display: inline-block;
  font-size: 0.7em;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pitch-accent-readable);
  margin-bottom: 1.2em;
  padding-bottom: 0.6em;
  border-bottom: 3px solid var(--pitch-accent-readable);
  align-self: flex-start;
}
.pitch-deck-wrap .reveal .slides > section.pitch-tpl-title h1 {
  font-size: 4em;
  line-height: 1.05;
}
.pitch-deck-wrap .reveal .slides > section.pitch-tpl-title h3 {
  font-size: 1.4em;
  font-weight: 400;
  color: var(--pitch-muted);
  margin-top: 0.5em;
}
/* ── Section divider ─────────────────────────────────────────── */
.pitch-deck-wrap .reveal .pitch-section-num {
  font-size: 1.2em;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin-bottom: 0.5em;
}
.pitch-deck-wrap .reveal .slides > section.pitch-tpl-section_divider h2 {
  font-size: 3.2em;
}
/* ── Two-column layout ───────────────────────────────────────── */
.pitch-deck-wrap .reveal .pitch-twocol {
  display: flex;
  gap: 3rem;
  align-items: flex-start;
  margin-top: 1rem;
}
.pitch-deck-wrap .reveal .pitch-twocol-col {
  flex: 1 1 0;
  min-width: 0;
}
.pitch-deck-wrap .reveal .pitch-twocol-col img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  margin-top: 1rem;
}
/* ── Quote ───────────────────────────────────────────────────── */
.pitch-deck-wrap .reveal blockquote {
  background: transparent;
  box-shadow: none;
  border-left: 4px solid var(--pitch-accent-readable);
  padding: 0.5em 1em;
  font-size: 1.4em;
  font-style: italic;
  color: var(--pitch-text);
  width: 100%;
  margin: 0 0 1em 0;
}
.pitch-deck-wrap .reveal .pitch-attribution {
  text-align: right;
  font-size: 0.9em;
  color: var(--pitch-muted);
}
/* ── Stats / KPIs ────────────────────────────────────────────── */
.pitch-deck-wrap .reveal .pitch-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1.5rem;
  margin-top: 2rem;
}
.pitch-deck-wrap .reveal .pitch-kpi {
  display: block;
  padding: 1.25rem 1.5rem;
  margin: 0;
  border: none;
  border-top: 4px solid var(--pitch-accent-readable);
  border-radius: 4px;
  background: var(--pitch-surface);
  color: var(--pitch-surface-text);
  text-align: left;
}
.pitch-deck-wrap .reveal .pitch-kpi-value {
  font-family: var(--pitch-font-heading, inherit);
  font-size: 2.6em;
  font-weight: 700;
  line-height: 1;
  color: var(--pitch-heading);
}
.pitch-deck-wrap .reveal .pitch-kpi-label {
  font-size: 0.85em;
  color: var(--pitch-muted);
  margin-top: 0.5em;
}
.pitch-deck-wrap .reveal .pitch-kpi-delta {
  font-size: 0.9em;
  font-weight: 600;
  margin-top: 0.3em;
}
/* ── Image caption ───────────────────────────────────────────── */
.pitch-deck-wrap .reveal .slides > section.pitch-tpl-image_caption img {
  max-width: 70%;
  max-height: 60vh;
  border-radius: 8px;
  display: block;
  margin: 1em auto;
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);
}
.pitch-deck-wrap .reveal .pitch-caption {
  text-align: center;
  font-size: 0.95em;
  color: var(--pitch-muted);
  font-style: italic;
}
/* ── Full-bleed image ────────────────────────────────────────── */
.pitch-deck-wrap .reveal .slides > section.pitch-tpl-full_bleed {
  padding: 0;
}
.pitch-deck-wrap .reveal .pitch-fullbleed {
  position: absolute;
  inset: 0;
}
.pitch-deck-wrap .reveal .pitch-fullbleed img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pitch-deck-wrap .reveal .pitch-overlay {
  position: absolute;
  bottom: 10%;
  left: 8%;
  right: 8%;
  padding: 1.5rem;
  background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%);
  color: #fff;
  font-size: 1.6em;
  font-weight: 700;
  border-radius: 6px;
}
/* ── Tables ──────────────────────────────────────────────────── */
.pitch-deck-wrap .reveal table {
  border-collapse: collapse;
  width: 100%;
  margin-top: 1rem;
  font-size: 0.85em;
}
.pitch-deck-wrap .reveal table th {
  background: var(--pitch-primary);
  color: var(--pitch-on-primary);
  padding: 0.75em 1em;
  text-align: left;
  font-weight: 600;
}
.pitch-deck-wrap .reveal table td {
  padding: 0.6em 1em;
  border-bottom: 1px solid #e5e7eb;
  border-top: none;
  border-left: none;
  border-right: none;
}
.pitch-deck-wrap .reveal table tr:nth-child(even) td {
  background: rgba(0,0,0,0.02);
}
/* ── Timeline ────────────────────────────────────────────────── */
.pitch-deck-wrap .reveal ol.pitch-timeline {
  list-style: none;
  padding-left: 1rem;
  margin-top: 1.5rem;
  border-left: 3px solid var(--pitch-accent-readable);
}
.pitch-deck-wrap .reveal ol.pitch-timeline > li {
  padding: 0.4em 0 0.4em 1rem;
  margin-bottom: 0.2em;
  position: relative;
}
.pitch-deck-wrap .reveal ol.pitch-timeline > li::before {
  content: "";
  position: absolute;
  left: -1.55rem;
  top: 0.85em;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--pitch-accent-readable);
  border: 3px solid var(--pitch-secondary, #f8fafc);
}
/* ── Footer / logo / watermark ───────────────────────────────── */
.pitch-deck-wrap .reveal .pitch-footer {
  position: absolute;
  bottom: 16px;
  left: 72px;
  right: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pitch-muted);
  z-index: 4;
}
.pitch-deck-wrap .reveal .pitch-logo {
  position: absolute;
  top: 20px;
  right: 24px;
  max-height: 28px;
  opacity: 0.9;
  z-index: 4;
}
.pitch-deck-wrap .reveal .pitch-watermark {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-position: center;
  background-size: 40%;
  opacity: 0.04;
  pointer-events: none;
  filter: grayscale(1);
}
/* When a slide has a background image we add the .pitch-has-bg class
   in sectionAttributes (issue #1007) so we can give the heading text a
   white color and drop shadow without depending on Reveal's data-attr.

   Bug-fix (post-PR-#1041 walkthrough): the previous rule only forced
   white on h1/h2/h3, leaving eyebrows, paragraphs, list items, captions
   and the title-template subtitle to inherit the brand kit's primary
   or muted color, which on a "Dark Tech" kit collapses to near-black
   on a near-black background image. We now:
     1. Layer a deterministic dark scrim (::before pseudo) BETWEEN the
        background image and the slide content so legibility never
        depends on the image's average luminance.
     2. Force every text-bearing element to a high-contrast color via
        --pitch-on-image (always white today; tokenised so future
        per-image luminance sampling can override it without touching
        the CSS).
     3. Apply a soft drop shadow as belt-and-suspenders for the rare
        case where the scrim is tinted out by a custom theme override.
   The scrim is positioned absolute / inset:0 / z-index:0 and the
   section children are lifted to z-index:1 so they sit on top. Reveal
   places the actual background-image in a separate .slide-background
   wrapper outside .slides > section, so the scrim does not occlude
   the image, it dims it. */
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg {
  color: var(--pitch-on-image, #ffffff);
  position: relative;
}
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, rgba(0,0,0,0.55) 100%);
  z-index: 0;
  pointer-events: none;
}
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg > * {
  position: relative;
  z-index: 1;
}
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg h1,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg h2,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg h3,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg h4 {
  color: var(--pitch-on-image, #ffffff);
  text-shadow: 0 2px 12px rgba(0,0,0,0.5);
}
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg p,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg li,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg blockquote,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg .pitch-caption,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg .pitch-attribution {
  color: var(--pitch-on-image, #ffffff);
  text-shadow: 0 1px 6px rgba(0,0,0,0.55);
}
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg .pitch-eyebrow,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg .pitch-accent,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg .pitch-section-num {
  color: var(--pitch-on-image, #ffffff);
  border-bottom-color: rgba(255,255,255,0.6);
  text-shadow: 0 1px 6px rgba(0,0,0,0.55);
}
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
  // Issue #1007 — also emit a pitch-tpl-{template} class so CSS can
  // target template-specific patterns (e.g. centered title slide)
  // through the class hook (kept distinct from the data attribute so
  // the chrome stylesheet does not duplicate that literal substring).
  const parts: string[] = [
    `class="pitch-tpl-${attr(slide.template)}"`,
    `data-template="${attr(slide.template)}"`,
  ];
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
      // Issue #1007 — swap the class so the chrome CSS can apply a dark
      // overlay + white heading colors without using a `[data-...]`
      // attribute selector (see comment in sectionAttributes).
      parts[0] = `class="pitch-tpl-${attr(slide.template)} pitch-has-bg"`;
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
  // Issue #1007 — promote bullet-prefixed text to actual <ul><li> markup.
  // Without this the AI's `•`-prefixed lines render as a wall of inline
  // text (the regression captured in the 2026-04-28 screenshot).
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><div class="pitch-twocol"><div class="pitch-twocol-col" data-pitch-field="left">${renderRichBody(left)}${imageTag(left_image)}</div><div class="pitch-twocol-col" data-pitch-field="right">${renderRichBody(right)}${imageTag(right_image)}</div></div>`;
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
