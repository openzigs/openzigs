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
});
