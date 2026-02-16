/**
 * Director Mode — Input Props Schema Tests
 * Issue #244
 */

import { describe, it, expect } from "vitest";
import {
  CompositionInputPropsSchema,
  VideoClipPropsSchema,
  TitleCardPropsSchema,
  OverlayPropsSchema,
  TransitionPropsSchema,
  AudioPropsSchema,
  BrandingPropsSchema,
  TimelineItemSchema,
  ImageScenePropsSchema,
} from "./input-props.js";

describe("VideoClipPropsSchema", () => {
  it("validates a complete video clip", () => {
    const result = VideoClipPropsSchema.safeParse({
      src: "/path/to/video.mp4",
      startAtFrame: 0,
      trimStartFrame: 10,
      durationInFrames: 90,
      volume: 0.8,
      effects: [{ type: "slowZoom" }],
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for volume and effects", () => {
    const result = VideoClipPropsSchema.parse({
      src: "/test.mp4",
      startAtFrame: 0,
      trimStartFrame: 0,
      durationInFrames: 30,
    });
    expect(result.volume).toBe(1);
    expect(result.effects).toEqual([]);
  });

  it("rejects negative startAtFrame", () => {
    const result = VideoClipPropsSchema.safeParse({
      src: "/test.mp4",
      startAtFrame: -1,
      trimStartFrame: 0,
      durationInFrames: 30,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero durationInFrames", () => {
    const result = VideoClipPropsSchema.safeParse({
      src: "/test.mp4",
      startAtFrame: 0,
      trimStartFrame: 0,
      durationInFrames: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("TitleCardPropsSchema", () => {
  it("validates a title card with defaults", () => {
    const result = TitleCardPropsSchema.parse({
      title: "Hello World",
      startAtFrame: 0,
      durationInFrames: 60,
    });
    expect(result.background).toBe("#1a1a1a");
    expect(result.animation).toBe("fade");
  });

  it("accepts custom animation style", () => {
    const result = TitleCardPropsSchema.parse({
      title: "Test",
      startAtFrame: 0,
      durationInFrames: 60,
      animation: "typewriter",
    });
    expect(result.animation).toBe("typewriter");
  });
});

describe("OverlayPropsSchema", () => {
  it("validates a SmartCaptions overlay", () => {
    const result = OverlayPropsSchema.safeParse({
      component: "SmartCaptions",
      props: { text: "hello" },
      startAtFrame: 0,
      durationInFrames: 90,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid component name", () => {
    const result = OverlayPropsSchema.safeParse({
      component: "InvalidComponent",
      props: {},
      startAtFrame: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("TransitionPropsSchema", () => {
  it("validates all transition styles", () => {
    const styles = ["crossfade", "wipe-left", "wipe-right", "dissolve", "cut"] as const;
    for (const style of styles) {
      const result = TransitionPropsSchema.safeParse({
        style,
        durationInFrames: 15,
        startAtFrame: 0,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("AudioPropsSchema", () => {
  it("defaults to null music and voiceover", () => {
    const result = AudioPropsSchema.parse({});
    expect(result.music).toBeNull();
    expect(result.voiceover).toBeNull();
  });

  it("validates music config", () => {
    const result = AudioPropsSchema.parse({
      music: {
        src: "/music.mp3",
        volume: 0.5,
        loop: true,
        fadeInFrames: 30,
        fadeOutFrames: 15,
      },
    });
    expect(result.music!.src).toBe("/music.mp3");
    expect(result.music!.volume).toBe(0.5);
  });
});

describe("BrandingPropsSchema", () => {
  it("applies sensible defaults", () => {
    const result = BrandingPropsSchema.parse({});
    expect(result.accentColor).toBe("#3b82f6");
    expect(result.fontFamily).toContain("Inter");
    expect(result.watermarkOpacity).toBe(0.3);
    expect(result.watermarkPosition).toBe("bottom-right");
  });
});

describe("TimelineItemSchema (discriminated union)", () => {
  it("parses video_clip items", () => {
    const result = TimelineItemSchema.safeParse({
      type: "video_clip",
      src: "/test.mp4",
      startAtFrame: 0,
      trimStartFrame: 0,
      durationInFrames: 90,
    });
    expect(result.success).toBe(true);
  });

  it("parses title_card items", () => {
    const result = TimelineItemSchema.safeParse({
      type: "title_card",
      title: "Test",
      startAtFrame: 0,
      durationInFrames: 60,
    });
    expect(result.success).toBe(true);
  });

  it("parses transition items", () => {
    const result = TimelineItemSchema.safeParse({
      type: "transition",
      style: "crossfade",
      durationInFrames: 15,
      startAtFrame: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown type", () => {
    const result = TimelineItemSchema.safeParse({
      type: "unknown",
      startAtFrame: 0,
    });
    expect(result.success).toBe(false);
  });

  it("parses image_scene items", () => {
    const result = TimelineItemSchema.safeParse({
      type: "image_scene",
      src: "/images/scene-001.png",
      startAtFrame: 0,
      durationInFrames: 450,
      voiceover: "/audio/scene-001.mp3",
      voiceoverVolume: 0.9,
      kenBurns: {
        scaleFrom: 1.0,
        scaleTo: 1.2,
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses image_scene with defaults", () => {
    const result = TimelineItemSchema.safeParse({
      type: "image_scene",
      src: "/images/scene.png",
      startAtFrame: 0,
      durationInFrames: 300,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "image_scene") {
      expect(result.data.voiceoverVolume).toBe(1);
      expect(result.data.kenBurns.scaleFrom).toBe(1.0);
      expect(result.data.kenBurns.scaleTo).toBe(1.15);
    }
  });
});

describe("ImageScenePropsSchema", () => {
  it("validates a full image scene", () => {
    const result = ImageScenePropsSchema.safeParse({
      src: "/images/scene.png",
      startAtFrame: 0,
      durationInFrames: 450,
      voiceover: "/audio/narration.mp3",
      voiceoverVolume: 0.8,
      kenBurns: {
        scaleFrom: 1.0,
        scaleTo: 1.2,
        translateXFrom: 0,
        translateXTo: -15,
        translateYFrom: 0,
        translateYTo: -5,
      },
    });
    expect(result.success).toBe(true);
  });

  it("applies Ken Burns defaults", () => {
    const result = ImageScenePropsSchema.parse({
      src: "/images/scene.png",
      startAtFrame: 0,
      durationInFrames: 300,
    });
    expect(result.kenBurns.scaleFrom).toBe(1.0);
    expect(result.kenBurns.scaleTo).toBe(1.15);
    expect(result.kenBurns.translateXFrom).toBe(0);
    expect(result.kenBurns.translateXTo).toBe(-10);
  });

  it("rejects zero duration", () => {
    const result = ImageScenePropsSchema.safeParse({
      src: "/images/scene.png",
      startAtFrame: 0,
      durationInFrames: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("CompositionInputPropsSchema", () => {
  it("validates a complete composition", () => {
    const result = CompositionInputPropsSchema.safeParse({
      templateId: "Minimalist",
      projectTitle: "Test Video",
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 300,
      timeline: [
        {
          type: "video_clip",
          src: "/test.mp4",
          startAtFrame: 0,
          trimStartFrame: 0,
          durationInFrames: 300,
          volume: 1,
          effects: [],
        },
      ],
      audio: { music: null, voiceover: null },
      branding: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid templateId", () => {
    const result = CompositionInputPropsSchema.safeParse({
      templateId: "NonExistent",
      projectTitle: "Test",
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 300,
      timeline: [],
      audio: {},
      branding: {},
    });
    expect(result.success).toBe(false);
  });
});
