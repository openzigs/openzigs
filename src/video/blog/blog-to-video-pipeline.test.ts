import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFsMkdir, mockFsWriteFile, mockFsReadFile,
  mockExtractBlog, mockValidateUrl,
  mockStoryboardGenerate,
  mockImageGenInit, mockImageGenGenerate, mockImageGenCheckHealth, mockLoadUserConfig,
} = vi.hoisted(() => ({
  mockFsMkdir: vi.fn(),
  mockFsWriteFile: vi.fn(),
  mockFsReadFile: vi.fn(),
  mockExtractBlog: vi.fn(),
  mockValidateUrl: vi.fn(),
  mockStoryboardGenerate: vi.fn(),
  mockImageGenInit: vi.fn(),
  mockImageGenGenerate: vi.fn(),
  mockImageGenCheckHealth: vi.fn(),
  mockLoadUserConfig: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: (...args: any[]) => mockFsMkdir(...args),
    writeFile: (...args: any[]) => mockFsWriteFile(...args),
    readFile: (...args: any[]) => mockFsReadFile(...args),
  },
}));

vi.mock("./blog-extractor.js", () => ({
  extractBlog: (...args: any[]) => mockExtractBlog(...args),
  validateUrl: (...args: any[]) => mockValidateUrl(...args),
}));

vi.mock("../generators/storyboard-engine.js", () => {
  return {
    StoryboardEngine: class {
      generate(...args: any[]) { return mockStoryboardGenerate(...args); }
    },
  };
});

vi.mock("../generators/image-gen-service.js", () => {
  class MockImageGenService {
    isNetworkMode = false;
    initialize(...args: any[]) { return mockImageGenInit(...args); }
    generateImage(...args: any[]) { return mockImageGenGenerate(...args); }
    checkHealth(...args: any[]) { return mockImageGenCheckHealth(...args); }
    static loadUserImageGenConfig(...args: any[]) { return mockLoadUserConfig(...args); }
  }
  return { ImageGenService: MockImageGenService };
});

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("nanoid", () => ({ nanoid: () => "test1234" }));

// Mock child_process spawn used by probeAudioDuration
vi.mock("node:child_process", () => {
  const mockProc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: Function) => {
      if (event === "close") setTimeout(() => cb(1), 0);
      return mockProc;
    }),
  };
  return {
    spawn: vi.fn(() => mockProc),
    exec: vi.fn(),
    execFile: vi.fn(),
  };
});

import { blogToVideo } from "./blog-to-video-pipeline.js";

function setupDefaultMocks() {
  mockFsMkdir.mockResolvedValue(undefined);
  mockFsWriteFile.mockResolvedValue(undefined);
  mockFsReadFile.mockResolvedValue(Buffer.from("fake-image-data"));
  mockLoadUserConfig.mockResolvedValue({});

  mockExtractBlog.mockResolvedValue({
    text: "This is a blog post about testing. It covers many topics. Testing is important for quality.",
    metadata: { title: "Test Blog", description: "A test blog post" },
    wordCount: 500,
    images: [],
    resolvedUrl: "https://example.com/blog",
  });

  mockValidateUrl.mockImplementation((url: string) => new URL(url));

  mockStoryboardGenerate.mockResolvedValue({
    title: "Test Video Storyboard",
    styleAnchor: "Modern minimal style with clean lines",
    scenes: [
      {
        index: 0,
        voiceover: "Welcome to this video about testing.",
        imagePrompt: "A clean modern workspace with computer screens",
        rawImageDescription: "Modern workspace",
        durationEstimate: 5,
        blogImageIndex: null,
        chapterTitle: null,
        textOverlays: [],
      },
    ],
    analysis: {
      tone: "professional",
      audience: "developers",
      coreThemes: ["testing", "quality"],
    },
    tokensUsed: 1500,
  });

  mockImageGenInit.mockResolvedValue(undefined);
  mockImageGenGenerate.mockResolvedValue({
    filePath: "/tmp/images/generated.png",
    width: 768,
    height: 432,
  });
  mockImageGenCheckHealth.mockResolvedValue({ local: true });

  // Mock global fetch for image downloading
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(Buffer.from("fake-image"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    }),
  );
}

const fakeCopilot = {
  chat: vi.fn().mockImplementation(function* () {
    yield "A professional workspace image";
  }),
} as any;

describe("blogToVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("returns a complete BlogToVideoResult", async () => {
    const result = await blogToVideo(
      { url: "https://example.com/blog" },
      fakeCopilot,
    );

    expect(result.manifest).toBeDefined();
    expect(result.manifest.projectTitle).toBe("Test Video Storyboard");
    expect(result.manifest.templateId).toBe("Minimalist");
    expect(result.manifest.composition.fps).toBe(30);
    expect(result.blog.title).toBe("Test Blog");
    expect(result.blog.wordCount).toBe(500);
    expect(result.storyboard.sceneCount).toBe(1);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("calls extractBlog with the URL", async () => {
    await blogToVideo({ url: "https://example.com/post" }, fakeCopilot);
    expect(mockExtractBlog).toHaveBeenCalledWith("https://example.com/post");
  });

  it("builds image_scene timeline entries for each storyboard scene", async () => {
    const result = await blogToVideo(
      { url: "https://example.com/blog" },
      fakeCopilot,
    );

    const imageScenes = result.manifest.timeline.filter(
      (e: any) => e.type === "image_scene",
    );
    expect(imageScenes.length).toBe(1);
    expect((imageScenes[0] as any).src).toBe("/tmp/images/generated.png");
    expect((imageScenes[0] as any).kenBurns).toBeDefined();
  });

  it("adds crossfade transitions between scenes", async () => {
    mockStoryboardGenerate.mockResolvedValue({
      title: "Multi-scene",
      styleAnchor: "Clean",
      scenes: [
        { index: 0, voiceover: "Scene one", imagePrompt: "p1", rawImageDescription: "d1", durationEstimate: 5, blogImageIndex: null, chapterTitle: null, textOverlays: [] },
        { index: 1, voiceover: "Scene two", imagePrompt: "p2", rawImageDescription: "d2", durationEstimate: 5, blogImageIndex: null, chapterTitle: null, textOverlays: [] },
      ],
      analysis: { tone: "pro", audience: "dev", coreThemes: ["test"] },
      tokensUsed: 500,
    });

    const result = await blogToVideo(
      { url: "https://example.com/blog", imageProvider: "local" },
      fakeCopilot,
    );

    const transitions = result.manifest.timeline.filter(
      (e: any) => e.type === "transition",
    );
    expect(transitions.length).toBeGreaterThan(0);
    expect((transitions[0] as any).style).toBe("crossfade");
  });

  it("uses custom template when provided", async () => {
    const result = await blogToVideo(
      { url: "https://example.com/blog", template: "Corporate" },
      fakeCopilot,
    );

    expect(result.manifest.templateId).toBe("Corporate");
  });

  it("passes model to storyboard engine", async () => {
    await blogToVideo(
      { url: "https://example.com/blog", model: "gpt-4o" },
      fakeCopilot,
    );

    const storyboardOpts = mockStoryboardGenerate.mock.calls[0][1];
    expect(storyboardOpts.model).toBe("gpt-4o");
  });

  it("passes styleHint to storyboard options", async () => {
    await blogToVideo(
      { url: "https://example.com/blog", styleHint: "dark and moody" },
      fakeCopilot,
    );

    const storyboardOpts = mockStoryboardGenerate.mock.calls[0][1];
    expect(storyboardOpts.styleHint).toBe("dark and moody");
  });

  it("passes brandVoiceBlock to storyboard options", async () => {
    await blogToVideo(
      { url: "https://example.com/blog", brandVoiceBlock: "Speak casually" },
      fakeCopilot,
    );

    const storyboardOpts = mockStoryboardGenerate.mock.calls[0][1];
    expect(storyboardOpts.brandVoiceBlock).toBe("Speak casually");
  });

  it("includes music in audio layer when provided", async () => {
    const result = await blogToVideo(
      { url: "https://example.com/blog", musicTrackPath: "/tmp/music.mp3" },
      fakeCopilot,
    );

    expect(result.manifest.audioLayer.music).toEqual(
      expect.objectContaining({
        track: "/tmp/music.mp3",
        ducking: true,
        loop: true,
      }),
    );
  });

  it("sets music to null when no track provided", async () => {
    const result = await blogToVideo(
      { url: "https://example.com/blog" },
      fakeCopilot,
    );

    expect(result.manifest.audioLayer.music).toBeNull();
  });

  it("downloads blog images and passes them as visual assets", async () => {
    mockExtractBlog.mockResolvedValue({
      text: "Blog with images",
      metadata: { title: "Image Blog", description: "Has images" },
      wordCount: 200,
      images: [
        { url: "https://example.com/img1.jpg", alt: "Image 1", surroundingText: "Near this text" },
      ],
      resolvedUrl: "https://example.com/blog",
    });

    await blogToVideo({ url: "https://example.com/blog" }, fakeCopilot);

    expect(globalThis.fetch).toHaveBeenCalled();
    const storyboardOpts = mockStoryboardGenerate.mock.calls[0][1];
    expect(storyboardOpts.visualAssets).toBeDefined();
    expect(storyboardOpts.visualAssets.length).toBe(1);
  });

  it("skips image download on invalid URL", async () => {
    mockExtractBlog.mockResolvedValue({
      text: "Blog",
      metadata: { title: "Blog", description: "Desc" },
      wordCount: 100,
      images: [{ url: "not-a-valid-url", alt: "Bad" }],
      resolvedUrl: "https://example.com/blog",
    });
    mockValidateUrl.mockImplementation(() => {
      throw new Error("Invalid URL");
    });

    const result = await blogToVideo(
      { url: "https://example.com/blog" },
      fakeCopilot,
    );

    expect(result).toBeDefined();
  });

  it("uses blog image when scene has blogImageIndex", async () => {
    mockExtractBlog.mockResolvedValue({
      text: "Blog with image",
      metadata: { title: "Blog", description: "Desc" },
      wordCount: 200,
      images: [{ url: "https://example.com/img.jpg", alt: "Blog image" }],
      resolvedUrl: "https://example.com/blog",
    });

    mockStoryboardGenerate.mockResolvedValue({
      title: "Storyboard",
      styleAnchor: "Clean",
      scenes: [
        {
          index: 0,
          voiceover: "Scene with blog image",
          imagePrompt: "prompt",
          rawImageDescription: "desc",
          durationEstimate: 5,
          blogImageIndex: 0,
          chapterTitle: null,
          textOverlays: [],
        },
      ],
      analysis: { tone: "pro", audience: "dev", coreThemes: ["test"] },
      tokensUsed: 500,
    });

    const result = await blogToVideo(
      { url: "https://example.com/blog" },
      fakeCopilot,
    );

    // Should have used blog image instead of generating one
    const imageScenes = result.manifest.timeline.filter(
      (e: any) => e.type === "image_scene",
    );
    expect(imageScenes.length).toBe(1);
    // Should NOT have called image gen for this scene
    expect(mockImageGenGenerate).not.toHaveBeenCalled();
  });

  it("adds chapter title cards when scene has chapterTitle", async () => {
    mockStoryboardGenerate.mockResolvedValue({
      title: "Storyboard",
      styleAnchor: "Clean",
      scenes: [
        {
          index: 0,
          voiceover: "Intro scene",
          imagePrompt: "prompt",
          rawImageDescription: "desc",
          durationEstimate: 5,
          blogImageIndex: null,
          chapterTitle: "Chapter 1: Getting Started",
          textOverlays: [],
        },
      ],
      analysis: { tone: "pro", audience: "dev", coreThemes: ["test"] },
      tokensUsed: 500,
    });

    const result = await blogToVideo(
      { url: "https://example.com/blog" },
      fakeCopilot,
    );

    const titleCards = result.manifest.timeline.filter(
      (e: any) => e.type === "title_card",
    );
    expect(titleCards.length).toBe(1);
    expect((titleCards[0] as any).title).toBe("Chapter 1: Getting Started");
  });

  it("skips scene when image generation fails", async () => {
    mockImageGenGenerate.mockRejectedValue(new Error("GPU OOM"));

    const result = await blogToVideo(
      { url: "https://example.com/blog" },
      fakeCopilot,
    );

    // Scenes with failed image gen are skipped
    const imageScenes = result.manifest.timeline.filter(
      (e: any) => e.type === "image_scene",
    );
    expect(imageScenes.length).toBe(0);
  });

  it("sets metadata correctly", async () => {
    const result = await blogToVideo(
      { url: "https://example.com/blog", model: "claude-3" },
      fakeCopilot,
    );

    expect(result.manifest.metadata.llmModel).toBe("claude-3");
    expect(result.manifest.metadata.productionMode).toBe("presentation");
    expect(result.manifest.metadata.llmTokensUsed).toBe(1500);
  });

  it("passes targetDuration to storyboard", async () => {
    await blogToVideo(
      { url: "https://example.com/blog", targetDuration: 120 },
      fakeCopilot,
    );

    const storyboardOpts = mockStoryboardGenerate.mock.calls[0][1];
    expect(storyboardOpts.targetDuration).toBe(120);
  });

  it("limits blog images to 20", async () => {
    const images = Array.from({ length: 25 }, (_, i) => ({
      url: `https://example.com/img${i}.jpg`,
      alt: `Image ${i}`,
    }));
    mockExtractBlog.mockResolvedValue({
      text: "Blog",
      metadata: { title: "Blog", description: "Desc" },
      wordCount: 200,
      images,
      resolvedUrl: "https://example.com/blog",
    });

    await blogToVideo({ url: "https://example.com/blog" }, fakeCopilot);

    // fetch should be called at most 20 times for images (plus any vision captioning)
    const fetchCalls = (globalThis.fetch as any).mock.calls.length;
    expect(fetchCalls).toBeLessThanOrEqual(20);
  });
});
