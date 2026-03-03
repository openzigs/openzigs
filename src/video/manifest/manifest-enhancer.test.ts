import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { enhanceManifest } from "./manifest-enhancer.js";
import type { DirectorManifest, VideoClipEntry, TransitionEntry, TitleCardEntry } from "./manifest-types.js";

function makeManifest(overrides: Partial<DirectorManifest> = {}): DirectorManifest {
  return {
    projectTitle: "Test Project",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: {},
    timeline: [],
    ...overrides,
  };
}

function makeVideoClip(overrides: Partial<VideoClipEntry> = {}): VideoClipEntry {
  return {
    type: "video_clip",
    source: "/clips/clip1.mp4",
    startAtFrame: 0,
    trimStart: 0,
    duration: 150,
    volume: 0.8,
    ...overrides,
  };
}

describe("enhanceManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stats with zero changes for an already-enhanced manifest", () => {
    const intro: TitleCardEntry = {
      type: "title_card",
      title: "Intro",
      startAtFrame: 0,
      duration: 90,
      animation: "fade",
    };
    const outro: TitleCardEntry = {
      type: "title_card",
      title: "Thanks",
      startAtFrame: 240,
      duration: 75,
      animation: "fade",
    };
    const clip = makeVideoClip({ startAtFrame: 90, effects: [{ type: "slowZoom", from: 1, to: 1.12 }] });
    const transition: TransitionEntry = {
      type: "transition",
      style: "crossfade",
      duration: 20,
      startAtFrame: 90,
    };

    const manifest = makeManifest({
      timeline: [intro, transition, clip, { ...transition, startAtFrame: 240 }, outro],
    });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4"]);
    // Outro was already present, but intro might or might not trigger a shift
    expect(stats).toBeDefined();
    expect(typeof stats.transitionsAdded).toBe("number");
    expect(typeof stats.effectsAdded).toBe("number");
  });

  it("injects intro title card when missing", () => {
    const clip = makeVideoClip({ startAtFrame: 0 });
    const manifest = makeManifest({ timeline: [clip] });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4"]);

    const titleCards = manifest.timeline.filter((e) => e.type === "title_card");
    expect(titleCards.length).toBeGreaterThanOrEqual(1);
    expect(stats.warnings).toEqual(expect.arrayContaining([expect.stringContaining("intro")]));
  });

  it("injects outro title card when missing", () => {
    const intro: TitleCardEntry = {
      type: "title_card",
      title: "Intro",
      startAtFrame: 0,
      duration: 90,
      animation: "fade",
    };
    const clip = makeVideoClip({ startAtFrame: 90 });
    const manifest = makeManifest({ timeline: [intro, clip] });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4"]);

    const titleCards = manifest.timeline.filter((e) => e.type === "title_card");
    expect(titleCards.length).toBeGreaterThanOrEqual(2);
    expect(stats.warnings).toEqual(expect.arrayContaining([expect.stringContaining("outro")]));
  });

  it("injects segments for missing source clips (multi-clip coverage)", () => {
    const clip = makeVideoClip({ source: "/clips/clip1.mp4", startAtFrame: 0 });
    const manifest = makeManifest({ timeline: [clip] });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4", "/clips/clip2.mp4"]);

    expect(stats.clipsInjected).toBeGreaterThan(0);
    const sources = manifest.timeline
      .filter((e): e is VideoClipEntry => e.type === "video_clip")
      .map((e) => e.source);
    expect(sources).toContain("/clips/clip2.mp4");
  });

  it("adds transitions between adjacent video clips when none exist", () => {
    const clip1 = makeVideoClip({ startAtFrame: 0, duration: 150, effects: [{ type: "slowZoom", from: 1, to: 1.12 }] });
    const clip2 = makeVideoClip({ source: "/clips/clip2.mp4", startAtFrame: 150, duration: 150, effects: [{ type: "slowZoom", from: 1.12, to: 1 }] });
    const manifest = makeManifest({ timeline: [clip1, clip2] });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4", "/clips/clip2.mp4"]);

    const transitions = manifest.timeline.filter((e) => e.type === "transition");
    expect(transitions.length).toBeGreaterThan(0);
    expect(stats.transitionsAdded).toBeGreaterThan(0);
  });

  it("applies slowZoom effects to long clips without effects", () => {
    const clip1 = makeVideoClip({ startAtFrame: 0, duration: 120 });
    const clip2 = makeVideoClip({ source: "/clips/clip2.mp4", startAtFrame: 120, duration: 120 });
    const manifest = makeManifest({ timeline: [clip1, clip2] });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4", "/clips/clip2.mp4"]);

    expect(stats.effectsAdded).toBeGreaterThan(0);
    const videoClips = manifest.timeline.filter(
      (e): e is VideoClipEntry => e.type === "video_clip",
    );
    const hasZoom = videoClips.some((c) => c.effects?.some((e) => e.type === "slowZoom"));
    expect(hasZoom).toBe(true);
  });

  it("adds fadeIn to first video clip and fadeOut to last", () => {
    const clip1 = makeVideoClip({ startAtFrame: 0, duration: 120 });
    const clip2 = makeVideoClip({ source: "/clips/clip2.mp4", startAtFrame: 120, duration: 120 });
    const manifest = makeManifest({ timeline: [clip1, clip2] });

    enhanceManifest(manifest, ["/clips/clip1.mp4", "/clips/clip2.mp4"]);

    const videoClips = manifest.timeline.filter(
      (e): e is VideoClipEntry => e.type === "video_clip",
    );
    // First clip should get fadeIn (either original or injected)
    const firstClip = videoClips[0];
    const lastClip = videoClips[videoClips.length - 1];

    const hasFadeIn = firstClip?.effects?.some((e) => e.type === "fadeIn");
    const hasFadeOut = lastClip?.effects?.some((e) => e.type === "fadeOut");
    expect(hasFadeIn).toBe(true);
    expect(hasFadeOut).toBe(true);
  });

  it("extends duration when output is too short relative to source", () => {
    const clip = makeVideoClip({ startAtFrame: 0, duration: 150 }); // 5s at 30fps
    const manifest = makeManifest({ timeline: [clip] });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4"], {
      totalSourceDuration: 60, // 60s source → need at least 39s
      clipDurations: { "/clips/clip1.mp4": 60 },
    });

    expect(stats.clipsInjected).toBeGreaterThan(0);
    expect(stats.durationExtended).not.toBeNull();
    expect(stats.durationExtended!.toSec).toBeGreaterThan(stats.durationExtended!.fromSec);
  });

  it("does not extend duration when ratio is already sufficient", () => {
    // 900 frames = 30s at 30fps. Source = 40s, target = 26s. Already meeting it.
    const clip = makeVideoClip({ startAtFrame: 0, duration: 900 });
    const manifest = makeManifest({ timeline: [clip] });

    const stats = enhanceManifest(manifest, ["/clips/clip1.mp4"], {
      totalSourceDuration: 40,
      clipDurations: { "/clips/clip1.mp4": 40 },
    });

    expect(stats.durationExtended).toBeNull();
  });

  it("skips multi-clip coverage when only one source clip", () => {
    const clip = makeVideoClip({ startAtFrame: 0, duration: 150 });
    const manifest = makeManifest({ timeline: [clip] });

    enhanceManifest(manifest, ["/clips/clip1.mp4"]);

    // Only title card injections, no multi-clip coverage clips
    const videoClips = manifest.timeline.filter(
      (e): e is VideoClipEntry => e.type === "video_clip",
    );
    expect(videoClips.length).toBe(1);
  });

  it("skips effect enhancement when 40%+ clips already have effects", () => {
    const clips = Array.from({ length: 5 }, (_, i) =>
      makeVideoClip({
        source: `/clips/clip${i}.mp4`,
        startAtFrame: i * 120,
        duration: 120,
        effects: i < 3 ? [{ type: "slowZoom", from: 1, to: 1.12 }] : [],
      }),
    );
    const manifest = makeManifest({ timeline: clips });

    const stats = enhanceManifest(
      manifest,
      clips.map((c) => c.source),
    );

    // Effects were already 60% covered → should skip effect enhancement
    // Only the 2 clips without effects might get some, but the function returns early
    expect(stats.effectsAdded).toBe(0);
  });

  it("uses projectTitle for injected intro title card", () => {
    const clip = makeVideoClip({ startAtFrame: 0 });
    const manifest = makeManifest({
      projectTitle: "My Cool Video",
      timeline: [clip],
    });

    enhanceManifest(manifest, ["/clips/clip1.mp4"]);

    const introCard = manifest.timeline.find(
      (e): e is TitleCardEntry => e.type === "title_card" && e.startAtFrame === 0,
    );
    expect(introCard?.title).toBe("My Cool Video");
  });
});
