import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createShortsTools, type ShortsToolsOptions } from "./shorts-tools.js";

describe("shorts-tools", () => {
  const mockCopilot = {} as ShortsToolsOptions["copilot"];
  const mockVoiceService = {} as NonNullable<ShortsToolsOptions["voiceService"]>;

  let tools: ReturnType<typeof createShortsTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("creates one tool: create-short", () => {
    tools = createShortsTools({ copilot: mockCopilot, voiceService: mockVoiceService });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("create-short");
  });

  describe("create-short tool metadata", () => {
    it("has correct category and risk level", () => {
      tools = createShortsTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];
      expect(tool.category).toBe("productivity");
      expect(tool.riskLevel).toBe("high");
    });

    it("requires source in input schema", () => {
      tools = createShortsTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];
      expect(tool.inputSchema.required).toContain("source");
    });
  });

  describe("create-short handler", () => {
    it("returns error when voiceService is not available", async () => {
      tools = createShortsTools({ copilot: mockCopilot, voiceService: undefined });
      const tool = tools[0];
      const result = await tool.handler({ source: "/path/to/video.mp4" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("VoiceService is not available");
    });

    it("returns error when source file does not exist", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn().mockReturnValue(false),
      }));

      // Re-create tools after mock
      const { createShortsTools: freshCreateShortsTools } = await import("./shorts-tools.js");
      tools = freshCreateShortsTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];

      const result = await tool.handler({ source: "/nonexistent/video.mp4" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Source video not found");
    });

    it("calls createShort pipeline and returns result", async () => {
      const mockResult = {
        manifest: { title: "Short Video" },
        viralClip: { start: 10, end: 55 },
        scriptText: "Amazing content!",
        processingTimeMs: 1500,
      };

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));
      vi.doMock("../../video/shorts/shorts-pipeline.js", () => ({
        createShort: vi.fn().mockResolvedValue(mockResult),
      }));

      const { createShortsTools: freshCreateShortsTools } = await import("./shorts-tools.js");
      tools = freshCreateShortsTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];

      const result = await tool.handler({
        source: "/path/to/video.mp4",
        style: "highlight",
        target_duration: 45,
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.manifest).toEqual({ title: "Short Video" });
      expect(parsed.viralClip).toEqual({ start: 10, end: 55 });
      expect(parsed.scriptText).toBe("Amazing content!");
      expect(parsed.processingTimeMs).toBe(1500);
    });

    it("returns error when pipeline throws", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));
      vi.doMock("../../video/shorts/shorts-pipeline.js", () => ({
        createShort: vi.fn().mockRejectedValue(new Error("Pipeline failed: invalid codec")),
      }));

      const { createShortsTools: freshCreateShortsTools } = await import("./shorts-tools.js");
      tools = freshCreateShortsTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];

      const result = await tool.handler({ source: "/path/to/video.mp4" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Pipeline failed: invalid codec");
    });

    it("uses default style and duration when not provided", async () => {
      const mockCreateShort = vi.fn().mockResolvedValue({
        manifest: {},
        viralClip: {},
        scriptText: "",
        processingTimeMs: 0,
      });

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));
      vi.doMock("../../video/shorts/shorts-pipeline.js", () => ({
        createShort: mockCreateShort,
      }));

      const { createShortsTools: freshCreateShortsTools } = await import("./shorts-tools.js");
      tools = freshCreateShortsTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];

      await tool.handler({ source: "/path/to/video.mp4" });

      expect(mockCreateShort).toHaveBeenCalledWith(
        expect.objectContaining({
          style: "highlight",
          targetDuration: 45,
        }),
        mockCopilot,
        mockVoiceService,
      );
    });
  });

  describe("schema validation", () => {
    it("accepts valid input with all fields", () => {
      tools = createShortsTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        source: "/path/to/video.mp4",
        style: "react",
        target_duration: 30,
        voice_profile: "narrator",
      });
      expect(result.success).toBe(true);
    });

    it("rejects target_duration below minimum", () => {
      tools = createShortsTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        source: "/path/to/video.mp4",
        target_duration: 5,
      });
      expect(result.success).toBe(false);
    });

    it("rejects target_duration above maximum", () => {
      tools = createShortsTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        source: "/path/to/video.mp4",
        target_duration: 120,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid style enum", () => {
      tools = createShortsTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        source: "/path/to/video.mp4",
        style: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("requires source field", () => {
      tools = createShortsTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
