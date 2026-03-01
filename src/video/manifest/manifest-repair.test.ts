import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { repairManifest } from "./manifest-repair.js";

function makeRawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectTitle: "Test",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: {},
    timeline: [],
    ...overrides,
  };
}

describe("repairManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 repairs for a valid manifest", () => {
    const raw = makeRawManifest();
    expect(repairManifest(raw)).toBe(0);
  });

  it("strips null projectTitle", () => {
    const raw = makeRawManifest({ projectTitle: null });
    const repairs = repairManifest(raw);
    expect(repairs).toBeGreaterThan(0);
    expect("projectTitle" in raw).toBe(false);
  });

  it("strips null branding fields", () => {
    const raw = makeRawManifest({
      branding: { logoUrl: null, accentColor: null, watermarkPosition: null },
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBe(3);
    const branding = raw.branding as Record<string, unknown>;
    expect("logoUrl" in branding).toBe(false);
    expect("accentColor" in branding).toBe(false);
    expect("watermarkPosition" in branding).toBe(false);
  });

  it("normalizes 'fade' transition style to 'crossfade'", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "transition", style: "fade", duration: 15, startAtFrame: 0 },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBeGreaterThan(0);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.style).toBe("crossfade");
  });

  it("normalizes 'hard-cut' transition style to 'cut'", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "transition", style: "hard-cut", duration: 15, startAtFrame: 0 },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.style).toBe("cut");
  });

  it("normalizes 'slide' transition style to 'wipe-left'", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "transition", style: "slide", duration: 15, startAtFrame: 0 },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.style).toBe("wipe-left");
  });

  it("leaves valid transition styles unchanged", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "transition", style: "crossfade", duration: 15, startAtFrame: 0 },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBe(0);
  });

  it("rounds fractional frame numbers to integers", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "video_clip", startAtFrame: 10.7, trimStart: 5.3, duration: 150.9 },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBe(3);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.startAtFrame).toBe(11);
    expect(entry.trimStart).toBe(5);
    expect(entry.duration).toBe(151);
  });

  it("fixes negative startAtFrame to 0", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "video_clip", startAtFrame: -5, duration: 150, trimStart: 0 },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBeGreaterThan(0);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.startAtFrame).toBe(0);
  });

  it("enforces minimum duration of 30 frames for video_clip", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "video_clip", startAtFrame: 0, duration: 10, trimStart: 0 },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBeGreaterThan(0);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.duration).toBe(30);
  });

  it("enforces minimum duration of 30 frames for title_card", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "title_card", startAtFrame: 0, duration: 5, title: "Hi" },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.duration).toBe(30);
  });

  it("sets transition duration to 15 when less than 1", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "transition", style: "crossfade", duration: 0, startAtFrame: 0 },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.duration).toBe(15);
  });

  it("normalizes invalid title_card animation styles", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "title_card", startAtFrame: 0, duration: 90, title: "Hi", animation: "zoom-in" },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.animation).toBe("fade");
  });

  it("normalizes slide-ish animation to slide-up", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "title_card", startAtFrame: 0, duration: 90, title: "Hi", animation: "slide-down" },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.animation).toBe("slide-up");
  });

  it("normalizes type-ish animation to typewriter", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "title_card", startAtFrame: 0, duration: 90, title: "Hi", animation: "typewrite" },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.animation).toBe("typewriter");
  });

  it("strips null title_card subtitle and background", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "title_card", startAtFrame: 0, duration: 90, title: "Hi", subtitle: null, background: null },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBe(2);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect("subtitle" in entry).toBe(false);
    expect("background" in entry).toBe(false);
  });

  it("normalizes overlay component names case-insensitively", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "overlay", component: "smartcaptions", startAtFrame: 0 },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.component).toBe("SmartCaptions");
  });

  it("clamps volume to 0-1 range", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "video_clip", startAtFrame: 0, duration: 150, trimStart: 0, volume: 1.5 },
        { type: "video_clip", startAtFrame: 150, duration: 150, trimStart: 0, volume: -0.5 },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBe(2);
    const entries = raw.timeline as Record<string, unknown>[];
    expect(entries[0].volume).toBe(1);
    expect(entries[1].volume).toBe(0);
  });

  it("fixes fractional frame numbers in effects", () => {
    const raw = makeRawManifest({
      timeline: [
        {
          type: "video_clip",
          startAtFrame: 0,
          duration: 150,
          trimStart: 0,
          effects: [{ type: "blur", startFrame: 10.5, endFrame: 50.7, durationFrames: 20.3 }],
        },
      ],
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBe(3);
    const effects = ((raw.timeline as Record<string, unknown>[])[0].effects as Record<string, unknown>[])[0];
    expect(effects.startFrame).toBe(11);
    expect(effects.endFrame).toBe(51);
    expect(effects.durationFrames).toBe(20);
  });

  it("repairs audioLayer music volume clamping", () => {
    const raw = makeRawManifest({
      audioLayer: { music: { volume: 2.0, track: "/music.mp3", ducking: false } },
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBeGreaterThan(0);
    const music = (raw.audioLayer as Record<string, unknown>).music as Record<string, unknown>;
    expect(music.volume).toBe(1);
  });

  it("repairs audioLayer music fractional frame numbers", () => {
    const raw = makeRawManifest({
      audioLayer: { music: { volume: 0.5, track: "/m.mp3", ducking: false, fadeInFrames: 10.3, fadeOutFrames: 20.7 } },
    });
    const repairs = repairManifest(raw);
    expect(repairs).toBe(2);
    const music = (raw.audioLayer as Record<string, unknown>).music as Record<string, unknown>;
    expect(music.fadeInFrames).toBe(10);
    expect(music.fadeOutFrames).toBe(21);
  });

  it("repairs fractional llmTokensUsed in metadata", () => {
    const raw = makeRawManifest({
      metadata: { llmTokensUsed: 1234.5, sourceClips: [] },
    });
    repairManifest(raw);
    const metadata = raw.metadata as Record<string, unknown>;
    expect(metadata.llmTokensUsed).toBe(1235);
  });

  it("initializes sourceClips to empty array when not an array", () => {
    const raw = makeRawManifest({
      metadata: { sourceClips: "not-an-array" },
    });
    repairManifest(raw);
    const metadata = raw.metadata as Record<string, unknown>;
    expect(metadata.sourceClips).toEqual([]);
  });

  it("defaults unknown transition style to crossfade", () => {
    const raw = makeRawManifest({
      timeline: [
        { type: "transition", style: "totally-made-up", duration: 15, startAtFrame: 0 },
      ],
    });
    repairManifest(raw);
    const entry = (raw.timeline as Record<string, unknown>[])[0];
    expect(entry.style).toBe("crossfade");
  });
});
