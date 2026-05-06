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

  // Sub-issue #1051 — per-slide branding chrome (logo + slide-number
  // indicator + footer/watermark overrides) is rendered INSIDE each
  // <section> so a slide can hide or relocate the logo independently.
  // The deck-level `<footer>` / `<.pitch-watermark>` remain as fallbacks
  // for slides that did not opt out.
  const totalSlides = deck.slides.length;
  const slidesHtml = slidesToRender
    .map((slide, index) => {
      // When `slideIndex` filtered the array, preserve the deck position
      // for the slide-number badge (otherwise filtered single-slide
      // thumbnails would always read "1 / 1").
      const deckPosition =
        opts.slideIndex !== undefined ? opts.slideIndex + 1 : index + 1;
      return renderSlide(
        slide,
        bgMapToUse?.get(index),
        brandKit,
        deckPosition,
        totalSlides,
        deck,
      );
    })
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

  const reveal = `<div class="reveal" data-deck-id="${attr(deck.id)}" data-aspect="${attr(
    deck.aspect_ratio,
  )}"><div class="slides">${slidesHtml}</div>${footer}${watermark}</div>`;

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
    // Reveal config — explicit 1920×1080 logical viewport matches the
    // PDF export size (decktape `--size 1920x1080`) and gives long
    // headings (e.g. "OpenZigs: Platform Overview & Operational
    // Playbook") enough horizontal real estate to wrap on two lines
    // instead of clipping descenders against the slide bottom. Reveal
    // still scales the slide to fit whatever physical container the
    // iframe occupies, so the embedded preview, the present canvas,
    // and the headless-Chromium PDF render all share the same logical
    // layout. Margin 0.04 keeps slide content off the brand's accent
    // bar (6px gradient at the top of every deck).
    const embeddedInit = autoInit
      ? `<script type="module">
import Reveal from "https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.esm.js";
const deck = new Reveal({ embedded: ${mode === "embedded" ? "true" : "false"}, hash: false, controls: ${mode === "present" ? "true" : "false"}, progress: ${mode === "present" ? "true" : "false"}, transition: "slide", width: 1920, height: 1080, margin: 0.04 });
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

  // standalone mode — full HTML document.
  //
  // Loading + API-shape constraints for the PDF exporter:
  //
  //   - Decktape's bundled `reveal` plugin probes for a globally-reachable
  //     `Reveal` constructor BEFORE the document's `DOMContentLoaded`
  //     event. `<script type="module">` is deferred until after parsing,
  //     so the ESM bundle (which the embedded preview path uses) races
  //     decktape and the plugin probe fails with "Unable to activate the
  //     Reveal JS DeckTape plugin". The classic UMD bundle installs
  //     `window.Reveal` synchronously while the document is still
  //     parsing, which is the timing decktape (and any other static
  //     consumer of standalone HTML) expects.
  //
  //   - Decktape's plugin shape is older than Reveal.js 5: it pivots on
  //     `Reveal.availableFragments` for its compat check and on the
  //     legacy STATIC API surface (`Reveal.next()`, `Reveal.getIndices()`,
  //     `Reveal.getTotalSlides()`, …) for navigation. Reveal 5 retains
  //     those static helpers when initialised via the global `Reveal`
  //     constructor, but `availableFragments` was renamed in newer
  //     releases — we keep a defensive no-op shim so the gate stays
  //     green regardless of which patch level the CDN serves.
  //
  // `hash: false` keeps file-loaded decks from polluting the URL bar.
  const initScript = autoInit
    ? `<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script>
(function () {
  if (typeof Reveal === "undefined") return;
  if (typeof Reveal.availableFragments !== "function") {
    Reveal.availableFragments = function () { return { prev: 0, next: 0 }; };
  }
  // Match the PDF/decktape size (1920×1080) so the standalone deck
  // shares the same logical layout as the embedded preview. Without
  // this Reveal falls back to 960×700 and long titles like "OpenZigs:
  // Platform Overview & Operational Playbook" overflow the bottom of
  // the slide.
  Reveal.initialize({ hash: false, controls: true, progress: true, transition: "slide", width: 1920, height: 1080, margin: 0.04 });
})();
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
  // Single-line plain prose — sanitize handles inline tags. Wrap in
  // `<p>` so the property-editor rich-text scoping rules (e.g. white text
  // + drop shadow on `.pitch-has-bg` text-heavy templates) actually
  // target a block-level element instead of a bare text node — without
  // the wrapper, the colour overrides slid off the text and it
  // disappeared on coloured backgrounds (Issue #4: two_column invisible).
  return `<p>${sanitize(text)}</p>`;
}

/**
 * Resolve the corner where a slide's logo should render. Honors:
 *   1. Per-slide explicit `branding.logoPlacement` (highest priority)
 *   2. Per-slide `branding.hideLogo = true` → "none"
 *   3. Default-hidden templates (`title`, `qa`) per Q1 epic decision
 *   4. Brand-kit `defaultLogoPlacement`
 *   5. Hard fallback `bottom-right`
 *
 * Returns `"none"` when the logo must not render.
 */
export function resolveLogoPlacement(
  slide: Slide,
  kit: BrandKit,
): "top-left" | "top-right" | "bottom-left" | "bottom-right" | "none" {
  const branding = slide.branding;
  if (branding?.hideLogo) return "none";
  if (branding?.logoPlacement) return branding.logoPlacement;
  // Q1: hide on title / qa unless explicitly placed by the slide.
  if (slide.template === "title" || slide.template === "qa") return "none";
  return kit.defaultLogoPlacement ?? "bottom-right";
}

/**
 * Resolve the corner where the slide-number indicator should render.
 * Auto-flips to a free corner so it never collides with the logo.
 * Returns `null` when slide numbers are disabled on the kit.
 */
export function resolveSlideNumberPlacement(
  slide: Slide,
  kit: BrandKit,
): "top-left" | "top-right" | "bottom-left" | "bottom-right" | null {
  if (!kit.showSlideNumbers) return null;
  const logoCorner = resolveLogoPlacement(slide, kit);
  if (logoCorner === "none") return "bottom-right";
  // Diagonal opposite for maximum separation.
  switch (logoCorner) {
    case "top-left":
      return "bottom-right";
    case "top-right":
      return "bottom-left";
    case "bottom-left":
      return "top-right";
    case "bottom-right":
    default:
      return "top-left";
  }
}

function slideLogoTag(slide: Slide, kit: BrandKit): string {
  const placement = resolveLogoPlacement(slide, kit);
  if (placement === "none") return "";
  const url = safeUrl(kit.logoUrl);
  if (!url) return "";
  return `<img class="pitch-logo pitch-logo-${placement}" src="${attr(url)}" alt="${attr(kit.name)} logo">`;
}

function slideNumberTag(slide: Slide, kit: BrandKit, position: number, total: number): string {
  const placement = resolveSlideNumberPlacement(slide, kit);
  if (!placement) return "";
  return `<div class="pitch-slide-number pitch-slide-number-${placement}" aria-hidden="true">${escapeHtml(String(position))} / ${escapeHtml(String(total))}</div>`;
}

function slideFooterOverrideTag(slide: Slide): string {
  const text = slide.branding?.footerOverride;
  if (!text) return "";
  return `<footer class="pitch-footer pitch-footer--override">${sanitize(text)}</footer>`;
}

function slideWatermarkOverrideTag(slide: Slide): string {
  const raw = slide.branding?.watermarkOverride;
  if (!raw) return "";
  const url = safeUrl(raw);
  if (!url) return "";
  return `<div class="pitch-watermark pitch-watermark--override" aria-hidden="true" style="background-image:url(${attr(url)})"></div>`;
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
   collapse to ~84px and scale down to 0.2x.

   Bug-fix 2026-05-05 — the standalone modifier was missing from the
   viewport-fill rule, so when the deck was opened as a downloaded HTML
   file or rendered through a print-to-PDF pipeline, pitch-deck-wrap
   collapsed to its content height (0px), .reveal inherited 0 height,
   and Reveal's auto-scale algorithm shrank the active slide to ~20%
   and translated it off the viewport. The exported standalone deck
   appeared as a black page. We now apply the same viewport-fill (using
   flex column + 100vh) to all three modifiers so Reveal's sizing
   algorithm has a real container regardless of how the deck is
   consumed downstream. */
html, body { height: 100%; margin: 0; padding: 0; }
.pitch-deck-wrap { box-sizing: border-box; padding: 0; background: transparent; }
.pitch-deck-wrap--embedded,
.pitch-deck-wrap--present,
.pitch-deck-wrap--standalone {
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
  flex: 1 1 auto;
  min-height: 0;
}
.pitch-deck-wrap--embedded .reveal,
.pitch-deck-wrap--present .reveal {
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
  max-height: 28px;
  opacity: 0.9;
  z-index: 4;
}
/* Sub-issue #1051 \u2014 per-slide logo placement (4 corners). */
.pitch-deck-wrap .reveal .pitch-logo-top-left { top: 20px; left: 24px; }
.pitch-deck-wrap .reveal .pitch-logo-top-right { top: 20px; right: 24px; }
.pitch-deck-wrap .reveal .pitch-logo-bottom-left { bottom: 20px; left: 24px; }
.pitch-deck-wrap .reveal .pitch-logo-bottom-right { bottom: 20px; right: 24px; }
/* Sub-issue #1047 \u2014 slide-number indicator. */
.pitch-deck-wrap .reveal .pitch-slide-number {
  position: absolute;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--pitch-muted);
  z-index: 4;
  padding: 2px 6px;
  background: rgba(255,255,255,0.6);
  border-radius: 4px;
}
.pitch-deck-wrap .reveal .pitch-slide-number-top-left { top: 20px; left: 24px; }
.pitch-deck-wrap .reveal .pitch-slide-number-top-right { top: 20px; right: 24px; }
.pitch-deck-wrap .reveal .pitch-slide-number-bottom-left { bottom: 20px; left: 24px; }
.pitch-deck-wrap .reveal .pitch-slide-number-bottom-right { bottom: 20px; right: 24px; }
.pitch-deck-wrap .reveal .pitch-footer--override {
  position: absolute;
  bottom: 16px;
  left: 72px;
  right: 72px;
  text-align: center;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pitch-muted);
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
   the image, it dims it.

   IMPORTANT (post-PR-#1044 walkthrough Bug #3): do NOT add
   'position: relative' to '.slides > section.pitch-has-bg'. Reveal.js
   sets 'position: absolute' on every '.slides > section' and toggles
   'display:block' on past/future sections to drive transitions; an
   override here makes inactive sections stack vertically and pushes
   the active slide hundreds of pixels offscreen. Reveal already gives
   the active section its own positioning context (absolute + 3D
   transforms), which is enough for the absolutely-positioned '::before'
   scrim to anchor correctly. */
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg {
  color: var(--pitch-on-image, #ffffff);
}
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg::before {
  content: "";
  position: absolute;
  inset: 0;
  /* Issue (2026-05): replaced the gradient (which had a weak 0.25
     middle band that let backgrounds bleed through long body copy)
     with a uniform 0.55 scrim. Stronger, predictable contrast for
     every text-heavy template. */
  background: rgba(0,0,0,0.55);
  z-index: 0;
  pointer-events: none;
}
/* Issue #4 (revised PR #1044 walkthrough Bug #3): descendants need to
   live ABOVE the scrim, but the previous rule applied
   'position: relative' to *every* descendant (including Reveal's own
   absolutely-positioned wrappers), which collided with Reveal's
   layout and caused TWO_COLUMN/BULLET_LIST content to render at the
   wrong offset on slide 2+. 'z-index' alone is enough here because the
   scrim is a sibling pseudo at 'z-index: 0' — children sit on top of
   it via document order without needing their own positioned ancestor.
   We keep 'position: relative' only on direct children so the column
   flex layout still establishes a stacking context above the scrim. */
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg * {
  z-index: 1;
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
/* Issue #4: text-heavy templates that paired a background image with
   long-form body copy were rendering the body in the theme's default
   foreground colour, which often matched the background image and
   vanished. Force white + drop-shadow on EVERY descendant of these
   templates when a background is active so the content reads cleanly
   over any image. Cascades through nested wrappers (columns, list
   items, paragraphs, spans). */
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-two_column,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-two_column *,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-bullet_list,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-bullet_list *,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-image_caption,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-image_caption *,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-quote,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-quote *,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-qa,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-qa * {
  color: #ffffff !important;
  text-shadow: 0 1px 6px rgba(0,0,0,0.7);
}
/* Optional translucent dark surface card behind the column content of
   text-heavy templates with a background image. Pure visual polish —
   keeps body copy readable when the background image has high-contrast
   detail (faces, foliage, etc.) instead of relying on text-shadow alone. */
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-two_column .pitch-twocol-col,
.pitch-deck-wrap .reveal .slides > section.pitch-has-bg.pitch-tpl-bullet_list ul {
  background: rgba(0,0,0,0.28);
  border-radius: 12px;
  padding: 18px 22px;
}

/* ── Sub-issue #1046 — Pricing Table + Big Number ───────────────── */
.pitch-deck-wrap .reveal .pitch-pricing-grid {
  display: grid;
  grid-template-columns: repeat(var(--pitch-pricing-cols, 3), minmax(0, 1fr));
  gap: 16px;
  margin: 24px auto;
  max-width: 1100px;
}
.pitch-deck-wrap .reveal .pitch-pricing-grid--2 { --pitch-pricing-cols: 2; }
.pitch-deck-wrap .reveal .pitch-pricing-grid--3 { --pitch-pricing-cols: 3; }
.pitch-deck-wrap .reveal .pitch-pricing-grid--4 { --pitch-pricing-cols: 4; }
.pitch-deck-wrap .reveal .pitch-pricing-tier {
  border: 1px solid rgba(0,0,0,0.15);
  border-radius: 12px;
  padding: 18px 16px;
  background: rgba(255,255,255,0.6);
  text-align: left;
  display: flex;
  flex-direction: column;
}
.pitch-deck-wrap .reveal .pitch-pricing-tier--highlighted {
  border-color: var(--pitch-accent);
  border-width: 2px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.12);
  transform: translateY(-4px);
}
.pitch-deck-wrap .reveal .pitch-pricing-name { margin: 0 0 6px; font-size: 1.05em; }
.pitch-deck-wrap .reveal .pitch-pricing-price { font-size: 1.6em; font-weight: 700; margin-bottom: 10px; }
.pitch-deck-wrap .reveal .pitch-pricing-period { font-size: 0.5em; opacity: 0.7; margin-left: 4px; }
.pitch-deck-wrap .reveal .pitch-pricing-features { list-style: none; padding: 0; margin: 0 0 12px; font-size: 0.85em; }
.pitch-deck-wrap .reveal .pitch-pricing-features li { padding: 4px 0; border-bottom: 1px dashed rgba(0,0,0,0.08); }
.pitch-deck-wrap .reveal .pitch-pricing-cta { font-weight: 600; margin-top: auto; padding-top: 8px; }
.pitch-deck-wrap .reveal .pitch-pricing-footnote { font-size: 0.7em; opacity: 0.7; text-align: center; margin-top: 8px; }

.pitch-deck-wrap .reveal .pitch-bignum { text-align: center; padding: 40px 20px; }
.pitch-deck-wrap .reveal .pitch-bignum-value { font-size: 6em; font-weight: 800; line-height: 1; }
.pitch-deck-wrap .reveal .pitch-bignum-label { font-size: 1.4em; font-weight: 500; margin-top: 8px; }
.pitch-deck-wrap .reveal .pitch-bignum-trend { display: inline-flex; gap: 6px; align-items: center; margin-top: 14px; padding: 4px 12px; border-radius: 999px; font-size: 0.7em; }
.pitch-deck-wrap .reveal .pitch-bignum-trend--up { background: rgba(34,197,94,0.15); color: #15803d; }
.pitch-deck-wrap .reveal .pitch-bignum-trend--down { background: rgba(239,68,68,0.15); color: #b91c1c; }
.pitch-deck-wrap .reveal .pitch-bignum-trend--flat { background: rgba(100,116,139,0.15); color: #475569; }
.pitch-deck-wrap .reveal .pitch-bignum-support { margin-top: 18px; max-width: 720px; margin-left: auto; margin-right: auto; opacity: 0.85; }

/* ── Sub-issue #1049 — Team Grid + Logo Grid ────────────────────── */
.pitch-deck-wrap .reveal .pitch-team-grid {
  display: grid;
  gap: 16px;
  margin: 16px auto;
  max-width: 1100px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
.pitch-deck-wrap .reveal .pitch-team-grid--small { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.pitch-deck-wrap .reveal .pitch-team-grid--large { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.pitch-deck-wrap .reveal .pitch-team-card {
  text-align: center;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255,255,255,0.5);
}
.pitch-deck-wrap .reveal .pitch-team-photo {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  object-fit: cover;
  margin: 0 auto 10px;
  display: block;
}
.pitch-deck-wrap .reveal .pitch-team-photo--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--pitch-secondary, #ddd);
  color: var(--pitch-primary, #333);
  font-weight: 700;
}
.pitch-deck-wrap .reveal .pitch-team-name { margin: 0; font-size: 1em; }
.pitch-deck-wrap .reveal .pitch-team-role { font-size: 0.75em; opacity: 0.75; margin-bottom: 6px; }
.pitch-deck-wrap .reveal .pitch-team-bio { font-size: 0.7em; opacity: 0.85; line-height: 1.35; }
.pitch-deck-wrap .reveal .pitch-team-links { margin-top: 6px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.pitch-deck-wrap .reveal .pitch-team-link { font-size: 0.7em; color: var(--pitch-accent); }

.pitch-deck-wrap .reveal .pitch-logo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 18px;
  margin: 16px auto;
  max-width: 1100px;
  align-items: center;
  justify-items: center;
}
.pitch-deck-wrap .reveal .pitch-logo-grid img {
  max-height: 56px;
  max-width: 100%;
  object-fit: contain;
}
.pitch-deck-wrap .reveal .pitch-logo-grid--grayscale img {
  filter: grayscale(100%);
  opacity: 0.7;
  transition: filter 200ms, opacity 200ms;
}
.pitch-deck-wrap .reveal .pitch-logo-grid--grayscale .pitch-logo-cell:hover img {
  filter: grayscale(0%);
  opacity: 1;
}
.pitch-deck-wrap .reveal .pitch-logo-grid-caption { text-align: center; font-size: 0.75em; opacity: 0.75; }

/* ── Sub-issue #1052 — Roadmap + Agenda ─────────────────────────── */
.pitch-deck-wrap .reveal .pitch-roadmap { width: 100%; border-collapse: separate; border-spacing: 6px; }
.pitch-deck-wrap .reveal .pitch-roadmap th { background: rgba(0,0,0,0.04); padding: 6px 10px; text-align: left; font-weight: 600; }
.pitch-deck-wrap .reveal .pitch-roadmap td { vertical-align: top; padding: 6px; background: rgba(255,255,255,0.5); border-radius: 8px; }
.pitch-deck-wrap .reveal .pitch-roadmap-track { background: var(--pitch-primary); color: #fff; border-radius: 8px; }
.pitch-deck-wrap .reveal .pitch-roadmap-cell { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.pitch-deck-wrap .reveal .pitch-roadmap-item { padding: 4px 8px; border-radius: 6px; font-size: 0.75em; background: rgba(0,0,0,0.06); }
.pitch-deck-wrap .reveal .pitch-roadmap-item--planned { opacity: 0.6; }
.pitch-deck-wrap .reveal .pitch-roadmap-item--in_progress { background: var(--pitch-accent); color: #fff; }
.pitch-deck-wrap .reveal .pitch-roadmap-item--done { text-decoration: line-through; opacity: 0.6; }
.pitch-deck-wrap .reveal .pitch-roadmap-item--done::before { content: "✓ "; }

.pitch-deck-wrap .reveal .pitch-agenda { font-size: 1.1em; line-height: 1.7; max-width: 720px; margin: 16px auto; }
.pitch-deck-wrap .reveal .pitch-agenda li { padding: 4px 0; }
.pitch-deck-wrap .reveal .pitch-agenda-empty { opacity: 0.6; text-align: center; }
`.trim();
}

// ── Per-template renderers ─────────────────────────────────────────────

function renderSlide(
  slide: Slide,
  backgroundUrl?: string,
  brandKit?: BrandKit,
  position?: number,
  total?: number,
  deck?: Deck,
): string {
  const sectionAttrs = sectionAttributes(slide, backgroundUrl);
  const body = renderTemplateBody(slide, deck);
  const notes = slide.speaker_notes
    ? `<aside class="notes">${sanitize(slide.speaker_notes)}</aside>`
    : "";
  // Sub-issue #1051: per-slide branding chrome (logo + slide-number +
  // optional footer/watermark overrides). Only emit when a brand kit
  // was supplied — keeps unit-test renderers that call `renderSlide`
  // directly without a kit working as before.
  const chrome =
    brandKit && position !== undefined && total !== undefined
      ? `${slideFooterOverrideTag(slide)}${slideWatermarkOverrideTag(slide)}${slideLogoTag(slide, brandKit)}${slideNumberTag(slide, brandKit, position, total)}`
      : "";
  return `<section ${sectionAttrs}>${body}${chrome}${notes}</section>`;
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

function renderTemplateBody(slide: Slide, deck?: Deck): string {
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
    case "pricing_table":
      return renderPricingTable(slide);
    case "big_number":
      return renderBigNumber(slide);
    case "team_grid":
      return renderTeamGrid(slide);
    case "logo_grid":
      return renderLogoGrid(slide);
    case "roadmap":
      return renderRoadmap(slide);
    case "agenda":
      return renderAgenda(slide, deck);
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

// ── Sub-issue #1046 — Pricing Table + Big Number ──────────────────────

function renderPricingTable(
  s: Extract<Slide, { template: "pricing_table" }>,
): string {
  const { heading, tiers, footnote } = s.content;
  const cols = tiers
    .map((t, i) => {
      const features = t.features
        .map(
          (f, fi) =>
            `<li data-pitch-field="tiers.${i}.features.${fi}">${sanitize(f)}</li>`,
        )
        .join("");
      const cls = t.highlighted
        ? "pitch-pricing-tier pitch-pricing-tier--highlighted"
        : "pitch-pricing-tier";
      const cta = t.cta
        ? `<div class="pitch-pricing-cta pitch-accent" data-pitch-field="tiers.${i}.cta">${sanitize(t.cta)}</div>`
        : "";
      const period = t.period
        ? `<span class="pitch-pricing-period" data-pitch-field="tiers.${i}.period">${sanitize(t.period)}</span>`
        : "";
      return `<div class="${cls}" data-pitch-field="tiers.${i}"><h3 class="pitch-pricing-name" data-pitch-field="tiers.${i}.name">${sanitize(t.name)}</h3><div class="pitch-pricing-price" data-pitch-field="tiers.${i}.price">${sanitize(t.price)}${period}</div><ul class="pitch-pricing-features">${features}</ul>${cta}</div>`;
    })
    .join("");
  const note = footnote
    ? `<p class="pitch-pricing-footnote" data-pitch-field="footnote">${sanitize(footnote)}</p>`
    : "";
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><div class="pitch-pricing-grid pitch-pricing-grid--${tiers.length}">${cols}</div>${note}`;
}

function renderBigNumber(
  s: Extract<Slide, { template: "big_number" }>,
): string {
  const { value, label, support, trend, trend_label } = s.content;
  const trendClass = trend ? ` pitch-bignum-trend--${trend}` : "";
  const trendArrow =
    trend === "up" ? "▲" : trend === "down" ? "▼" : trend === "flat" ? "▬" : "";
  const trendBlock = trend
    ? `<div class="pitch-bignum-trend${trendClass}" data-pitch-field="trend"><span class="pitch-bignum-trend-arrow" aria-hidden="true">${trendArrow}</span>${trend_label ? `<span class="pitch-bignum-trend-label">${sanitize(trend_label)}</span>` : ""}</div>`
    : "";
  const supportBlock = support
    ? `<p class="pitch-bignum-support" data-pitch-field="support">${sanitize(support)}</p>`
    : "";
  return `<div class="pitch-bignum"><div class="pitch-bignum-value pitch-accent" data-pitch-field="value">${sanitize(value)}</div><div class="pitch-bignum-label" data-pitch-field="label">${sanitize(label)}</div>${trendBlock}${supportBlock}</div>`;
}

// ── Sub-issue #1049 — Team Grid + Logo Grid ───────────────────────────

function renderTeamGrid(
  s: Extract<Slide, { template: "team_grid" }>,
): string {
  const { heading, members } = s.content;
  const cards = members
    .map((m, i) => {
      const photoUrl = m.photoUrl ? safeUrl(m.photoUrl) : null;
      const photo = photoUrl
        ? `<img class="pitch-team-photo" src="${attr(photoUrl)}" alt="${attr(m.name)}" loading="lazy">`
        : `<div class="pitch-team-photo pitch-team-photo--placeholder" aria-hidden="true">${escapeHtml(m.name.slice(0, 2).toUpperCase())}</div>`;
      const bio = m.bio
        ? `<p class="pitch-team-bio" data-pitch-field="members.${i}.bio">${sanitize(m.bio)}</p>`
        : "";
      const links = (m.links ?? [])
        .map((l, li) => {
          const u = safeUrl(l.href);
          if (!u) return "";
          return `<a class="pitch-team-link" href="${attr(u)}" rel="nofollow noopener noreferrer" target="_blank" data-pitch-field="members.${i}.links.${li}">${sanitize(l.label)}</a>`;
        })
        .join("");
      return `<div class="pitch-team-card" data-pitch-field="members.${i}">${photo}<h4 class="pitch-team-name" data-pitch-field="members.${i}.name">${sanitize(m.name)}</h4><div class="pitch-team-role" data-pitch-field="members.${i}.role">${sanitize(m.role)}</div>${bio}${links ? `<div class="pitch-team-links">${links}</div>` : ""}</div>`;
    })
    .join("");
  return `${heading ? `<h2 data-pitch-field="heading">${sanitize(heading)}</h2>` : ""}<div class="pitch-team-grid pitch-team-grid--${members.length <= 4 ? "small" : members.length <= 8 ? "medium" : "large"}">${cards}</div>`;
}

function renderLogoGrid(
  s: Extract<Slide, { template: "logo_grid" }>,
): string {
  const { heading, caption, grayscale, logos } = s.content;
  const cells = logos
    .map((l, i) => {
      const u = safeUrl(l.imageUrl);
      if (!u) return "";
      const img = `<img src="${attr(u)}" alt="${attr(l.alt)}" loading="lazy">`;
      const href = l.href ? safeUrl(l.href) : null;
      const inner = href
        ? `<a href="${attr(href)}" rel="nofollow noopener noreferrer" target="_blank">${img}</a>`
        : img;
      return `<div class="pitch-logo-cell" data-pitch-field="logos.${i}">${inner}</div>`;
    })
    .join("");
  const cls = grayscale
    ? "pitch-logo-grid pitch-logo-grid--grayscale"
    : "pitch-logo-grid";
  return `${heading ? `<h2 data-pitch-field="heading">${sanitize(heading)}</h2>` : ""}<div class="${cls}">${cells}</div>${caption ? `<p class="pitch-logo-grid-caption" data-pitch-field="caption">${sanitize(caption)}</p>` : ""}`;
}

// ── Sub-issue #1052 — Roadmap + Agenda ────────────────────────────────

function renderRoadmap(
  s: Extract<Slide, { template: "roadmap" }>,
): string {
  const { heading, columns, tracks, items } = s.content;
  // Build a tracks × columns matrix of label arrays.
  const matrix: Array<Array<Array<{ label: string; status?: string; idx: number }>>> =
    tracks.map(() => columns.map(() => []));
  items.forEach((it, idx) => {
    const t = Math.min(Math.max(it.track, 0), tracks.length - 1);
    const c = Math.min(Math.max(it.column, 0), columns.length - 1);
    matrix[t][c].push({ label: it.label, status: it.status, idx });
  });
  const headerRow = `<tr><th></th>${columns.map((c) => `<th>${sanitize(c)}</th>`).join("")}</tr>`;
  const bodyRows = tracks
    .map((trackName, ti) => {
      const cells = matrix[ti]
        .map((cell) => {
          const inner = cell
            .map((it) => {
              const cls = it.status
                ? `pitch-roadmap-item pitch-roadmap-item--${it.status}`
                : "pitch-roadmap-item";
              return `<li class="${cls}" data-pitch-field="items.${it.idx}">${sanitize(it.label)}</li>`;
            })
            .join("");
          return `<td><ul class="pitch-roadmap-cell">${inner}</ul></td>`;
        })
        .join("");
      return `<tr><th class="pitch-roadmap-track">${sanitize(trackName)}</th>${cells}</tr>`;
    })
    .join("");
  return `<h2 data-pitch-field="heading">${sanitize(heading)}</h2><table class="pitch-roadmap"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

function renderAgenda(
  s: Extract<Slide, { template: "agenda" }>,
  deck?: Deck,
): string {
  const { heading, mode, items, numbered } = s.content;
  let resolved: string[] = [];
  if (mode === "manual") {
    resolved = items ?? [];
  } else if (deck) {
    // Auto: derive from section_divider slides in deck order.
    resolved = deck.slides
      .filter((sl): sl is Extract<Slide, { template: "section_divider" }> =>
        sl.template === "section_divider",
      )
      .map((sl) => sl.content.title);
  }
  const tag = numbered ? "ol" : "ul";
  const list = resolved.length
    ? `<${tag} class="pitch-agenda">${resolved
        .map(
          (it, i) =>
            `<li data-pitch-field="items.${i}">${sanitize(it)}</li>`,
        )
        .join("")}</${tag}>`
    : `<p class="pitch-agenda-empty">No agenda items available.</p>`;
  return `<h2 data-pitch-field="heading">${sanitize(heading ?? "Agenda")}</h2>${list}`;
}

function imageTag(img: SlideImage | undefined): string {
  if (!img) return "";
  const url = safeUrl(img.url);
  if (!url) return "";
  return `<img src="${attr(url)}" alt="${attr(img.alt)}" loading="lazy">`;
}
