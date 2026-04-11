/**
 * Caption Templates — Unit Tests
 * Issue #819: Enhanced Animated Captions.
 */

import { describe, it, expect } from "vitest";
import {
  CAPTION_TEMPLATES,
  getCaptionTemplate,
  getCaptionTemplateIds,
  applyBrandKitToTemplate,
  breakIntoLines,
  type CaptionWord,
} from "./caption-templates.js";

describe("CAPTION_TEMPLATES", () => {
  it("has at least 6 templates", () => {
    expect(CAPTION_TEMPLATES.length).toBeGreaterThanOrEqual(6);
  });

  it("each template has required fields", () => {
    for (const template of CAPTION_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.name).toBeTruthy();
      expect(template.fontFamily).toBeTruthy();
      expect(template.fontSize).toBeGreaterThan(0);
      expect(template.textColor).toMatch(/^#/);
      expect(template.highlightColor).toMatch(/^#/);
      expect(["top", "center", "bottom", "lower-third"]).toContain(
        template.position,
      );
      expect(["pop", "glow", "bounce", "underline", "fade", "none"]).toContain(
        template.animation,
      );
      expect(template.maxWordsPerLine).toBeGreaterThan(0);
    }
  });

  it("has unique IDs", () => {
    const ids = CAPTION_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getCaptionTemplate", () => {
  it("returns hormozi template", () => {
    const template = getCaptionTemplate("hormozi");
    expect(template).toBeDefined();
    expect(template!.name).toBe("Hormozi");
    expect(template!.animation).toBe("pop");
  });

  it("returns undefined for unknown template", () => {
    expect(getCaptionTemplate("nonexistent")).toBeUndefined();
  });
});

describe("getCaptionTemplateIds", () => {
  it("returns all template IDs", () => {
    const ids = getCaptionTemplateIds();
    expect(ids).toContain("hormozi");
    expect(ids).toContain("minimal");
    expect(ids).toContain("tiktok");
    expect(ids).toContain("news");
    expect(ids).toContain("podcast");
    expect(ids).toContain("corporate");
  });
});

describe("applyBrandKitToTemplate", () => {
  it("applies brand kit to supporting template", () => {
    const template = getCaptionTemplate("minimal")!;
    const branded = applyBrandKitToTemplate(template, {
      primaryColor: "#FF0000",
      secondaryColor: "#00FF00",
      fontFamily: "Custom Font",
    });

    expect(branded.highlightColor).toBe("#FF0000");
    expect(branded.textColor).toBe("#00FF00");
    expect(branded.fontFamily).toBe("Custom Font");
  });

  it("does not apply brand kit to non-supporting template", () => {
    const template = getCaptionTemplate("hormozi")!;
    const branded = applyBrandKitToTemplate(template, {
      primaryColor: "#FF0000",
    });

    expect(branded.highlightColor).toBe(template.highlightColor);
  });

  it("preserves other template properties", () => {
    const template = getCaptionTemplate("corporate")!;
    const branded = applyBrandKitToTemplate(template, {
      primaryColor: "#FF0000",
    });

    expect(branded.fontSize).toBe(template.fontSize);
    expect(branded.position).toBe(template.position);
    expect(branded.animation).toBe(template.animation);
  });
});

describe("breakIntoLines", () => {
  const words: CaptionWord[] = [
    { text: "Hello", start: 0, end: 0.5 },
    { text: "world", start: 0.5, end: 1.0 },
    { text: "this", start: 1.0, end: 1.5 },
    { text: "is", start: 1.5, end: 2.0 },
    { text: "a", start: 2.0, end: 2.3 },
    { text: "test", start: 2.3, end: 2.8 },
    { text: "of", start: 2.8, end: 3.0 },
    { text: "captions", start: 3.0, end: 3.5 },
  ];

  it("breaks into lines of max words", () => {
    const lines = breakIntoLines(words, 3);
    expect(lines).toHaveLength(3);
    expect(lines[0].words).toHaveLength(3);
    expect(lines[1].words).toHaveLength(3);
    expect(lines[2].words).toHaveLength(2);
  });

  it("preserves timing", () => {
    const lines = breakIntoLines(words, 4);
    expect(lines[0].start).toBe(0);
    expect(lines[0].end).toBe(2.0);
    expect(lines[1].start).toBe(2.0);
    expect(lines[1].end).toBe(3.5);
  });

  it("handles empty input", () => {
    expect(breakIntoLines([], 5)).toEqual([]);
  });

  it("handles single word", () => {
    const lines = breakIntoLines([words[0]], 5);
    expect(lines).toHaveLength(1);
    expect(lines[0].words).toHaveLength(1);
  });

  it("handles max words larger than input", () => {
    const lines = breakIntoLines(words, 100);
    expect(lines).toHaveLength(1);
    expect(lines[0].words).toHaveLength(8);
  });
});
