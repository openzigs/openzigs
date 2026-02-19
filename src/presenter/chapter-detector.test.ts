import { describe, expect, it } from "vitest";
import { detectChapters, computeQuizTimestamps } from "./chapter-detector.js";
import type { DirectorManifest } from "../video/manifest/manifest-types.js";

function makeBaseManifest(): Omit<DirectorManifest, "timeline"> {
  return {
    projectTitle: "Demo",
    templateId: "Corporate",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: {},
    metadata: {
      generatedAt: new Date().toISOString(),
      llmModel: "test",
      llmTokensUsed: 0,
      productionMode: "presentation",
    },
  };
}

describe("chapter-detector", () => {
  it("detects chapters from title_card entries", () => {
    const manifest = {
      ...makeBaseManifest(),
      timeline: [
        { type: "title_card", title: "Intro", startAtFrame: 0, duration: 90, animation: "fade" },
        { type: "image_scene", src: "/tmp/1.png", voiceover: "/tmp/1.wav", startAtFrame: 90, duration: 300 },
        { type: "title_card", title: "Deep Dive", startAtFrame: 390, duration: 90, animation: "fade" },
        { type: "image_scene", src: "/tmp/2.png", voiceover: "/tmp/2.wav", startAtFrame: 480, duration: 300 },
      ],
    } satisfies DirectorManifest;

    const chapters = detectChapters(manifest);
    expect(chapters).toEqual([
      { title: "Intro", startSeconds: 0, endSeconds: 13 },
      { title: "Deep Dive", startSeconds: 13, endSeconds: 26 },
    ]);
  });

  it("falls back to a single chapter when no title cards exist", () => {
    const manifest = {
      ...makeBaseManifest(),
      projectTitle: "No Cards",
      timeline: [
        { type: "image_scene", src: "/tmp/1.png", voiceover: "/tmp/1.wav", startAtFrame: 0, duration: 300 },
      ],
    } satisfies DirectorManifest;

    const chapters = detectChapters(manifest);
    expect(chapters).toEqual([
      { title: "No Cards", startSeconds: 0, endSeconds: 10 },
    ]);
  });

  it("computes quiz timestamps only for chapters >= 15s", () => {
    const quiz = computeQuizTimestamps([
      { title: "Short", startSeconds: 0, endSeconds: 10 },
      { title: "Long", startSeconds: 10, endSeconds: 40 },
    ]);

    expect(quiz.timestamps).toEqual([38]);
    expect(quiz.difficulty).toBe("medium");
  });
});
