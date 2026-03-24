/**
 * Unit tests for pacing-translator.ts
 * Issue #320: Script Pacing & TTS Bracket Syntax
 */

import { describe, it, expect } from "vitest";
import {
  translatePacingTags,
  hasPacingTags,
  PAUSE_RE,
  EMPHASIS_RE,
  SPEED_RE,
  SPEED_END_RE,
  VOICE_RE,
  NARRATION_DIRECTIVES,
} from "./pacing-translator.js";

describe("hasPacingTags", () => {
  it("returns false for plain text", () => {
    expect(hasPacingTags("Hello world")).toBe(false);
  });

  it("detects [PAUSE: Xs] tags", () => {
    expect(hasPacingTags("Hello [PAUSE: 2s] world")).toBe(true);
  });

  it("detects *emphasis* tags", () => {
    expect(hasPacingTags("This is *important*")).toBe(true);
  });

  it("detects both tag types together", () => {
    expect(hasPacingTags("Hello [PAUSE: 1s] *world*")).toBe(true);
  });

  it("detects [SPEED: Xx] tags", () => {
    expect(hasPacingTags("Hello [SPEED: 1.2x] world")).toBe(true);
  });

  it("detects [VOICE: id] tags", () => {
    expect(hasPacingTags("Hello [VOICE: am_adam] world")).toBe(true);
  });
});

describe("translatePacingTags", () => {
  describe("basic translation", () => {
    it("wraps plain text in <speak> tags", () => {
      const result = translatePacingTags("Hello world");
      expect(result.ssml).toBe("<speak>Hello world</speak>");
      expect(result.hasTags).toBe(false);
      expect(result.plainSegments).toEqual([
        { text: "Hello world", pauseAfterMs: 0 },
      ]);
    });

    it("handles empty input", () => {
      const result = translatePacingTags("");
      expect(result.ssml).toBe("<speak></speak>");
      expect(result.hasTags).toBe(false);
      expect(result.plainSegments).toEqual([]);
    });
  });

  describe("PAUSE tags", () => {
    it("converts [PAUSE: 2s] to SSML break", () => {
      const result = translatePacingTags("Hello [PAUSE: 2s] World");
      expect(result.ssml).toBe(
        '<speak>Hello <break time="2000ms"/> World</speak>'
      );
      expect(result.hasTags).toBe(true);
    });

    it("converts [PAUSE: 0.5s] to SSML break", () => {
      const result = translatePacingTags("Before [PAUSE: 0.5s] after");
      expect(result.ssml).toContain('<break time="500ms"/>');
    });

    it("handles multiple pauses", () => {
      const result = translatePacingTags(
        "One [PAUSE: 1s] Two [PAUSE: 2s] Three"
      );
      expect(result.ssml).toContain('<break time="1000ms"/>');
      expect(result.ssml).toContain('<break time="2000ms"/>');
    });

    it("clamps pause above 10s to 10s", () => {
      const result = translatePacingTags("Wait [PAUSE: 15s] here");
      expect(result.ssml).toContain('<break time="10000ms"/>');
    });

    it("clamps pause below 0.1s to 0.1s", () => {
      const result = translatePacingTags("Quick [PAUSE: 0.01s] pause");
      expect(result.ssml).toContain('<break time="100ms"/>');
    });

    it("is case-insensitive for PAUSE", () => {
      const result = translatePacingTags("Hello [pause: 1s] world");
      expect(result.ssml).toContain('<break time="1000ms"/>');
    });
  });

  describe("emphasis tags", () => {
    it("converts *word* to SSML emphasis", () => {
      const result = translatePacingTags("This is *important*");
      expect(result.ssml).toContain("<emphasis>important</emphasis>");
      expect(result.hasTags).toBe(true);
    });

    it("converts multiple emphasis tags", () => {
      const result = translatePacingTags("*Hello* and *world*");
      expect(result.ssml).toContain("<emphasis>Hello</emphasis>");
      expect(result.ssml).toContain("<emphasis>world</emphasis>");
    });

    it("handles multi-word emphasis", () => {
      const result = translatePacingTags("This is *very important stuff*");
      expect(result.ssml).toContain(
        "<emphasis>very important stuff</emphasis>"
      );
    });
  });

  describe("SPEED tags", () => {
    it("converts [SPEED: 1.2x] to SSML prosody", () => {
      const result = translatePacingTags("Normal [SPEED: 1.2x]fast talking[/SPEED] normal");
      expect(result.ssml).toContain('<prosody rate="120%">');
      expect(result.ssml).toContain("</prosody>");
      expect(result.hasTags).toBe(true);
    });

    it("converts [SPEED: 0.8x] to slower rate", () => {
      const result = translatePacingTags("[SPEED: 0.8x]Slow and steady[/SPEED]");
      expect(result.ssml).toContain('<prosody rate="80%">');
    });

    it("clamps speed above 2.0 to 2.0", () => {
      const result = translatePacingTags("[SPEED: 5x]too fast[/SPEED]");
      expect(result.ssml).toContain('<prosody rate="200%">');
    });

    it("clamps speed below 0.5 to 0.5", () => {
      const result = translatePacingTags("[SPEED: 0.1x]too slow[/SPEED]");
      expect(result.ssml).toContain('<prosody rate="50%">');
    });

    it("sets speed on plain segments", () => {
      const result = translatePacingTags("Normal [SPEED: 1.5x]fast part[/SPEED] normal again");
      expect(result.plainSegments.length).toBeGreaterThanOrEqual(2);
      const fast = result.plainSegments.find(s => s.speed === 1.5);
      expect(fast).toBeDefined();
      expect(fast!.text).toContain("fast part");
      const normal = result.plainSegments.find(s => s.text.includes("normal again"));
      expect(normal).toBeDefined();
      expect(normal!.speed).toBeUndefined();
    });
  });

  describe("VOICE tags", () => {
    it("strips [VOICE: id] from SSML (local-only feature)", () => {
      const result = translatePacingTags("[VOICE: am_adam]Authoritative speech");
      expect(result.ssml).not.toContain("[VOICE");
      expect(result.ssml).not.toContain("am_adam");
      expect(result.hasTags).toBe(true);
    });

    it("sets voice on plain segments", () => {
      const result = translatePacingTags("[VOICE: am_adam]Hello from Adam");
      const seg = result.plainSegments.find(s => s.voice === "am_adam");
      expect(seg).toBeDefined();
      expect(seg!.text).toContain("Hello from Adam");
    });

    it("switches voice mid-script", () => {
      const result = translatePacingTags("Normal voice [VOICE: af_nova]Energetic voice");
      expect(result.plainSegments.length).toBe(2);
      expect(result.plainSegments[0].voice).toBeUndefined();
      expect(result.plainSegments[1].voice).toBe("af_nova");
    });
  });

  describe("combined tags", () => {
    it("handles pause + emphasis together", () => {
      const result = translatePacingTags(
        "Welcome [PAUSE: 1s] to *OpenZigs*"
      );
      expect(result.ssml).toContain('<break time="1000ms"/>');
      expect(result.ssml).toContain("<emphasis>OpenZigs</emphasis>");
      expect(result.hasTags).toBe(true);
    });

    it("handles speed + pause + voice together", () => {
      const result = translatePacingTags(
        "[SPEED: 1.2x]Fast intro[/SPEED] [PAUSE: 1s] [VOICE: am_adam]Main content"
      );
      expect(result.ssml).toContain('<prosody rate="120%">');
      expect(result.ssml).toContain('<break time="1000ms"/>');
      expect(result.hasTags).toBe(true);
      const adam = result.plainSegments.find(s => s.voice === "am_adam");
      expect(adam).toBeDefined();
    });
  });

  describe("plain segments for local TTS", () => {
    it("splits text at pause boundaries", () => {
      const result = translatePacingTags("Hello [PAUSE: 2s] World");
      expect(result.plainSegments).toEqual([
        { text: "Hello", pauseAfterMs: 2000 },
        { text: "World", pauseAfterMs: 0 },
      ]);
    });

    it("strips emphasis markers in plain segments", () => {
      const result = translatePacingTags("This is *important*");
      expect(result.plainSegments).toEqual([
        { text: "This is important", pauseAfterMs: 0 },
      ]);
    });

    it("handles multiple pauses in segments", () => {
      const result = translatePacingTags(
        "One [PAUSE: 1s] Two [PAUSE: 2s] Three"
      );
      expect(result.plainSegments.length).toBe(3);
      expect(result.plainSegments[0]).toEqual({
        text: "One",
        pauseAfterMs: 1000,
      });
      expect(result.plainSegments[1]).toEqual({
        text: "Two",
        pauseAfterMs: 2000,
      });
      expect(result.plainSegments[2]).toEqual({
        text: "Three",
        pauseAfterMs: 0,
      });
    });
  });

  describe("XML escaping", () => {
    it("escapes ampersands in text", () => {
      const result = translatePacingTags("Tom & Jerry");
      expect(result.ssml).toBe("<speak>Tom &amp; Jerry</speak>");
    });

    it("escapes angle brackets in text", () => {
      const result = translatePacingTags("a < b > c");
      expect(result.ssml).toBe("<speak>a &lt; b &gt; c</speak>");
    });

    it("escapes in text alongside pacing tags", () => {
      const result = translatePacingTags("A & B [PAUSE: 1s] C < D");
      expect(result.ssml).toContain("A &amp; B");
      expect(result.ssml).toContain("C &lt; D");
      expect(result.ssml).toContain('<break time="1000ms"/>');
    });
  });

  describe("ScriptSanitizer round-trip", () => {
    it("bracket tags survive sanitization (simulated)", () => {
      // The ScriptSanitizer strips HTML/XML tags via /<\/?[a-zA-Z]...>/g
      // but brackets [PAUSE: Xs] do NOT match that pattern
      const input = "Welcome [PAUSE: 1s] to *OpenZigs* [SPEED: 1.2x]fast[/SPEED] [VOICE: am_adam]deep";
      const htmlTagRe =
        /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;
      let afterSanitizer = input;
      let prev = "";
      while (afterSanitizer !== prev) {
        prev = afterSanitizer;
        afterSanitizer = afterSanitizer.replace(htmlTagRe, "");
      }

      // Brackets survive
      expect(afterSanitizer).toContain("[PAUSE: 1s]");
      expect(afterSanitizer).toContain("*OpenZigs*");
      expect(afterSanitizer).toContain("[SPEED: 1.2x]");
      expect(afterSanitizer).toContain("[VOICE: am_adam]");

      // Translation still works
      const result = translatePacingTags(afterSanitizer);
      expect(result.ssml).toContain('<break time="1000ms"/>');
      expect(result.ssml).toContain("<emphasis>OpenZigs</emphasis>");
      expect(result.ssml).toContain('<prosody rate="120%">');
    });

    it("SSML tags do NOT survive sanitization (proving bracket syntax is needed)", () => {
      const input = 'Welcome <break time="2s"/> to <emphasis>OpenZigs</emphasis>';
      const htmlTagRe =
        /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;
      let afterSanitizer = input;
      let prev = "";
      while (afterSanitizer !== prev) {
        prev = afterSanitizer;
        afterSanitizer = afterSanitizer.replace(htmlTagRe, "");
      }

      // SSML tags are stripped
      expect(afterSanitizer).not.toContain("<break");
      expect(afterSanitizer).not.toContain("<emphasis");
    });
  });
});

describe("regex patterns", () => {
  it("PAUSE_RE matches valid formats", () => {
    const cases = [
      "[PAUSE: 1s]",
      "[PAUSE: 0.5s]",
      "[PAUSE: 10s]",
      "[PAUSE:2s]", // no space after colon
      "[pause: 1s]", // lowercase
    ];
    for (const c of cases) {
      PAUSE_RE.lastIndex = 0;
      expect(PAUSE_RE.test(c)).toBe(true);
    }
  });

  it("PAUSE_RE rejects invalid formats", () => {
    const cases = [
      "[PAUSE: s]", // no number
      "[PAUSE: -1s]", // negative
      "PAUSE: 1s", // no brackets
    ];
    for (const c of cases) {
      PAUSE_RE.lastIndex = 0;
      expect(PAUSE_RE.test(c)).toBe(false);
    }
  });

  it("EMPHASIS_RE matches valid formats", () => {
    EMPHASIS_RE.lastIndex = 0;
    expect(EMPHASIS_RE.test("*hello*")).toBe(true);
    EMPHASIS_RE.lastIndex = 0;
    expect(EMPHASIS_RE.test("*hello world*")).toBe(true);
  });

  it("EMPHASIS_RE rejects empty emphasis", () => {
    EMPHASIS_RE.lastIndex = 0;
    expect(EMPHASIS_RE.test("**")).toBe(false);
  });

  it("SPEED_RE matches valid formats", () => {
    const cases = [
      "[SPEED: 1.2x]",
      "[SPEED: 0.5x]",
      "[SPEED:2x]",
      "[speed: 1x]",
    ];
    for (const c of cases) {
      SPEED_RE.lastIndex = 0;
      expect(SPEED_RE.test(c)).toBe(true);
    }
  });

  it("SPEED_END_RE matches closing tag", () => {
    SPEED_END_RE.lastIndex = 0;
    expect(SPEED_END_RE.test("[/SPEED]")).toBe(true);
    SPEED_END_RE.lastIndex = 0;
    expect(SPEED_END_RE.test("[/speed]")).toBe(true);
  });

  it("VOICE_RE matches valid voice preset ids", () => {
    const cases = [
      "[VOICE: af_heart]",
      "[VOICE: am_adam]",
      "[VOICE: bm_daniel]",
      "[voice: af_nova]",
    ];
    for (const c of cases) {
      VOICE_RE.lastIndex = 0;
      expect(VOICE_RE.test(c)).toBe(true);
    }
  });

  it("VOICE_RE rejects invalid formats", () => {
    const cases = [
      "[VOICE: ]",
      "[VOICE: 123]",
      "VOICE: af_heart",
    ];
    for (const c of cases) {
      VOICE_RE.lastIndex = 0;
      expect(VOICE_RE.test(c)).toBe(false);
    }
  });
});

describe("NARRATION_DIRECTIVES", () => {
  it("exports directive metadata for UI autocomplete", () => {
    expect(NARRATION_DIRECTIVES.length).toBeGreaterThan(0);
    for (const d of NARRATION_DIRECTIVES) {
      expect(d.tag).toBeTruthy();
      expect(d.label).toBeTruthy();
      expect(d.description).toBeTruthy();
    }
  });
});
