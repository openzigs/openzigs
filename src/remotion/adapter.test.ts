/**
 * Director Mode — Manifest Adapter Tests
 * Issue #245
 */

import { describe, it, expect } from "vitest";
import { adaptManifest } from "./adapter.js";
import type { DirectorManifest } from "../video/manifest/manifest-types.js";

function buildMinimalManifest(): DirectorManifest {
  return {
    projectTitle: "Test Project",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: { music: null, voiceover: null },
    timeline: [
      {
        type: "video_clip",
        source: "/clips/intro.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 90,
        volume: 0.8,
      },
    ],
  };
}

describe("adaptManifest", () => {
  const outputDir = "/renders/job-001";

  it("returns valid CompositionInputProps structure", () => {
    const result = adaptManifest(buildMinimalManifest(), outputDir);
    expect(result.templateId).toBe("Minimalist");
    expect(result.projectTitle).toBe("Test Project");
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.fps).toBe(30);
    expect(result.durationInFrames).toBeGreaterThanOrEqual(30);
  });

  it("calculates durationInFrames from timeline", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      { type: "video_clip", source: "/a.mp4", startAtFrame: 0, trimStart: 0, duration: 60 },
      { type: "video_clip", source: "/b.mp4", startAtFrame: 60, trimStart: 0, duration: 90 },
    ];
    const result = adaptManifest(manifest, outputDir);
    // Last entry ends at 60 + 90 = 150
    expect(result.durationInFrames).toBe(150);
  });

  it("enforces minimum duration of 1 second", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [];
    const result = adaptManifest(manifest, outputDir);
    expect(result.durationInFrames).toBe(30); // fps = 30
  });

  it("transforms video_clip entries", () => {
    const result = adaptManifest(buildMinimalManifest(), outputDir);
    expect(result.timeline).toHaveLength(1);
    const clip = result.timeline[0];
    expect(clip.type).toBe("video_clip");
    if (clip.type === "video_clip") {
      expect(clip.src).toBe("/clips/intro.mp4");
      expect(clip.startAtFrame).toBe(0);
      expect(clip.trimStartFrame).toBe(0);
      expect(clip.durationInFrames).toBe(90);
      expect(clip.volume).toBe(0.8);
    }
  });

  it("transforms title_card entries", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "title_card",
        title: "Hello",
        subtitle: "World",
        background: "#000",
        startAtFrame: 0,
        duration: 60,
        animation: "slide-up",
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const card = result.timeline[0];
    expect(card.type).toBe("title_card");
    if (card.type === "title_card") {
      expect(card.title).toBe("Hello");
      expect(card.subtitle).toBe("World");
      expect(card.animation).toBe("slide-up");
    }
  });

  it("transforms transition entries", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline.push({
      type: "transition",
      style: "crossfade",
      duration: 15,
      startAtFrame: 75,
    });
    const result = adaptManifest(manifest, outputDir);
    const transition = result.timeline.find((t) => t.type === "transition");
    expect(transition).toBeDefined();
    if (transition?.type === "transition") {
      expect(transition.style).toBe("crossfade");
      expect(transition.durationInFrames).toBe(15);
    }
  });

  it("transforms overlay entries", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline.push({
      type: "overlay",
      component: "SmartCaptions",
      props: { text: "hello" },
      startAtFrame: 0,
      duration: 90,
    });
    const result = adaptManifest(manifest, outputDir);
    const overlay = result.timeline.find((t) => t.type === "overlay");
    expect(overlay).toBeDefined();
    if (overlay?.type === "overlay") {
      expect(overlay.component).toBe("SmartCaptions");
    }
  });

  it("adapts audio with music config", () => {
    const manifest = buildMinimalManifest();
    manifest.audioLayer = {
      music: {
        track: "~/music/bg.mp3",
        volume: 0.5,
        ducking: false,
        fadeInFrames: 30,
        fadeOutFrames: 15,
        loop: true,
      },
      voiceover: null,
    };
    const result = adaptManifest(manifest, outputDir);
    expect(result.audio.music).not.toBeNull();
    expect(result.audio.music!.volume).toBe(0.5);
    expect(result.audio.music!.loop).toBe(true);
    expect(result.audio.music!.fadeInFrames).toBe(30);
    expect(result.audio.music!.fadeOutFrames).toBe(15);
  });

  it("adapts audio with voiceover config", () => {
    const manifest = buildMinimalManifest();
    manifest.audioLayer = {
      music: null,
      voiceover: {
        source: "/voice/narration.mp3",
        volume: 0.9,
        startAtFrame: 30,
      },
    };
    const result = adaptManifest(manifest, outputDir);
    expect(result.audio.voiceover).not.toBeNull();
    expect(result.audio.voiceover!.volume).toBe(0.9);
    expect(result.audio.voiceover!.startAtFrame).toBe(30);
  });

  it("uses default branding when not specified", () => {
    const result = adaptManifest(buildMinimalManifest(), outputDir);
    expect(result.branding.accentColor).toBe("#3b82f6");
    expect(result.branding.fontFamily).toContain("Inter");
    expect(result.branding.watermarkOpacity).toBe(0.3);
    expect(result.branding.watermarkPosition).toBe("bottom-right");
  });

  it("adapts custom branding", () => {
    const manifest = buildMinimalManifest();
    manifest.branding = {
      logoUrl: "https://example.com/logo.png",
      accentColor: "#ff0000",
      fontFamily: "Roboto",
      watermarkOpacity: 0.5,
      watermarkPosition: "top-left",
    };
    const result = adaptManifest(manifest, outputDir);
    expect(result.branding.logoUrl).toBe("https://example.com/logo.png");
    expect(result.branding.accentColor).toBe("#ff0000");
    expect(result.branding.watermarkPosition).toBe("top-left");
  });

  it("transforms image_scene entries", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "image_scene",
        src: "/images/scene-001.png",
        startAtFrame: 0,
        duration: 450,
        voiceover: "/audio/vo-001.mp3",
        voiceoverVolume: 0.9,
        kenBurns: {
          scaleFrom: 1.0,
          scaleTo: 1.2,
          translateXFrom: 0,
          translateXTo: -15,
        },
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const scene = result.timeline[0];
    expect(scene.type).toBe("image_scene");
    if (scene.type === "image_scene") {
      expect(scene.src).toBe("/images/scene-001.png");
      expect(scene.startAtFrame).toBe(0);
      expect(scene.durationInFrames).toBe(450);
      expect(scene.voiceover).toBe("/audio/vo-001.mp3");
      expect(scene.voiceoverVolume).toBe(0.9);
      expect(scene.kenBurns).toEqual({
        scaleFrom: 1.0,
        scaleTo: 1.2,
        translateXFrom: 0,
        translateXTo: -15,
        translateYFrom: 0,
        translateYTo: -5,
      });
    }
  });

  it("handles image_scene without optional voiceover", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "image_scene",
        src: "/images/scene.png",
        startAtFrame: 0,
        duration: 300,
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const scene = result.timeline[0];
    if (scene.type === "image_scene") {
      expect(scene.voiceover).toBeUndefined();
      expect(scene.voiceoverVolume).toBe(1);
      expect(scene.kenBurns).toEqual({
        scaleFrom: 1,
        scaleTo: 1.15,
        translateXFrom: 0,
        translateXTo: -10,
        translateYFrom: 0,
        translateYTo: -5,
      });
    }
  });

  it("calculates duration correctly with image_scene entries", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      { type: "image_scene", src: "/a.png", startAtFrame: 0, duration: 300 },
      { type: "image_scene", src: "/b.png", startAtFrame: 300, duration: 450 },
    ];
    const result = adaptManifest(manifest, outputDir);
    // Last entry ends at 300 + 450 = 750
    expect(result.durationInFrames).toBe(750);
  });

  // ── Additional coverage tests ──

  it("throws on unknown timeline entry type", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      { type: "unknown_type" as never, startAtFrame: 0, duration: 30 } as never,
    ];
    expect(() => adaptManifest(manifest, outputDir)).toThrow("Unknown timeline entry type");
  });

  it("transforms intro_card entries", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "intro_card",
        title: "Welcome",
        subtitle: "To the show",
        backgroundSrc: "/bg.png",
        logoSrc: "/logo.png",
        startAtFrame: 0,
        duration: 90,
        animation: "fade-in",
      } as never,
    ];
    const result = adaptManifest(manifest, outputDir);
    const card = result.timeline[0];
    expect(card.type).toBe("intro_card");
    if (card.type === "intro_card") {
      expect(card.title).toBe("Welcome");
      expect(card.subtitle).toBe("To the show");
      expect(card.animation).toBe("fade-in");
      expect(card.backgroundSrc).toBe("/bg.png");
      expect(card.logoSrc).toBe("/logo.png");
    }
  });

  it("transforms outro_card entries", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "outro_card",
        title: "Thanks",
        subtitle: "See you next time",
        ctaText: "Subscribe",
        startAtFrame: 0,
        duration: 90,
      } as never,
    ];
    const result = adaptManifest(manifest, outputDir);
    const card = result.timeline[0];
    expect(card.type).toBe("outro_card");
    if (card.type === "outro_card") {
      expect(card.title).toBe("Thanks");
      expect(card.ctaText).toBe("Subscribe");
      expect(card.animation).toBe("fade-out");
    }
  });

  it("intro_card prefers enhancedBackgroundSrc over backgroundSrc", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "intro_card",
        title: "Title",
        backgroundSrc: "/bg.png",
        enhancedBackgroundSrc: "/bg-enhanced.png",
        startAtFrame: 0,
        duration: 60,
      } as never,
    ];
    const result = adaptManifest(manifest, outputDir);
    const card = result.timeline[0];
    if (card.type === "intro_card") {
      expect(card.backgroundSrc).toBe("/bg-enhanced.png");
    }
  });

  it("outro_card prefers enhancedBackgroundSrc over backgroundSrc", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "outro_card",
        title: "End",
        backgroundSrc: "/bg.png",
        enhancedBackgroundSrc: "/bg-enhanced.png",
        startAtFrame: 0,
        duration: 60,
      } as never,
    ];
    const result = adaptManifest(manifest, outputDir);
    const card = result.timeline[0];
    if (card.type === "outro_card") {
      expect(card.backgroundSrc).toBe("/bg-enhanced.png");
    }
  });

  it("intro_card without any background or logo", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "intro_card",
        title: "Plain",
        startAtFrame: 0,
        duration: 60,
      } as never,
    ];
    const result = adaptManifest(manifest, outputDir);
    const card = result.timeline[0];
    if (card.type === "intro_card") {
      expect(card.backgroundSrc).toBeUndefined();
      expect(card.logoSrc).toBeUndefined();
    }
  });

  it("video_clip applies default effects and textOverlays", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "video_clip",
        source: "/clip.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 60,
        effects: [{ type: "fade" }],
        textOverlays: [
          {
            id: "ov1",
            text: "Hello",
            position: "center",
          },
        ],
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const clip = result.timeline[0];
    if (clip.type === "video_clip") {
      expect(clip.effects).toHaveLength(1);
      expect(clip.effects![0].type).toBe("fade");
      expect(clip.textOverlays).toHaveLength(1);
      expect(clip.textOverlays![0].text).toBe("Hello");
      expect(clip.textOverlays![0].fontSize).toBe(48);
      expect(clip.textOverlays![0].fontWeight).toBe("bold");
      expect(clip.textOverlays![0].color).toBe("#ffffff");
    }
  });

  it("video_clip defaults volume to 1 when not specified", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "video_clip",
        source: "/clip.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 60,
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const clip = result.timeline[0];
    if (clip.type === "video_clip") {
      expect(clip.volume).toBe(1);
    }
  });

  it("video_clip defaults fitMode to cover", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "video_clip",
        source: "/clip.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 60,
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const clip = result.timeline[0];
    if (clip.type === "video_clip") {
      expect(clip.fitMode).toBe("cover");
      expect(clip.horizontalCropOffset).toBe(50);
    }
  });

  it("title_card defaults background and animation", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "title_card",
        title: "Test",
        startAtFrame: 0,
        duration: 30,
      } as never,
    ];
    const result = adaptManifest(manifest, outputDir);
    const card = result.timeline[0];
    if (card.type === "title_card") {
      expect(card.background).toBe("#1a1a1a");
      expect(card.animation).toBe("fade");
    }
  });

  it("adapts audio with default values", () => {
    const manifest = buildMinimalManifest();
    manifest.audioLayer = {
      music: { track: "/bg.mp3" } as never,
      voiceover: { source: "/vo.mp3" } as never,
    };
    const result = adaptManifest(manifest, outputDir);
    expect(result.audio.music!.volume).toBe(1);
    expect(result.audio.music!.loop).toBe(true);
    expect(result.audio.music!.fadeInFrames).toBe(0);
    expect(result.audio.music!.fadeOutFrames).toBe(0);
    expect(result.audio.music!.ducking).toBe(false);
    expect(result.audio.voiceover!.volume).toBe(1);
    expect(result.audio.voiceover!.startAtFrame).toBe(0);
  });

  it("handles null audioLayer gracefully", () => {
    const manifest = buildMinimalManifest();
    manifest.audioLayer = undefined as never;
    const result = adaptManifest(manifest, outputDir);
    expect(result.audio.music).toBeNull();
    expect(result.audio.voiceover).toBeNull();
  });

  it("image_scene with textOverlays", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "image_scene",
        src: "/img.png",
        startAtFrame: 0,
        duration: 150,
        textOverlays: [
          {
            id: "t1",
            text: "Caption",
            position: "bottom",
          },
        ],
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const scene = result.timeline[0];
    if (scene.type === "image_scene") {
      expect(scene.textOverlays).toHaveLength(1);
      expect(scene.textOverlays![0].text).toBe("Caption");
      expect(scene.textOverlays![0].backgroundColor).toBe("rgba(0,0,0,0.6)");
    }
  });

  it("handles empty timeline", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [];
    const result = adaptManifest(manifest, outputDir);
    expect(result.timeline).toEqual([]);
    // Duration should be fps (minimum 1 second)
    expect(result.durationInFrames).toBe(30);
  });

  it("handles timeline entry without duration", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      {
        type: "video_clip",
        source: "/clip.mp4",
        startAtFrame: 10,
        trimStart: 0,
      } as never,
    ];
    const result = adaptManifest(manifest, outputDir);
    // duration is undefined → treated as 0, so maxFrame = 10, but min is fps=30
    expect(result.durationInFrames).toBe(30);
  });

  it("preserves branding undefined logoUrl", () => {
    const manifest = buildMinimalManifest();
    // No branding at all
    const result = adaptManifest(manifest, outputDir);
    expect(result.branding.logoUrl).toBeUndefined();
  });

  it("mixed timeline with all entry types", () => {
    const manifest = buildMinimalManifest();
    manifest.timeline = [
      { type: "video_clip", source: "/a.mp4", startAtFrame: 0, trimStart: 0, duration: 30 },
      { type: "title_card", title: "T", startAtFrame: 30, duration: 30 } as never,
      { type: "transition", style: "crossfade", startAtFrame: 60, duration: 10 },
      { type: "image_scene", src: "/img.png", startAtFrame: 70, duration: 20 },
      { type: "overlay", component: "Logo", props: {}, startAtFrame: 0, duration: 90 },
    ];
    const result = adaptManifest(manifest, outputDir);
    expect(result.timeline).toHaveLength(5);
    expect(result.timeline.map((t) => t.type)).toEqual([
      "video_clip", "title_card", "transition", "image_scene", "overlay",
    ]);
    expect(result.durationInFrames).toBe(90);
  });
});
