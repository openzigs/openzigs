/**
 * Director Mode — Storyboard Engine Tests
 * Issue #255: Tests for the LLM-powered storyboard generation pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StoryboardEngine } from "./storyboard-engine.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";

/** Build a mock CopilotWrapper that yields a canned JSON response. */
function buildMockCopilot(response: string): CopilotWrapper {
  return {
    chat: vi.fn(function* () {
      yield response;
    }),
  } as unknown as CopilotWrapper;
}

/** Valid storyboard JSON output matching the expected LLM schema. */
const VALID_RESPONSE = JSON.stringify({
  title: "Introduction to TypeScript",
  styleAnchor: "Flat vector art, blue palette, minimalist, clean lines",
  analysis: {
    tone: "technical",
    audience: "developers",
    coreThemes: ["type safety", "tooling", "developer experience"],
  },
  scenes: [
    {
      voiceover: "TypeScript brings type safety to JavaScript development.",
      imageDescription: "A developer writing code on a modern laptop with blue syntax highlighting",
      durationEstimate: 20,
    },
    {
      voiceover: "With rich IDE integration, TypeScript catches errors before runtime.",
      imageDescription: "An IDE showing red squiggly underlines and error tooltips with code suggestions",
      durationEstimate: 18,
    },
    {
      voiceover: "Millions of developers now rely on TypeScript for production applications.",
      imageDescription: "A world map with glowing data connections between cities, indicating global adoption",
      durationEstimate: 22,
    },
  ],
});

describe("StoryboardEngine", () => {
  let engine: StoryboardEngine;
  let mockCopilot: CopilotWrapper;

  beforeEach(() => {
    mockCopilot = buildMockCopilot(VALID_RESPONSE);
    engine = new StoryboardEngine(mockCopilot);
  });

  it("generates a storyboard from text input", async () => {
    const result = await engine.generate("TypeScript is a typed superset of JavaScript.");
    expect(result.title).toBe("Introduction to TypeScript");
    expect(result.styleAnchor).toBe("Flat vector art, blue palette, minimalist, clean lines");
    expect(result.scenes).toHaveLength(3);
    expect(result.analysis.tone).toBe("technical");
    expect(result.analysis.audience).toBe("developers");
    expect(result.analysis.coreThemes).toContain("type safety");
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it("prepends Style Anchor to each scene's imagePrompt", async () => {
    const result = await engine.generate("Some test document content.");

    for (const scene of result.scenes) {
      expect(scene.imagePrompt.startsWith(result.styleAnchor)).toBe(true);
    }
  });

  it("preserves rawImageDescription without style anchor", async () => {
    const result = await engine.generate("JavaScript testing frameworks.");

    expect(result.scenes[0].rawImageDescription).toBe(
      "A developer writing code on a modern laptop with blue syntax highlighting",
    );
    expect(result.scenes[0].rawImageDescription).not.toContain(result.styleAnchor);
  });

  it("assigns sequential scene indices starting at 0", async () => {
    const result = await engine.generate("Test content.");

    result.scenes.forEach((scene, i) => {
      expect(scene.index).toBe(i);
    });
  });

  it("clamps scene duration to 5–60 seconds", async () => {
    const edgeCaseResponse = JSON.stringify({
      title: "Edge Case",
      styleAnchor: "Watercolor style",
      analysis: { tone: "neutral", audience: "general", coreThemes: [] },
      scenes: [
        { voiceover: "Short", imageDescription: "img", durationEstimate: 1 },
        { voiceover: "Long", imageDescription: "img", durationEstimate: 120 },
      ],
    });

    const copilot = buildMockCopilot(edgeCaseResponse);
    const eng = new StoryboardEngine(copilot);
    const result = await eng.generate("Test.");

    expect(result.scenes[0].durationEstimate).toBe(5);
    expect(result.scenes[1].durationEstimate).toBe(60);
  });

  it("throws on empty input text", async () => {
    await expect(engine.generate("")).rejects.toThrow("Input text cannot be empty");
  });

  it("throws on whitespace-only input text", async () => {
    await expect(engine.generate("   \n\t  ")).rejects.toThrow("Input text cannot be empty");
  });

  it("throws when LLM returns invalid JSON", async () => {
    const copilot = buildMockCopilot("This is not JSON at all");
    const eng = new StoryboardEngine(copilot);
    await expect(eng.generate("Some text.")).rejects.toThrow("No JSON object found");
  });

  it("throws when LLM response is missing title", async () => {
    const copilot = buildMockCopilot(JSON.stringify({
      styleAnchor: "style",
      scenes: [{ voiceover: "test", imageDescription: "img", durationEstimate: 20 }],
    }));
    const eng = new StoryboardEngine(copilot);
    await expect(eng.generate("Some text.")).rejects.toThrow("missing 'title'");
  });

  it("throws when LLM response is missing styleAnchor", async () => {
    const copilot = buildMockCopilot(JSON.stringify({
      title: "Test",
      scenes: [{ voiceover: "test", imageDescription: "img", durationEstimate: 20 }],
    }));
    const eng = new StoryboardEngine(copilot);
    await expect(eng.generate("Some text.")).rejects.toThrow("missing 'styleAnchor'");
  });

  it("throws when LLM response has empty scenes array", async () => {
    const copilot = buildMockCopilot(JSON.stringify({
      title: "Test",
      styleAnchor: "style",
      scenes: [],
    }));
    const eng = new StoryboardEngine(copilot);
    await expect(eng.generate("Some text.")).rejects.toThrow("empty 'scenes'");
  });

  it("handles markdown-wrapped JSON response", async () => {
    const wrapped = "```json\n" + VALID_RESPONSE + "\n```";
    const copilot = buildMockCopilot(wrapped);
    const eng = new StoryboardEngine(copilot);

    const result = await eng.generate("Some text.");
    expect(result.title).toBe("Introduction to TypeScript");
    expect(result.scenes).toHaveLength(3);
  });

  it("extracts JSON from mixed response text", async () => {
    const mixed = "Here is the storyboard:\n" + VALID_RESPONSE + "\nDone.";
    const copilot = buildMockCopilot(mixed);
    const eng = new StoryboardEngine(copilot);

    const result = await eng.generate("Some text.");
    expect(result.title).toBe("Introduction to TypeScript");
  });

  it("passes style and audience hints to the LLM prompt", async () => {
    await engine.generate("Test content.", {
      styleHint: "corporate",
      audienceHint: "executives",
    });

    // Verify chat was called and the prompt includes the hints
    expect(mockCopilot.chat).toHaveBeenCalledTimes(1);
    const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).toContain("corporate");
    expect(prompt).toContain("executives");
  });

  it("respects custom scene duration bounds", async () => {
    await engine.generate("Test.", {
      minSceneDuration: 10,
      maxSceneDuration: 40,
    });

    const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).toContain("10-40 seconds");
  });

  it("defaults missing analysis fields gracefully", async () => {
    const response = JSON.stringify({
      title: "Minimal",
      styleAnchor: "Minimal style",
      scenes: [{ voiceover: "Test.", imageDescription: "img", durationEstimate: 15 }],
      // analysis deliberately omitted
    });
    const copilot = buildMockCopilot(response);
    const eng = new StoryboardEngine(copilot);

    const result = await eng.generate("Text.");
    expect(result.analysis.tone).toBe("neutral");
    expect(result.analysis.audience).toBe("general");
    expect(result.analysis.coreThemes).toEqual([]);
  });

  it("parses shouldAnimate and motionPrompt from LLM response", async () => {
    const response = JSON.stringify({
      title: "Animated Test",
      styleAnchor: "Cinematic style",
      analysis: { tone: "dramatic", audience: "general", coreThemes: ["motion"] },
      scenes: [
        {
          voiceover: "The city comes alive at dawn.",
          imageDescription: "aerial city at dawn",
          durationEstimate: 20,
          shouldAnimate: true,
          motionPrompt: "slow cinematic zoom in with rising camera",
        },
        {
          voiceover: "Still scene of a park.",
          imageDescription: "peaceful park bench",
          durationEstimate: 18,
          shouldAnimate: false,
          motionPrompt: null,
        },
      ],
    });

    const copilot = buildMockCopilot(response);
    const eng = new StoryboardEngine(copilot);
    const result = await eng.generate("Test text.");

    expect(result.scenes[0].shouldAnimate).toBe(true);
    expect(result.scenes[0].motionPrompt).toBe("slow cinematic zoom in with rising camera");
    expect(result.scenes[1].shouldAnimate).toBe(false);
    expect(result.scenes[1].motionPrompt).toBeUndefined();
  });

  describe("imageClipDurationSeconds", () => {
    it("injects duration constraint into system prompt when set", async () => {
      await engine.generate("Test content.", { imageClipDurationSeconds: 5 });

      const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = callArgs[0] as string;
      expect(prompt).toContain("IMAGE CLIP DURATION CONSTRAINT");
      expect(prompt).toContain("5 seconds");
    });

    it("does not inject duration constraint when unset", async () => {
      await engine.generate("Test content.");

      const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = callArgs[0] as string;
      expect(prompt).not.toContain("IMAGE CLIP DURATION CONSTRAINT");
    });
  });
});

describe("StoryboardEngine.generateHeroReel", () => {
  let engine: StoryboardEngine;
  let mockCopilot: CopilotWrapper;

  const HERO_REEL_RESPONSE = JSON.stringify({
    title: "Rise of Innovation",
    styleAnchor: "Cinematic 35mm film grain, warm golden hour lighting",
    analysis: {
      tone: "energetic",
      audience: "general",
      coreThemes: ["innovation", "progress"],
    },
    scenes: [
      {
        voiceover: "The future starts here.",
        imageDescription: "Sunrise over a modern city skyline",
        durationEstimate: 2,
        shouldAnimate: false,
        motionPrompt: null,
      },
      {
        voiceover: "Built by dreamers.",
        imageDescription: "Close-up of hands assembling a circuit board",
        durationEstimate: 2,
        shouldAnimate: true,
        motionPrompt: "slow dolly forward with warm lighting",
      },
      {
        voiceover: "Powered by ambition.",
        imageDescription: "Rocket launch from ground perspective",
        durationEstimate: 2,
        shouldAnimate: false,
        motionPrompt: null,
      },
    ],
  });

  beforeEach(() => {
    mockCopilot = buildMockCopilot(HERO_REEL_RESPONSE);
    engine = new StoryboardEngine(mockCopilot);
  });

  it("generates a hero reel storyboard from overview text", async () => {
    const result = await engine.generateHeroReel("Create a punchy brand montage");
    expect(result.title).toBe("Rise of Innovation");
    expect(result.styleAnchor).toContain("Cinematic");
    expect(result.scenes).toHaveLength(3);
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it("includes hero reel specific instructions in the prompt", async () => {
    await engine.generateHeroReel("Brand montage");

    const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).toContain("hero reel");
    expect(prompt).toContain("5–8 fast-paced scenes");
    expect(prompt).toContain("≤12 words");
    expect(prompt).toContain("HERO REEL BRIEF");
  });

  it("uses custom clip duration in the prompt", async () => {
    await engine.generateHeroReel("Montage", { imageClipDurationSeconds: 4 });

    const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).toContain("4 seconds");
  });

  it("defaults clip duration to 2 seconds", async () => {
    await engine.generateHeroReel("Fast montage");

    const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).toContain("2 seconds");
  });

  it("throws on empty overview", async () => {
    await expect(engine.generateHeroReel("")).rejects.toThrow("Hero reel overview cannot be empty");
  });

  it("throws on whitespace-only overview", async () => {
    await expect(engine.generateHeroReel("   \n  ")).rejects.toThrow("Hero reel overview cannot be empty");
  });

  it("passes style hint into the hero reel prompt", async () => {
    await engine.generateHeroReel("Brand montage", { styleHint: "retro synthwave" });

    const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).toContain("retro synthwave");
  });

  it("passes custom model to copilot chat", async () => {
    await engine.generateHeroReel("Brand montage", { model: "gpt-4.1" });

    const callArgs = (mockCopilot.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = callArgs[1] as { model?: string };
    expect(options.model).toBe("gpt-4.1");
  });
});
