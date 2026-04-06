/**
 * NLE Export — Unit Tests
 * Issue #826: Premiere Pro / DaVinci Resolve XML Timeline Export.
 */

import { describe, it, expect } from "vitest";
import {
  manifestToTimeline,
  exportFCPXML,
  exportEDL,
  type DirectorManifestForExport,
} from "./nle-export.js";

describe("manifestToTimeline", () => {
  const manifest: DirectorManifestForExport = {
    composition: { fps: 30, width: 1920, height: 1080 },
    timeline: [
      {
        id: "scene-1",
        scriptText: "Hello world, welcome to the show",
        durationInFrames: 150,
        media: { src: "/videos/intro.mp4" },
      },
      {
        id: "scene-2",
        scriptText: "Let me show you something amazing",
        durationInFrames: 300,
        media: { src: "/videos/main.mp4" },
        audioSrc: "/audio/narration.mp3",
        transition: { type: "dissolve", durationInFrames: 15 },
      },
    ],
    title: "Test Video",
  };

  it("converts manifest to timeline", () => {
    const timeline = manifestToTimeline(manifest);
    expect(timeline.name).toBe("Test Video");
    expect(timeline.fps).toBe(30);
    expect(timeline.width).toBe(1920);
    expect(timeline.height).toBe(1080);
  });

  it("creates video clips from scenes", () => {
    const timeline = manifestToTimeline(manifest);
    const videoClips = timeline.clips.filter((c) => c.type === "video");
    expect(videoClips).toHaveLength(2);
    expect(videoClips[0].sourcePath).toBe("/videos/intro.mp4");
    expect(videoClips[0].durationFrames).toBe(150);
    expect(videoClips[1].startFrame).toBe(150);
  });

  it("creates audio clips for scenes with separate audio", () => {
    const timeline = manifestToTimeline(manifest);
    const audioClips = timeline.clips.filter((c) => c.type === "audio");
    expect(audioClips).toHaveLength(1);
    expect(audioClips[0].sourcePath).toBe("/audio/narration.mp3");
  });

  it("creates caption clips from scriptText", () => {
    const timeline = manifestToTimeline(manifest);
    const captionClips = timeline.clips.filter((c) => c.type === "caption");
    expect(captionClips).toHaveLength(2);
  });

  it("creates transitions", () => {
    const timeline = manifestToTimeline(manifest);
    expect(timeline.transitions).toHaveLength(1);
    expect(timeline.transitions[0].type).toBe("dissolve");
    expect(timeline.transitions[0].durationFrames).toBe(15);
  });

  it("handles empty manifest", () => {
    const timeline = manifestToTimeline({});
    expect(timeline.clips).toHaveLength(0);
    expect(timeline.transitions).toHaveLength(0);
    expect(timeline.fps).toBe(30);
  });

  it("uses custom title", () => {
    const timeline = manifestToTimeline(manifest, "Custom Title");
    expect(timeline.name).toBe("Custom Title");
  });

  it("defaults duration when not specified", () => {
    const timeline = manifestToTimeline({
      timeline: [{ id: "s1", media: { src: "test.mp4" } }],
    });
    expect(timeline.clips[0].durationFrames).toBe(150); // 30fps * 5s default
  });
});

describe("exportFCPXML", () => {
  it("produces valid XML", () => {
    const timeline = manifestToTimeline({
      composition: { fps: 30, width: 1920, height: 1080 },
      timeline: [
        {
          id: "s1",
          scriptText: "Hello",
          durationInFrames: 90,
          media: { src: "test.mp4" },
        },
      ],
      title: "Test",
    });

    const xml = exportFCPXML(timeline);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<xmeml");
    expect(xml).toContain("<project>");
    expect(xml).toContain("<sequence>");
    expect(xml).toContain("<name>Test</name>");
    expect(xml).toContain("<timebase>30</timebase>");
    expect(xml).toContain("<width>1920</width>");
    expect(xml).toContain("<height>1080</height>");
    expect(xml).toContain("test.mp4");
    expect(xml).toContain("<start>0</start>");
    expect(xml).toContain("<end>90</end>");
  });

  it("escapes XML special characters", () => {
    const timeline = manifestToTimeline({
      timeline: [
        {
          id: "s1",
          scriptText: 'Test & <special> "chars"',
          durationInFrames: 30,
          media: { src: "test.mp4" },
        },
      ],
    });

    const xml = exportFCPXML(timeline);
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;special&gt;");
    expect(xml).toContain("&quot;chars&quot;");
  });

  it("includes audio track when audio clips present", () => {
    const timeline = manifestToTimeline({
      timeline: [
        {
          id: "s1",
          durationInFrames: 90,
          media: { src: "test.mp4" },
          audioSrc: "/audio.mp3",
        },
      ],
    });

    const xml = exportFCPXML(timeline);
    expect(xml).toContain("<audio>");
    expect(xml).toContain("audio.mp3");
  });
});

describe("exportEDL", () => {
  it("produces valid EDL", () => {
    const timeline = manifestToTimeline({
      composition: { fps: 30, width: 1920, height: 1080 },
      timeline: [
        {
          id: "s1",
          scriptText: "Scene 1",
          durationInFrames: 90,
          media: { src: "intro.mp4" },
        },
        {
          id: "s2",
          scriptText: "Scene 2",
          durationInFrames: 150,
          media: { src: "main.mp4" },
        },
      ],
      title: "My Video",
    });

    const edl = exportEDL(timeline);
    expect(edl).toContain("TITLE: My Video");
    expect(edl).toContain("FCM: NON-DROP FRAME");
    expect(edl).toContain("001  AX       V");
    expect(edl).toContain("002  AX       V");
    expect(edl).toContain("* FROM CLIP NAME: intro.mp4");
    expect(edl).toContain("* FROM CLIP NAME: main.mp4");
  });

  it("marks dissolve transitions", () => {
    const timeline = manifestToTimeline({
      composition: { fps: 30 },
      timeline: [
        { id: "s1", durationInFrames: 90, media: { src: "a.mp4" } },
        {
          id: "s2",
          durationInFrames: 150,
          media: { src: "b.mp4" },
          transition: { type: "dissolve", durationInFrames: 15 },
        },
      ],
    });

    const edl = exportEDL(timeline);
    expect(edl).toContain("D");
    expect(edl).toContain("015");
  });

  it("handles empty timeline", () => {
    const timeline = manifestToTimeline({});
    const edl = exportEDL(timeline);
    expect(edl).toContain("TITLE:");
    expect(edl).toContain("FCM: NON-DROP FRAME");
  });
});
