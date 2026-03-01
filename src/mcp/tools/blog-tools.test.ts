import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createBlogTools, type BlogToolsOptions } from "./blog-tools.js";

describe("blog-tools", () => {
  const mockCopilot = {} as BlogToolsOptions["copilot"];
  const mockVoiceService = {} as NonNullable<BlogToolsOptions["voiceService"]>;

  let tools: ReturnType<typeof createBlogTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("creates one tool: blog-to-video", () => {
    tools = createBlogTools({ copilot: mockCopilot, voiceService: mockVoiceService });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("blog-to-video");
  });

  describe("blog-to-video tool metadata", () => {
    it("has correct category and risk level", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      expect(tool.category).toBe("productivity");
      expect(tool.riskLevel).toBe("high");
    });

    it("requires url in input schema", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      expect(tool.inputSchema.required).toContain("url");
    });

    it("input schema has template enum values", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const templateProp = tool.inputSchema.properties.template as { enum: string[] };
      expect(templateProp.enum).toEqual(["Minimalist", "ContentCreator", "Corporate", "TechDemo"]);
    });
  });

  describe("blog-to-video handler", () => {
    it("calls blogToVideo pipeline and returns structured result", async () => {
      const pipelineResult = {
        manifest: { title: "Blog Video", scenes: [] },
        blog: { title: "My Post", wordCount: 500 },
        storyboard: { scenes: [{ description: "Intro" }] },
        processingTimeMs: 3200,
      };

      vi.doMock("../../video/blog/blog-to-video-pipeline.js", () => ({
        blogToVideo: vi.fn().mockResolvedValue(pipelineResult),
      }));

      const { createBlogTools: freshCreateBlogTools } = await import("./blog-tools.js");
      tools = freshCreateBlogTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];

      const result = await tool.handler({
        url: "https://example.com/my-blog-post",
        template: "Corporate",
        style_hint: "professional",
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.manifest).toEqual(pipelineResult.manifest);
      expect(parsed.blog).toEqual(pipelineResult.blog);
      expect(parsed.storyboard).toEqual(pipelineResult.storyboard);
      expect(parsed.processingTimeMs).toBe(3200);
    });

    it("passes correct options to pipeline with defaults", async () => {
      const mockBlogToVideo = vi.fn().mockResolvedValue({
        manifest: {},
        blog: {},
        storyboard: {},
        processingTimeMs: 0,
      });

      vi.doMock("../../video/blog/blog-to-video-pipeline.js", () => ({
        blogToVideo: mockBlogToVideo,
      }));

      const { createBlogTools: freshCreateBlogTools } = await import("./blog-tools.js");
      tools = freshCreateBlogTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];

      await tool.handler({ url: "https://example.com/post" });

      expect(mockBlogToVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com/post",
          template: "Minimalist",
          imageProvider: "auto",
        }),
        mockCopilot,
        mockVoiceService,
      );
    });

    it("passes all optional parameters to pipeline", async () => {
      const mockBlogToVideo = vi.fn().mockResolvedValue({
        manifest: {},
        blog: {},
        storyboard: {},
        processingTimeMs: 0,
      });

      vi.doMock("../../video/blog/blog-to-video-pipeline.js", () => ({
        blogToVideo: mockBlogToVideo,
      }));

      const { createBlogTools: freshCreateBlogTools } = await import("./blog-tools.js");
      tools = freshCreateBlogTools({ copilot: mockCopilot, voiceService: mockVoiceService });
      const tool = tools[0];

      await tool.handler({
        url: "https://example.com/post",
        template: "TechDemo",
        style_hint: "technical",
        image_provider: "local",
        image_model: "flux",
        music_track: "/music/bg.mp3",
        target_duration: 120,
      });

      expect(mockBlogToVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com/post",
          template: "TechDemo",
          styleHint: "technical",
          imageProvider: "local",
          imageModel: "flux",
          musicTrackPath: "/music/bg.mp3",
          targetDuration: 120,
        }),
        mockCopilot,
        mockVoiceService,
      );
    });

    it("returns error when pipeline throws", async () => {
      vi.doMock("../../video/blog/blog-to-video-pipeline.js", () => ({
        blogToVideo: vi.fn().mockRejectedValue(new Error("Failed to fetch blog: 404")),
      }));

      const { createBlogTools: freshCreateBlogTools } = await import("./blog-tools.js");
      tools = freshCreateBlogTools({ copilot: mockCopilot });
      const tool = tools[0];

      const result = await tool.handler({ url: "https://example.com/not-found" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Failed to fetch blog: 404");
      expect(result.text).toContain("Error converting blog to video");
    });

    it("handles non-Error throws", async () => {
      vi.doMock("../../video/blog/blog-to-video-pipeline.js", () => ({
        blogToVideo: vi.fn().mockRejectedValue("string error"),
      }));

      const { createBlogTools: freshCreateBlogTools } = await import("./blog-tools.js");
      tools = freshCreateBlogTools({ copilot: mockCopilot });
      const tool = tools[0];

      const result = await tool.handler({ url: "https://example.com/post" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("string error");
    });

    it("passes undefined voiceService when not provided", async () => {
      const mockBlogToVideo = vi.fn().mockResolvedValue({
        manifest: {},
        blog: {},
        storyboard: {},
        processingTimeMs: 0,
      });

      vi.doMock("../../video/blog/blog-to-video-pipeline.js", () => ({
        blogToVideo: mockBlogToVideo,
      }));

      const { createBlogTools: freshCreateBlogTools } = await import("./blog-tools.js");
      tools = freshCreateBlogTools({ copilot: mockCopilot });
      const tool = tools[0];

      await tool.handler({ url: "https://example.com/post" });

      expect(mockBlogToVideo).toHaveBeenCalledWith(
        expect.anything(),
        mockCopilot,
        undefined,
      );
    });
  });

  describe("schema validation", () => {
    it("accepts valid input with url only", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({ url: "https://example.com/post" });
      expect(result.success).toBe(true);
    });

    it("accepts valid input with all fields", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        url: "https://example.com/post",
        template: "Corporate",
        style_hint: "formal",
        image_provider: "cloud",
        image_model: "flux",
        music_track: "/path/music.mp3",
        target_duration: 120,
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing url", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects invalid url format", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({ url: "not-a-url" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid template enum", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        url: "https://example.com/post",
        template: "InvalidTemplate",
      });
      expect(result.success).toBe(false);
    });

    it("rejects target_duration below minimum (30)", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        url: "https://example.com/post",
        target_duration: 10,
      });
      expect(result.success).toBe(false);
    });

    it("rejects target_duration above maximum (600)", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        url: "https://example.com/post",
        target_duration: 999,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid image_provider enum", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        url: "https://example.com/post",
        image_provider: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid image_model enum", () => {
      tools = createBlogTools({ copilot: mockCopilot });
      const tool = tools[0];
      const result = tool.zodSchema.safeParse({
        url: "https://example.com/post",
        image_model: "dalle",
      });
      expect(result.success).toBe(false);
    });
  });
});
