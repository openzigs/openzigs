import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  generateChapters,
  formatChaptersForDescription,
} from "./youtube-chapters.js";
import type { ManifestForChapters } from "./youtube-chapters.js";

describe("formatTimestamp", () => {
  it("formats 0ms as 0:00", () => {
    expect(formatTimestamp(0)).toBe("0:00");
  });

  it("formats seconds correctly", () => {
    expect(formatTimestamp(15000)).toBe("0:15");
  });

  it("formats minutes and seconds", () => {
    expect(formatTimestamp(90000)).toBe("1:30");
  });

  it("pads seconds with leading zero", () => {
    expect(formatTimestamp(65000)).toBe("1:05");
  });

  it("formats hours correctly", () => {
    expect(formatTimestamp(3661000)).toBe("1:01:01");
  });
});

describe("generateChapters", () => {
  it("returns empty for empty timeline", () => {
    expect(generateChapters({ timeline: [] })).toEqual([]);
  });

  it("returns empty for no timeline", () => {
    expect(generateChapters({})).toEqual([]);
  });

  it("generates chapters from scenes with titles", () => {
    const manifest: ManifestForChapters = {
      composition: { fps: 30 },
      timeline: [
        { type: "title_card", title: "Intro", durationInFrames: 90 },
        { type: "image_scene", title: "Topic One", durationInFrames: 150 },
        { type: "image_scene", title: "Topic Two", durationInFrames: 180 },
      ],
    };

    const chapters = generateChapters(manifest);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]).toEqual({ timestamp: "0:00", label: "Intro" });
    expect(chapters[1]).toEqual({ timestamp: "0:03", label: "Topic One" });
    expect(chapters[2]).toEqual({ timestamp: "0:08", label: "Topic Two" });
  });

  it("skips transitions and overlays", () => {
    const manifest: ManifestForChapters = {
      composition: { fps: 30 },
      timeline: [
        { type: "image_scene", title: "Scene 1", duration: 5 },
        { type: "transition", duration: 1 },
        { type: "image_scene", title: "Scene 2", duration: 5 },
      ],
    };

    const chapters = generateChapters(manifest);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].label).toBe("Scene 1");
    // 5s scene + 1s transition = 6s start for scene 2
    expect(chapters[1].timestamp).toBe("0:06");
  });

  it("derives label from scriptText when no title", () => {
    const manifest: ManifestForChapters = {
      composition: { fps: 30 },
      timeline: [
        { type: "image_scene", scriptText: "Welcome to the show", duration: 5 },
      ],
    };

    const chapters = generateChapters(manifest);
    expect(chapters[0].label).toBe("Welcome to the show");
  });

  it("truncates long scriptText labels", () => {
    const longText = "A".repeat(60);
    const manifest: ManifestForChapters = {
      composition: { fps: 30 },
      timeline: [{ type: "image_scene", scriptText: longText, duration: 5 }],
    };

    const chapters = generateChapters(manifest);
    expect(chapters[0].label).toBe("A".repeat(47) + "...");
  });

  it("uses fallback label when no title or script", () => {
    const manifest: ManifestForChapters = {
      composition: { fps: 30 },
      timeline: [
        { type: "image_scene", duration: 5 },
        { type: "image_scene", duration: 5 },
      ],
    };

    const chapters = generateChapters(manifest);
    expect(chapters[0].label).toBe("Part 1");
    expect(chapters[1].label).toBe("Part 2");
  });

  it("labels intro_card and outro_card appropriately", () => {
    const manifest: ManifestForChapters = {
      composition: { fps: 30 },
      timeline: [
        { type: "intro_card", duration: 3 },
        { type: "image_scene", title: "Main", duration: 10 },
        { type: "outro_card", duration: 3 },
      ],
    };

    const chapters = generateChapters(manifest);
    expect(chapters[0].label).toBe("Intro");
    expect(chapters[2].label).toBe("Outro");
  });

  it("handles duration in seconds (< 1000)", () => {
    const manifest: ManifestForChapters = {
      composition: { fps: 30 },
      timeline: [
        { type: "image_scene", title: "A", duration: 10 },
        { type: "image_scene", title: "B", duration: 20 },
      ],
    };

    const chapters = generateChapters(manifest);
    expect(chapters[1].timestamp).toBe("0:10");
  });
});

describe("formatChaptersForDescription", () => {
  it("returns empty string for fewer than 3 chapters", () => {
    expect(formatChaptersForDescription([
      { timestamp: "0:00", label: "Intro" },
      { timestamp: "0:15", label: "Topic" },
    ])).toBe("");
  });

  it("formats chapters correctly", () => {
    const chapters = [
      { timestamp: "0:00", label: "Intro" },
      { timestamp: "0:15", label: "Topic One" },
      { timestamp: "1:30", label: "Topic Two" },
    ];

    const result = formatChaptersForDescription(chapters);
    expect(result).toBe("0:00 Intro\n0:15 Topic One\n1:30 Topic Two");
  });

  it("ensures first chapter starts at 0:00", () => {
    const chapters = [
      { timestamp: "0:05", label: "Late Start" },
      { timestamp: "0:15", label: "Topic One" },
      { timestamp: "1:30", label: "Topic Two" },
    ];

    const result = formatChaptersForDescription(chapters);
    expect(result).toMatch(/^0:00 Late Start/);
  });
});
