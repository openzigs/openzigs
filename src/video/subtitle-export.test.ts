import { describe, it, expect } from "vitest";
import {
  extractSubtitleSegments,
  formatSrtTimestamp,
  formatVttTimestamp,
  generateSrt,
  generateVtt,
  generateSubtitles,
} from "./subtitle-export.js";
import type { ManifestForSubtitles, SubtitleSegment } from "./subtitle-export.js";

describe("subtitle-export", () => {
  // ── formatSrtTimestamp ──────────────────────────────────

  describe("formatSrtTimestamp", () => {
    it("formats zero", () => {
      expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    });

    it("formats sub-second", () => {
      expect(formatSrtTimestamp(500)).toBe("00:00:00,500");
    });

    it("formats seconds + millis", () => {
      expect(formatSrtTimestamp(5_123)).toBe("00:00:05,123");
    });

    it("formats minutes", () => {
      expect(formatSrtTimestamp(75_000)).toBe("00:01:15,000");
    });

    it("formats hours", () => {
      expect(formatSrtTimestamp(3_661_500)).toBe("01:01:01,500");
    });

    it("clamps negative to zero", () => {
      expect(formatSrtTimestamp(-100)).toBe("00:00:00,000");
    });
  });

  // ── formatVttTimestamp ──────────────────────────────────

  describe("formatVttTimestamp", () => {
    it("uses dot separator instead of comma", () => {
      expect(formatVttTimestamp(5_123)).toBe("00:00:05.123");
    });

    it("formats zero", () => {
      expect(formatVttTimestamp(0)).toBe("00:00:00.000");
    });
  });

  // ── extractSubtitleSegments ────────────────────────────

  describe("extractSubtitleSegments", () => {
    it("returns empty for manifest without timeline", () => {
      expect(extractSubtitleSegments({})).toEqual([]);
    });

    it("returns empty for empty timeline", () => {
      expect(extractSubtitleSegments({ timeline: [] })).toEqual([]);
    });

    it("extracts segments from scenes with scriptText", () => {
      const manifest: ManifestForSubtitles = {
        composition: { fps: 30 },
        timeline: [
          { scriptText: "Hello world", duration: 3000 },
          { type: "transition", duration: 500 },
          { scriptText: "Second segment", durationInFrames: 150 },
        ],
      };

      const segments = extractSubtitleSegments(manifest);
      expect(segments).toHaveLength(2);
      expect(segments[0]).toEqual({ text: "Hello world", durationMs: 3000 });
      expect(segments[1]).toEqual({ text: "Second segment", durationMs: 5000 }); // 150/30*1000
    });

    it("skips scenes without scriptText", () => {
      const manifest: ManifestForSubtitles = {
        timeline: [
          { title: "Intro", duration: 5000 },
          { scriptText: "Narration here", duration: 8000 },
        ],
      };

      const segments = extractSubtitleSegments(manifest);
      expect(segments).toHaveLength(1);
      expect(segments[0].text).toBe("Narration here");
    });

    it("trims whitespace from scriptText", () => {
      const manifest: ManifestForSubtitles = {
        timeline: [{ scriptText: "  padded text  ", duration: 2000 }],
      };

      expect(extractSubtitleSegments(manifest)[0].text).toBe("padded text");
    });

    it("uses default 5s for scenes without duration", () => {
      const manifest: ManifestForSubtitles = {
        timeline: [{ scriptText: "No duration" }],
      };
      expect(extractSubtitleSegments(manifest)[0].durationMs).toBe(5000);
    });

    it("treats duration < 1000 as seconds", () => {
      const manifest: ManifestForSubtitles = {
        timeline: [{ scriptText: "Short", duration: 3 }],
      };
      expect(extractSubtitleSegments(manifest)[0].durationMs).toBe(3000);
    });
  });

  // ── generateSrt ────────────────────────────────────────

  describe("generateSrt", () => {
    it("returns empty string for no segments", () => {
      expect(generateSrt([])).toBe("");
    });

    it("generates correct SRT format", () => {
      const segments: SubtitleSegment[] = [
        { text: "First line", durationMs: 3000 },
        { text: "Second line", durationMs: 5000 },
      ];

      const srt = generateSrt(segments);
      const expected = [
        "1",
        "00:00:00,000 --> 00:00:03,000",
        "First line",
        "",
        "2",
        "00:00:03,000 --> 00:00:08,000",
        "Second line",
        "",
      ].join("\n");

      expect(srt).toBe(expected);
    });

    it("accumulates timestamps across segments", () => {
      const segments: SubtitleSegment[] = [
        { text: "A", durationMs: 10_000 },
        { text: "B", durationMs: 20_000 },
        { text: "C", durationMs: 30_000 },
      ];

      const srt = generateSrt(segments);
      expect(srt).toContain("00:00:00,000 --> 00:00:10,000");
      expect(srt).toContain("00:00:10,000 --> 00:00:30,000");
      expect(srt).toContain("00:00:30,000 --> 00:01:00,000");
    });
  });

  // ── generateVtt ────────────────────────────────────────

  describe("generateVtt", () => {
    it("returns header-only for no segments", () => {
      expect(generateVtt([])).toBe("WEBVTT\n");
    });

    it("generates correct VTT format with header", () => {
      const segments: SubtitleSegment[] = [
        { text: "First line", durationMs: 3000 },
      ];

      const vtt = generateVtt(segments);
      expect(vtt).toContain("WEBVTT");
      expect(vtt).toContain("00:00:00.000 --> 00:00:03.000");
      expect(vtt).toContain("First line");
    });

    it("uses dot as millisecond separator", () => {
      const segments: SubtitleSegment[] = [
        { text: "Test", durationMs: 1500 },
      ];

      const vtt = generateVtt(segments);
      expect(vtt).not.toContain(",");
      expect(vtt).toContain("00:00:00.000 --> 00:00:01.500");
    });
  });

  // ── generateSubtitles (integration) ───────────────────

  describe("generateSubtitles", () => {
    const manifest: ManifestForSubtitles = {
      composition: { fps: 30 },
      timeline: [
        { scriptText: "Welcome to this video.", duration: 4000 },
        { type: "transition", duration: 500 },
        { scriptText: "Let's dive in.", duration: 6000 },
      ],
    };

    it("generates SRT from manifest", () => {
      const srt = generateSubtitles(manifest, "srt");
      expect(srt).toContain("1\n00:00:00,000 --> 00:00:04,000");
      expect(srt).toContain("Welcome to this video.");
      expect(srt).toContain("2\n00:00:04,000 --> 00:00:10,000");
      expect(srt).toContain("Let's dive in.");
    });

    it("generates VTT from manifest", () => {
      const vtt = generateSubtitles(manifest, "vtt");
      expect(vtt.startsWith("WEBVTT")).toBe(true);
      expect(vtt).toContain("00:00:00.000 --> 00:00:04.000");
      expect(vtt).toContain("Welcome to this video.");
    });

    it("returns empty SRT for manifest with no narration", () => {
      const emptyManifest: ManifestForSubtitles = { timeline: [{ title: "No narration" }] };
      expect(generateSubtitles(emptyManifest, "srt")).toBe("");
    });

    it("returns header-only VTT for manifest with no narration", () => {
      const emptyManifest: ManifestForSubtitles = { timeline: [{ title: "No narration" }] };
      expect(generateSubtitles(emptyManifest, "vtt")).toBe("WEBVTT\n");
    });
  });
});
