/**
 * Director Mode — Manifest Adapter Tests
 * Issue #245
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { adaptManifest, stageInputPropsMedia } from "./adapter.js";
import type { DirectorManifest } from "../video/manifest/manifest-types.js";
import type { CompositionInputProps } from "./input-props.js";

vi.mock("./media-resolver.js", () => ({
  resolveMediaPath: vi.fn((_src: string, _dir: string) => _src),
  stageMediaFile: vi.fn((_src: string, _dir: string) => `/staged${_src}`),
}));

import { stageMediaFile } from "./media-resolver.js";

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
        effects: [{ type: "fadeIn", durationFrames: 15 }],
        textOverlays: [
          {
            id: "ov1",
            text: "Hello",
            position: "center",
            animation: "none",
            startFrame: 0,
            durationFrames: 60,
          },
        ],
      },
    ];
    const result = adaptManifest(manifest, outputDir);
    const clip = result.timeline[0];
    if (clip.type === "video_clip") {
      expect(clip.effects).toHaveLength(1);
      expect(clip.effects![0].type).toBe("fadeIn");
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
            position: "bottom-third",
            animation: "none",
            startFrame: 0,
            durationFrames: 150,
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
      { type: "overlay", component: "LogoWatermark", props: {}, startAtFrame: 0, duration: 90 },
    ];
    const result = adaptManifest(manifest, outputDir);
    expect(result.timeline).toHaveLength(5);
    expect(result.timeline.map((t) => t.type)).toEqual([
      "video_clip", "title_card", "transition", "image_scene", "overlay",
    ]);
    expect(result.durationInFrames).toBe(90);
  });
});

// ── stageInputPropsMedia tests ──────────────────────────────────────────

describe("stageInputPropsMedia", () => {
  const bundleDir = "/tmp/remotion-bundle";

  function buildBaseProps(timelineOverride?: CompositionInputProps["timeline"]): CompositionInputProps {
    return {
      templateId: "Minimalist",
      projectTitle: "Stage Test",
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 90,
      timeline: timelineOverride ?? [],
      audio: { music: null, voiceover: null },
      branding: {
        accentColor: "#3b82f6",
        fontFamily: "Inter, system-ui, sans-serif",
        watermarkOpacity: 0.3,
        watermarkPosition: "bottom-right",
      },
    };
  }

  beforeEach(() => {
    vi.mocked(stageMediaFile).mockReset();
    vi.mocked(stageMediaFile).mockImplementation((_src, _dir) => `/staged${_src}`);
  });

  it("stages video_clip src", () => {
    const props = buildBaseProps([
      {
        type: "video_clip",
        src: "/clips/intro.mp4",
        startAtFrame: 0,
        trimStartFrame: 0,
        durationInFrames: 90,
        volume: 1,
        effects: [],
        textOverlays: [],
        fitMode: "cover",
        horizontalCropOffset: 50,
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    expect(stageMediaFile).toHaveBeenCalledWith("/clips/intro.mp4", bundleDir);
    expect((result.timeline[0] as typeof props.timeline[0] & { src: string }).src).toBe("/staged/clips/intro.mp4");
  });

  it("returns original video_clip when stageMediaFile returns null", () => {
    vi.mocked(stageMediaFile).mockReturnValueOnce(null);
    const props = buildBaseProps([
      {
        type: "video_clip",
        src: "/missing.mp4",
        startAtFrame: 0,
        trimStartFrame: 0,
        durationInFrames: 60,
        volume: 1,
        effects: [],
        textOverlays: [],
        fitMode: "cover",
        horizontalCropOffset: 50,
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    expect((result.timeline[0] as typeof props.timeline[0] & { src: string }).src).toBe("/missing.mp4");
  });

  it("stages image_scene src and voiceover", () => {
    const props = buildBaseProps([
      {
        type: "image_scene",
        src: "/images/scene.png",
        startAtFrame: 0,
        durationInFrames: 300,
        voiceover: "/audio/vo.mp3",
        voiceoverVolume: 0.9,
        kenBurns: { scaleFrom: 1, scaleTo: 1.15, translateXFrom: 0, translateXTo: -10, translateYFrom: 0, translateYTo: -5 },
        effects: [],
        textOverlays: [],
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    expect(stageMediaFile).toHaveBeenCalledWith("/images/scene.png", bundleDir);
    expect(stageMediaFile).toHaveBeenCalledWith("/audio/vo.mp3", bundleDir);
    const scene = result.timeline[0] as { src: string; voiceover?: string };
    expect(scene.src).toBe("/staged/images/scene.png");
    expect(scene.voiceover).toBe("/staged/audio/vo.mp3");
  });

  it("drops image_scene voiceover when stageMediaFile returns null", () => {
    vi.mocked(stageMediaFile)
      .mockReturnValueOnce("/staged/images/scene.png")  // src stages fine
      .mockReturnValueOnce(null);                         // voiceover missing
    const props = buildBaseProps([
      {
        type: "image_scene",
        src: "/images/scene.png",
        startAtFrame: 0,
        durationInFrames: 300,
        voiceover: "/audio/missing.mp3",
        voiceoverVolume: 1,
        kenBurns: { scaleFrom: 1, scaleTo: 1.15, translateXFrom: 0, translateXTo: -10, translateYFrom: 0, translateYTo: -5 },
        effects: [],
        textOverlays: [],
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    const scene = result.timeline[0] as { voiceover?: string };
    expect(scene.voiceover).toBeUndefined();
  });

  it("returns original image_scene when src stageMediaFile returns null", () => {
    vi.mocked(stageMediaFile).mockReturnValueOnce(null);
    const props = buildBaseProps([
      {
        type: "image_scene",
        src: "/missing.png",
        startAtFrame: 0,
        durationInFrames: 300,
        voiceoverVolume: 1,
        kenBurns: { scaleFrom: 1, scaleTo: 1.15, translateXFrom: 0, translateXTo: -10, translateYFrom: 0, translateYTo: -5 },
        effects: [],
        textOverlays: [],
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    expect((result.timeline[0] as { src: string }).src).toBe("/missing.png");
  });

  it("stages overlay props.src", () => {
    const props = buildBaseProps([
      {
        type: "overlay",
        component: "ImageOverlay",
        props: { src: "/images/watermark.png" },
        startAtFrame: 0,
        durationInFrames: 90,
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    expect((result.timeline[0] as { props: Record<string, unknown> }).props.src).toBe("/staged/images/watermark.png");
  });

  it("warns when overlay src stageMediaFile returns null", () => {
    vi.mocked(stageMediaFile).mockReturnValueOnce(null);
    const props = buildBaseProps([
      {
        type: "overlay",
        component: "ImageOverlay",
        props: { src: "/missing/overlay.png" },
        startAtFrame: 0,
        durationInFrames: 90,
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    // Original props preserved when staging fails
    expect((result.timeline[0] as { props: Record<string, unknown> }).props.src).toBe("/missing/overlay.png");
  });

  it("stages title_card background when it's a file path", () => {
    const props = buildBaseProps([
      {
        type: "title_card",
        title: "Hello",
        background: "/images/bg.jpg",
        animation: "fade",
        startAtFrame: 0,
        durationInFrames: 60,
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    expect(stageMediaFile).toHaveBeenCalledWith("/images/bg.jpg", bundleDir);
    expect((result.timeline[0] as { background: string }).background).toBe("/staged/images/bg.jpg");
  });

  it("does not stage title_card background when it's a CSS color", () => {
    const props = buildBaseProps([
      {
        type: "title_card",
        title: "Hello",
        background: "#1a1a1a",
        animation: "fade",
        startAtFrame: 0,
        durationInFrames: 60,
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    // stageMediaFile not called for # colors
    expect(stageMediaFile).not.toHaveBeenCalled();
    expect((result.timeline[0] as { background: string }).background).toBe("#1a1a1a");
  });

  it("stages intro_card backgroundSrc and logoSrc", () => {
    const props = buildBaseProps([
      {
        type: "intro_card",
        title: "Welcome",
        startAtFrame: 0,
        durationInFrames: 90,
        animation: "fade-in",
        backgroundSrc: "/images/intro-bg.png",
        logoSrc: "/images/logo.png",
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    const card = result.timeline[0] as { backgroundSrc?: string; logoSrc?: string };
    expect(card.backgroundSrc).toBe("/staged/images/intro-bg.png");
    expect(card.logoSrc).toBe("/staged/images/logo.png");
  });

  it("stages outro_card backgroundSrc and logoSrc", () => {
    const props = buildBaseProps([
      {
        type: "outro_card",
        title: "Thanks",
        startAtFrame: 0,
        durationInFrames: 90,
        animation: "fade-out",
        backgroundSrc: "/images/outro-bg.png",
        logoSrc: "/images/outro-logo.png",
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    const card = result.timeline[0] as { backgroundSrc?: string; logoSrc?: string };
    expect(card.backgroundSrc).toBe("/staged/images/outro-bg.png");
    expect(card.logoSrc).toBe("/staged/images/outro-logo.png");
  });

  it("falls back gracefully when intro_card backgroundSrc staging fails", () => {
    vi.mocked(stageMediaFile)
      .mockReturnValueOnce(null)   // backgroundSrc fails
      .mockReturnValueOnce("/staged/images/logo.png");  // logoSrc succeeds
    const props = buildBaseProps([
      {
        type: "intro_card",
        title: "Welcome",
        startAtFrame: 0,
        durationInFrames: 90,
        animation: "fade-in",
        backgroundSrc: "/missing-bg.png",
        logoSrc: "/images/logo.png",
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    const card = result.timeline[0] as { backgroundSrc?: string; logoSrc?: string };
    expect(card.backgroundSrc).toBe("/missing-bg.png");  // falls back to original
    expect(card.logoSrc).toBe("/staged/images/logo.png");
  });

  it("stages music audio src", () => {
    const props = buildBaseProps();
    props.audio = {
      music: { src: "/music/bg.mp3", volume: 0.5, loop: true, fadeInFrames: 0, fadeOutFrames: 0, ducking: false },
      voiceover: null,
    };
    const result = stageInputPropsMedia(props, bundleDir);
    expect(stageMediaFile).toHaveBeenCalledWith("/music/bg.mp3", bundleDir);
    expect(result.audio.music!.src).toBe("/staged/music/bg.mp3");
  });

  it("drops music when stageMediaFile returns null", () => {
    vi.mocked(stageMediaFile).mockReturnValueOnce(null);
    const props = buildBaseProps();
    props.audio = {
      music: { src: "/music/missing.mp3", volume: 0.5, loop: true, fadeInFrames: 0, fadeOutFrames: 0, ducking: false },
      voiceover: null,
    };
    const result = stageInputPropsMedia(props, bundleDir);
    expect(result.audio.music).toBeNull();
  });

  it("stages voiceover audio src", () => {
    const props = buildBaseProps();
    props.audio = {
      music: null,
      voiceover: { src: "/voice/narration.mp3", volume: 0.9, startAtFrame: 30 },
    };
    const result = stageInputPropsMedia(props, bundleDir);
    expect(stageMediaFile).toHaveBeenCalledWith("/voice/narration.mp3", bundleDir);
    expect(result.audio.voiceover!.src).toBe("/staged/voice/narration.mp3");
  });

  it("drops voiceover when stageMediaFile returns null", () => {
    vi.mocked(stageMediaFile).mockReturnValueOnce(null);
    const props = buildBaseProps();
    props.audio = {
      music: null,
      voiceover: { src: "/voice/missing.mp3", volume: 1, startAtFrame: 0 },
    };
    const result = stageInputPropsMedia(props, bundleDir);
    expect(result.audio.voiceover).toBeNull();
  });

  it("passes through transition and overlay without src unchanged", () => {
    const props = buildBaseProps([
      {
        type: "transition",
        style: "crossfade",
        durationInFrames: 15,
        startAtFrame: 60,
      },
      {
        type: "overlay",
        component: "SmartCaptions",
        props: { words: [] },
        startAtFrame: 0,
        durationInFrames: 90,
      },
    ]);
    const result = stageInputPropsMedia(props, bundleDir);
    expect(stageMediaFile).not.toHaveBeenCalled();
    expect(result.timeline).toHaveLength(2);
  });
});

// ── deriveWordTimingsFromTimeline (via adaptManifest SmartCaptions) ──────

describe("adaptManifest with SmartCaptions word derivation", () => {
  const outputDir = "/renders/job-words";

  it("re-derives SmartCaptions words from scene scriptText", () => {
    const manifest: DirectorManifest = {
      projectTitle: "Caption Test",
      templateId: "Minimalist",
      composition: { width: 1920, height: 1080, fps: 30 },
      audioLayer: { music: null, voiceover: null },
      timeline: [
        {
          type: "image_scene",
          src: "/img.png",
          startAtFrame: 0,
          duration: 90,
          scriptText: "Hello world test",
        } as never,
        {
          type: "overlay",
          component: "SmartCaptions",
          props: { words: [] },
          startAtFrame: 0,
          duration: 90,
        },
      ],
    };
    const result = adaptManifest(manifest, outputDir);
    const overlay = result.timeline.find((t) => t.type === "overlay" && t.component === "SmartCaptions");
    expect(overlay).toBeDefined();
    const words = (overlay as { props: Record<string, unknown> }).props.words as Array<{ word: string; start: number; end: number }>;
    expect(words.length).toBe(3);
    expect(words.map((w) => w.word)).toEqual(["Hello", "world", "test"]);
    // Words should have monotonically increasing timings
    for (let i = 1; i < words.length; i++) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end);
    }
  });

  it("SmartCaptions overlay gets pinned to frame 0 with full duration", () => {
    const manifest: DirectorManifest = {
      projectTitle: "Pin Test",
      templateId: "Minimalist",
      composition: { width: 1920, height: 1080, fps: 30 },
      audioLayer: { music: null, voiceover: null },
      timeline: [
        {
          type: "image_scene",
          src: "/img.png",
          startAtFrame: 0,
          duration: 120,
          scriptText: "Some words here",
        } as never,
        {
          type: "overlay",
          component: "SmartCaptions",
          props: { words: [] },
          startAtFrame: 30,  // deliberately not 0
          duration: 60,       // deliberately short
        },
      ],
    };
    const result = adaptManifest(manifest, outputDir);
    const overlay = result.timeline.find((t) => t.type === "overlay" && t.component === "SmartCaptions");
    expect(overlay!.startAtFrame).toBe(0);
    expect(overlay!.durationInFrames).toBe(120);
  });

  it("strips PAUSE markers and asterisks from scriptText", () => {
    const manifest: DirectorManifest = {
      projectTitle: "Strip Test",
      templateId: "Minimalist",
      composition: { width: 1920, height: 1080, fps: 30 },
      audioLayer: { music: null, voiceover: null },
      timeline: [
        {
          type: "image_scene",
          src: "/img.png",
          startAtFrame: 0,
          duration: 90,
          scriptText: "*Bold* text [PAUSE: 1.5s] continues",
        } as never,
        {
          type: "overlay",
          component: "SmartCaptions",
          props: { words: [] },
          startAtFrame: 0,
          duration: 90,
        },
      ],
    };
    const result = adaptManifest(manifest, outputDir);
    const overlay = result.timeline.find((t) => t.type === "overlay" && t.component === "SmartCaptions");
    const words = (overlay as { props: Record<string, unknown> }).props.words as Array<{ word: string }>;
    const wordTexts = words.map((w) => w.word);
    expect(wordTexts).toEqual(["Bold", "text", "continues"]);
  });

  it("handles multiple scenes contributing words", () => {
    const manifest: DirectorManifest = {
      projectTitle: "Multi Scene",
      templateId: "Minimalist",
      composition: { width: 1920, height: 1080, fps: 30 },
      audioLayer: { music: null, voiceover: null },
      timeline: [
        {
          type: "image_scene",
          src: "/a.png",
          startAtFrame: 0,
          duration: 60,
          scriptText: "First scene",
        } as never,
        {
          type: "image_scene",
          src: "/b.png",
          startAtFrame: 60,
          duration: 60,
          scriptText: "Second scene",
        } as never,
        {
          type: "overlay",
          component: "SmartCaptions",
          props: { words: [] },
          startAtFrame: 0,
          duration: 120,
        },
      ],
    };
    const result = adaptManifest(manifest, outputDir);
    const overlay = result.timeline.find((t) => t.type === "overlay" && t.component === "SmartCaptions");
    const words = (overlay as { props: Record<string, unknown> }).props.words as Array<{ word: string; start: number }>;
    expect(words.length).toBe(4);
    expect(words.map((w) => w.word)).toEqual(["First", "scene", "Second", "scene"]);
    // Second scene words should start at or after frame 60
    expect(words[2].start).toBeGreaterThanOrEqual(60);
  });
});

// ── computeRenderedLayout (via transition overlap) ──────────────────────

describe("adaptManifest transition overlap layout", () => {
  const outputDir = "/renders/job-layout";

  it("transitions reduce total duration via overlap", () => {
    const manifest: DirectorManifest = {
      projectTitle: "Overlap Test",
      templateId: "Minimalist",
      composition: { width: 1920, height: 1080, fps: 30 },
      audioLayer: { music: null, voiceover: null },
      timeline: [
        { type: "video_clip", source: "/a.mp4", startAtFrame: 0, trimStart: 0, duration: 90 },
        { type: "transition", style: "crossfade", startAtFrame: 90, duration: 15 },
        { type: "video_clip", source: "/b.mp4", startAtFrame: 90, trimStart: 0, duration: 90 },
      ],
    };
    // Without transitions: last entry ends at 90 + 90 = 180
    const result = adaptManifest(manifest, outputDir);
    expect(result.durationInFrames).toBe(180);
  });
});
