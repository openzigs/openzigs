/**
 * Pitch — centralized HTML sanitization helper (Phase 7 / sub-issue #977).
 *
 * Single source of truth for the DOMPurify configuration used by every
 * Pitch consumer (renderer, future export adapters). Centralizing here
 * means a future tag-allowlist tweak ships in one place — Phase 4 had
 * the config inlined in `pitch-renderer.ts` which made the rules drift
 * across the 14 template renderers.
 *
 * SECURITY (research §10):
 *   - `FORBID_TAGS` strips active content, embeds, and document-level
 *     overrides (`base`, `meta`, `form`).
 *   - `FORBID_ATTR` strips every `on*` event handler plus `formaction`
 *     and `xlink:href` (SVG-style script vector — defence in depth even
 *     though SVG uploads are blocked at the multer/sharp boundary).
 *   - `ALLOWED_URI_REGEXP` blocks `javascript:` / `vbscript:` / `data:`
 *     URIs, with a single carve-out for `data:image/*` so legitimate
 *     inline image data URLs continue to work for the image pipeline.
 *
 * The helper exports four primitives:
 *   - `sanitizeRichText(s)` — HTML allowed, scripts and event handlers
 *     stripped. Use for any user-supplied string that is rendered as
 *     HTML inside a slide template.
 *   - `escapeHtml(s)` — text-only escape for `<pre><code>` blocks where
 *     no markup is permitted at all.
 *   - `escapeAttr(s)` — same as `escapeHtml` but explicit about intent.
 *   - `safeUrl(s)` — strict allowlist for `<img src>` / link targets.
 *     Permits only `http(s)://` and root-relative `/`-prefixed paths.
 *     `file://` is permitted only when prefixed with the local cache
 *     dir, but that path is enforced by `safeImageUrl` in callers.
 */
import DOMPurify from "isomorphic-dompurify";

/** Active-content tags that must never reach the rendered DOM. */
export const PITCH_FORBID_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "style",
] as const;

/** Event-handler / formaction-style attributes that must always be stripped. */
export const PITCH_FORBID_ATTR = [
  "onerror",
  "onload",
  "onclick",
  "onmouseover",
  "onmouseout",
  "onfocus",
  "onblur",
  "onchange",
  "onsubmit",
  "onkeydown",
  "onkeyup",
  "onkeypress",
  "onabort",
  "onauxclick",
  "ondrag",
  "ondrop",
  "onpointerdown",
  "onpointerup",
  "onpointermove",
  "onanimationstart",
  "onanimationend",
  "ontransitionend",
  "onbegin",
  "onend",
  "onrepeat",
  "formaction",
  "xlink:href",
  "srcdoc",
  "action",
  "background",
  "ping",
  // Inline `style` is a CSS-injection vector — `background:url(javascript:…)`
  // is no longer executed by modern browsers but `expression(…)` and
  // `behavior:` survive in legacy/embedded WebViews. Slide content does
  // not need inline styles (templates own all visual presentation), so
  // we strip the attribute outright.
  "style",
] as const;

/**
 * Scheme allowlist for any URL DOMPurify decides to keep. Blocks
 * `javascript:`, `vbscript:`, and bare `data:` (carve-out only for
 * `data:image/*`). Mirrors the OWASP DOM-XSS prevention cheat sheet.
 */
export const PITCH_ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel):|[/?#]|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i;

const SANITIZE_CONFIG = {
  FORBID_TAGS: [...PITCH_FORBID_TAGS],
  FORBID_ATTR: [...PITCH_FORBID_ATTR],
  ALLOWED_URI_REGEXP: PITCH_ALLOWED_URI_REGEXP,
};

/**
 * Sanitize an arbitrary user-supplied string for insertion as HTML.
 * Any forbidden tags / attributes / URIs are stripped. Returns `""`
 * for null / undefined input so callers don't need to guard.
 */
export function sanitizeRichText(input: string | null | undefined): string {
  if (input == null) return "";
  return DOMPurify.sanitize(String(input), SANITIZE_CONFIG);
}

/**
 * Strict text-only escape (no HTML allowed). Use for `<pre><code>` and
 * other contexts where any markup should be rendered as literal text.
 */
export function escapeHtml(input: string | null | undefined): string {
  if (input == null) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Alias for `escapeHtml` — clarifies attribute-context intent at call sites. */
export function escapeAttr(input: string | null | undefined): string {
  return escapeHtml(input);
}

/**
 * Strict allowlist for URLs rendered inside `<img src>` etc. Permits
 * `http(s)://` absolute URLs and root-relative paths. Protocol-relative
 * `//host/path` URLs are rejected so relative assets cannot silently turn
 * into third-party requests. Returns `null` for anything else.
 *
 * `data:` URLs are intentionally rejected here — image-pipeline assets
 * arrive as `http(s)://` URLs, and any `data:` inside the schema would
 * indicate either a developer mistake or a tampered payload.
 */
export function safeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = String(input).trim();
  if (!v) return null;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}
