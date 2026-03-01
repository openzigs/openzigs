import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectThumbnailFrame, extractKeyframesFromManifest } from "./frame-selector.js";
import type { KeyframeInfo } from "./frame-selector.js";
import type { DirectorManifest } from "../manifest/manifest-types.js";
import * as fs from "node:fs";

vi.mock("node:fs");

function makeManifest(overrides: Partial<DirectorManifest> = {}): DirectorManifest {
  return {
    projectTitle: "Test Video",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30, durationInFrames: 900 },
    audioLayer: {} as DirectorManifest["audioLayer"],
    timeline: [],
    ...overrides,
  };
}

function makeCopilot(response: string) {
  return {
    chat: vi.fn().mockReturnValue(
      (async function* () {
        yield response;
      })(),
    ),
  } as unknown as Parameters<typeof selectThumbnailFrame>[2];
}

describe("selectThumbnailFrame", () => {
  it("throws when no keyframes provided", async () => {
    const copilot = makeCopilot("");
    await expect(selectThumbnailFrame([], makeManifest(), copilot)).rejects.toThrow(
      "No keyframes provided",
    );
  });

  it("returns the only keyframe without calling the LLM", async () => {
    const copilot = makeCopilot("");
    const keyframes: KeyframeInfo[] = [{ path: "/img/a.png", timestampSec: 1.5, sceneIndex: 0 }];
    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);

    expect(copilot.chat).not.toHaveBeenCalled();
    expect(result.framePath).toBe("/img/a.png");
    expect(result.timestamp).toBe(1.5);
    expect(result.suggestedText).toEqual(["TEST VIDEO"]);
    expect(result.textPlacement).toBe("bottom");
    expect(result.textColor).toBe("#ffffff");
  });

  it("parses a valid LLM JSON response and selects the correct frame", async () => {
    const llmResponse = JSON.stringify({
      selectedIndex: 1,
      rationale: "Face close-up with vivid colors",
      suggestedText: ["YOU WON'T BELIEVE THIS", "SHOCKING"],
      textPlacement: "top",
      textColor: "#ff0000",
    });
    const copilot = makeCopilot(llmResponse);
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 3.5, sceneIndex: 1 },
      { path: "/img/c.png", timestampSec: 7.0, sceneIndex: 2 },
    ];

    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);

    expect(result.framePath).toBe("/img/b.png");
    expect(result.timestamp).toBe(3.5);
    expect(result.rationale).toBe("Face close-up with vivid colors");
    expect(result.suggestedText).toEqual(["YOU WON'T BELIEVE THIS", "SHOCKING"]);
    expect(result.textPlacement).toBe("top");
    expect(result.textColor).toBe("#ff0000");
  });

  it("handles markdown-wrapped JSON response", async () => {
    const llmResponse = "```json\n" + JSON.stringify({ selectedIndex: 0 }) + "\n```";
    const copilot = makeCopilot(llmResponse);
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 2, sceneIndex: 1 },
    ];

    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);
    expect(result.framePath).toBe("/img/a.png");
  });

  it("falls back to first frame on unparseable LLM response", async () => {
    const copilot = makeCopilot("This is not JSON at all");
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 2, sceneIndex: 1 },
    ];

    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);

    expect(result.framePath).toBe("/img/a.png");
    expect(result.rationale).toContain("defaulting to first frame");
  });

  it("clamps selectedIndex to valid range", async () => {
    const llmResponse = JSON.stringify({ selectedIndex: 999 });
    const copilot = makeCopilot(llmResponse);
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 2, sceneIndex: 1 },
    ];

    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);
    expect(result.framePath).toBe("/img/b.png"); // clamped to last index
  });

  it("clamps negative selectedIndex to 0", async () => {
    const llmResponse = JSON.stringify({ selectedIndex: -5 });
    const copilot = makeCopilot(llmResponse);
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 2, sceneIndex: 1 },
    ];

    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);
    expect(result.framePath).toBe("/img/a.png");
  });

  it("falls back to defaults for invalid textPlacement and textColor", async () => {
    const llmResponse = JSON.stringify({
      selectedIndex: 0,
      textPlacement: "left",
      textColor: "red",
    });
    const copilot = makeCopilot(llmResponse);
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 2, sceneIndex: 1 },
    ];

    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);
    expect(result.textPlacement).toBe("bottom");
    expect(result.textColor).toBe("#ffffff");
  });

  it("limits suggestedText to 3 items and filters non-strings", async () => {
    const llmResponse = JSON.stringify({
      selectedIndex: 0,
      suggestedText: ["A", "B", "C", "D", 42, null],
    });
    const copilot = makeCopilot(llmResponse);
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 2, sceneIndex: 1 },
    ];

    const result = await selectThumbnailFrame(keyframes, makeManifest(), copilot);
    expect(result.suggestedText).toEqual(["A", "B", "C"]);
  });

  it("includes scene descriptions in prompt", async () => {
    const copilot = makeCopilot(JSON.stringify({ selectedIndex: 0 }));
    const manifest = makeManifest({
      timeline: [
        { type: "image_scene", src: "/img/a.png", startAtFrame: 0, durationInFrames: 150, scriptText: "Opening shot of a forest" } as any,
        { type: "title_card", title: "Hello World", startAtFrame: 150, durationInFrames: 90 } as any,
      ],
    });
    const keyframes: KeyframeInfo[] = [
      { path: "/img/a.png", timestampSec: 0, sceneIndex: 0 },
      { path: "/img/b.png", timestampSec: 5, sceneIndex: 1 },
    ];

    await selectThumbnailFrame(keyframes, manifest, copilot);

    const prompt = copilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("Opening shot of a forest");
    expect(prompt).toContain('Title — "Hello World"');
  });
});

describe("extractKeyframesFromManifest", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
  });

  it("extracts keyframes from image_scene entries that exist on disk", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const manifest = makeManifest({
      composition: { width: 1920, height: 1080, fps: 30, durationInFrames: 900 },
      timeline: [
        { type: "image_scene", src: "/abs/img1.png", startAtFrame: 0, durationInFrames: 150 } as any,
        { type: "image_scene", src: "img2.png", startAtFrame: 300, durationInFrames: 150 } as any,
      ],
    });

    const keyframes = extractKeyframesFromManifest(manifest, "/output");
    expect(keyframes).toHaveLength(2);
    expect(keyframes[0].path).toBe("/abs/img1.png");
    expect(keyframes[0].timestampSec).toBe(0);
    expect(keyframes[1].timestampSec).toBe(10); // 300/30
  });

  it("skips image_scene entries that don't exist on disk", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const manifest = makeManifest({
      timeline: [
        { type: "image_scene", src: "/missing.png", startAtFrame: 0, durationInFrames: 90 } as any,
      ],
    });

    const keyframes = extractKeyframesFromManifest(manifest, "/output");
    expect(keyframes).toHaveLength(0);
  });

  it("ignores non-image_scene timeline entries", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const manifest = makeManifest({
      timeline: [
        { type: "title_card", title: "Hello", startAtFrame: 0, durationInFrames: 90 } as any,
        { type: "image_scene", src: "/img.png", startAtFrame: 90, durationInFrames: 90 } as any,
      ],
    });

    const keyframes = extractKeyframesFromManifest(manifest, "/output");
    expect(keyframes).toHaveLength(1);
  });

  it("defaults fps to 30 when composition is missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const manifest = makeManifest({
      composition: undefined as any,
      timeline: [
        { type: "image_scene", src: "/img.png", startAtFrame: 60, durationInFrames: 90 } as any,
      ],
    });

    const keyframes = extractKeyframesFromManifest(manifest, "/output");
    expect(keyframes[0].timestampSec).toBe(2); // 60/30
  });
});
