/**
 * Tests for the centralized Pitch sanitization helpers (Phase 7 / sub-issue
 * #977). The fuzz test below exercises 50+ XSS payloads from the OWASP
 * cheat sheet against `sanitizeRichText` and asserts that NONE of them
 * leave a script-execution vector in the output.
 */
import { describe, expect, it } from "vitest";
import {
  PITCH_ALLOWED_URI_REGEXP,
  PITCH_FORBID_ATTR,
  PITCH_FORBID_TAGS,
  escapeAttr,
  escapeHtml,
  safeUrl,
  sanitizeRichText,
} from "./pitch-sanitize.js";

/**
 * 50+ XSS payloads drawn from the OWASP XSS Filter Evasion + DOM-XSS
 * Prevention cheat sheets. Each one MUST come back from
 * `sanitizeRichText` with no executable script tags, no event handlers,
 * and no `javascript:` / `vbscript:` URIs.
 */
const XSS_PAYLOADS: string[] = [
  // Classic script tags
  `<script>alert(1)</script>`,
  `<SCRIPT>alert("XSS")</SCRIPT>`,
  `<script src=https://evil.test/x.js></script>`,
  `<script\nsrc="x.js"></script>`,
  `<scr<script>ipt>alert(1)</scr</script>ipt>`,
  // Event-handler attributes
  `<img src=x onerror="alert(1)">`,
  `<img src=x onerror=alert(1)>`,
  `<img src=x ONERROR=alert(1)>`,
  `<img src=x onerror="javascript:alert(1)">`,
  `<svg onload=alert(1)>`,
  `<body onload=alert(1)>`,
  `<a onmouseover="alert(1)">x</a>`,
  `<a onfocus=alert(1) tabindex=1>x</a>`,
  `<input autofocus onfocus=alert(1)>`,
  `<details open ontoggle=alert(1)>`,
  `<video><source onerror="alert(1)">`,
  `<form><button formaction="javascript:alert(1)">x`,
  `<form action="javascript:alert(1)"><input type=submit>`,
  // javascript: / vbscript: / data: URIs
  `<a href="javascript:alert(1)">x</a>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<a href=" javascript:alert(1)">x</a>`,
  `<a href="vbscript:msgbox(1)">x</a>`,
  `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  `<iframe src="javascript:alert(1)"></iframe>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  // Style-based vectors (FORBID_TAGS strips <style>, but stay safe)
  `<style>@import "https://evil.test/x.css";</style>`,
  `<div style="background:url(javascript:alert(1))">`,
  `<div style="x:expression(alert(1))">`,
  // Embed / object / link / meta — all in FORBID_TAGS
  `<embed src="javascript:alert(1)">`,
  `<object data="javascript:alert(1)"></object>`,
  `<link rel=stylesheet href="javascript:alert(1)">`,
  `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
  `<base href="javascript:alert(1)//">`,
  // SVG-specific
  `<svg><script>alert(1)</script></svg>`,
  `<svg><a xlink:href="javascript:alert(1)"><text x=20 y=20>x</text></a></svg>`,
  `<svg><animate attributeName=href values=javascript:alert(1) /></svg>`,
  `<svg onload=alert(1)><circle r=10 /></svg>`,
  // Markup obfuscation
  `<img src=x onerror=&#97;&#108;&#101;&#114;&#116;(1)>`,
  `<img src=x onerror=\\x61lert(1)>`,
  `<img src=x onerror="al\\u0065rt(1)">`,
  `&#60;script&#62;alert(1)&#60;/script&#62;`,
  `<img """><script>alert(1)</script>">`,
  `<<SCRIPT>alert(1)//<</SCRIPT>`,
  `<IMG SRC=javascript:alert('XSS')>`,
  `<IMG SRC=JaVaScRiPt:alert('XSS')>`,
  `<IMG """ SRC=x onerror=alert(1)>`,
  `<IMG SRC=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert('XSS')>`,
  `<IMG SRC="jav\tascript:alert('XSS');">`,
  // Pointer / drag handlers
  `<div ondragstart=alert(1) draggable=true>x</div>`,
  `<div onpointerdown=alert(1)>x</div>`,
  // Focus / keypress
  `<input onkeydown=alert(1)>`,
  `<input onchange=alert(1)>`,
  // Animation / transition handlers
  `<div onanimationstart=alert(1)>x</div>`,
  `<div ontransitionend=alert(1)>x</div>`,
  // Mutation
  `<a href="x" ping="https://evil.test">x</a>`,
  // Attribute confusion
  `<a href="//evil.test"target="_blank">x</a>`,
  `"><script>alert(1)</script>`,
];

describe("sanitizeRichText — OWASP XSS fuzz", () => {
  for (const payload of XSS_PAYLOADS) {
    it(`neutralizes: ${JSON.stringify(payload).slice(0, 80)}`, () => {
      const out = sanitizeRichText(payload);
      // Hard rules: no live <script>, no event handlers, no javascript:
      // / vbscript: URIs.
      expect(out.toLowerCase()).not.toMatch(/<script\b/);
      expect(out.toLowerCase()).not.toMatch(/<iframe\b/);
      expect(out.toLowerCase()).not.toMatch(/<object\b/);
      expect(out.toLowerCase()).not.toMatch(/<embed\b/);
      expect(out.toLowerCase()).not.toMatch(/\son[a-z]+\s*=/);
      expect(out.toLowerCase()).not.toMatch(/javascript\s*:/);
      expect(out.toLowerCase()).not.toMatch(/vbscript\s*:/);
      expect(out.toLowerCase()).not.toMatch(/srcdoc\s*=/);
      expect(out.toLowerCase()).not.toMatch(/formaction\s*=/);
    });
  }

  it("returns empty string for null/undefined input", () => {
    expect(sanitizeRichText(null)).toBe("");
    expect(sanitizeRichText(undefined)).toBe("");
  });

  it("preserves benign markup", () => {
    const out = sanitizeRichText("Hello <strong>world</strong> &amp; friends");
    expect(out).toMatch(/<strong>world<\/strong>/);
  });

  it("forbid lists include the cross-cutting baseline", () => {
    expect(PITCH_FORBID_TAGS).toEqual(
      expect.arrayContaining(["script", "iframe", "object", "embed", "link", "meta", "base", "form"]),
    );
    expect(PITCH_FORBID_ATTR).toEqual(
      expect.arrayContaining([
        "onerror",
        "onload",
        "onclick",
        "onmouseover",
        "onmouseout",
        "onfocus",
        "onblur",
        "onchange",
        "onsubmit",
        "formaction",
        "xlink:href",
      ]),
    );
  });

  it("URL allowlist regexp blocks javascript:/vbscript:/bare-data: but allows data:image/*", () => {
    expect("javascript:alert(1)").not.toMatch(PITCH_ALLOWED_URI_REGEXP);
    expect("vbscript:msgbox(1)").not.toMatch(PITCH_ALLOWED_URI_REGEXP);
    expect("data:text/html,<script>alert(1)</script>").not.toMatch(
      PITCH_ALLOWED_URI_REGEXP,
    );
    expect("data:image/png;base64,iVBORw0KGgo=").toMatch(PITCH_ALLOWED_URI_REGEXP);
    expect("data:image/svg+xml;base64,PHN2Zw==").toMatch(PITCH_ALLOWED_URI_REGEXP);
    expect("https://example.com/x.png").toMatch(PITCH_ALLOWED_URI_REGEXP);
    expect("/relative/path").toMatch(PITCH_ALLOWED_URI_REGEXP);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
  it("returns empty for null/undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("escapeAttr", () => {
  it("delegates to escapeHtml", () => {
    expect(escapeAttr(`x" onerror="alert(1)`)).toBe(
      "x&quot; onerror=&quot;alert(1)",
    );
  });
});

describe("safeUrl", () => {
  it("permits http(s) absolute URLs", () => {
    expect(safeUrl("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
  });
  it("permits root-relative paths", () => {
    expect(safeUrl("/static/logo.png")).toBe("/static/logo.png");
  });
  it("rejects javascript: / vbscript: / data: / file:", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)")).toBeNull();
    expect(safeUrl("data:image/png;base64,xxx")).toBeNull();
    expect(safeUrl("file:///etc/passwd")).toBeNull();
  });
  it("returns null for empty / nullish input", () => {
    expect(safeUrl("")).toBeNull();
    expect(safeUrl("   ")).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});
