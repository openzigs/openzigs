/**
 * Director Mode — Producer Prompts Tests
 * Issue #239
 */

import { describe, it, expect } from "vitest";
import { buildHighlightReelPrompt, buildScriptDrivenPrompt, buildUserPrompt } from "./prompts.js";

describe("buildHighlightReelPrompt", () => {
  it("returns a non-empty system prompt", () => {
    const prompt = buildHighlightReelPrompt(["Minimalist", "ContentCreator"]);
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes template IDs in the prompt", () => {
    const prompt = buildHighlightReelPrompt(["Minimalist", "TechDemo"]);
    expect(prompt).toContain("Minimalist");
    expect(prompt).toContain("TechDemo");
  });

  it("mentions highlight reel editing rules", () => {
    const prompt = buildHighlightReelPrompt(["Minimalist"]);
    expect(prompt.toLowerCase()).toContain("highlight");
  });

  it("instructs JSON output", () => {
    const prompt = buildHighlightReelPrompt(["Minimalist"]);
    expect(prompt).toContain("JSON");
  });
});

describe("buildScriptDrivenPrompt", () => {
  it("returns a non-empty system prompt", () => {
    const prompt = buildScriptDrivenPrompt(60, ["Minimalist"]);
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes voiceover duration reference", () => {
    const prompt = buildScriptDrivenPrompt(120, ["Minimalist"]);
    expect(prompt).toContain("120");
  });

  it("instructs JSON output", () => {
    const prompt = buildScriptDrivenPrompt(30, ["Corporate"]);
    expect(prompt).toContain("JSON");
  });
});

describe("buildUserPrompt", () => {
  it("embeds context text in the user prompt", () => {
    const prompt = buildUserPrompt("Clip 1: intro.mp4, duration 10s", {
      mode: "highlight",
    });
    expect(prompt).toContain("intro.mp4");
    expect(prompt).toContain("duration 10s");
  });

  it("includes script text for script mode", () => {
    const prompt = buildUserPrompt("context data", {
      mode: "script",
      scriptText: "Welcome to the demo, today we explore AI.",
    });
    expect(prompt).toContain("Welcome to the demo");
  });

  it("references voiceover path when provided", () => {
    const prompt = buildUserPrompt("context data", {
      mode: "script",
      voiceoverPath: "/tmp/voiceover.mp3",
    });
    expect(prompt).toContain("voiceover.mp3");
  });

  it("references music track when provided", () => {
    const prompt = buildUserPrompt("context data", {
      mode: "highlight",
      musicTrackPath: "/music/bgm.mp3",
    });
    expect(prompt).toContain("bgm.mp3");
  });
});
