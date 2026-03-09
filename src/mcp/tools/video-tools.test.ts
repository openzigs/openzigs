/**
 * Director Mode — Video MCP Tools Tests
 * Issue #239
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createVideoTools } from "./video-tools.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  copyFile: vi.fn(),
  join: vi.fn((...args: string[]) => args.join("/")),
  basename: vi.fn((p: string) => p.split("/").pop() || p),
  extname: vi.fn((p: string) => { const m = p.match(/\.[^./]+$/); return m ? m[0] : ""; }),
  isAbsolute: vi.fn((p: string) => p.startsWith("/")),
  homedir: vi.fn(() => "/mock-home"),
  storyboardGenerate: vi.fn(),
  imageGenInitialize: vi.fn(),
  imageGenGenerateImage: vi.fn(),
  loadUserImageGenConfig: vi.fn(),
  nanoid: vi.fn(() => "mock-id"),
  ingest: vi.fn(),
  producerProduce: vi.fn(),
  assetManagerInitialize: vi.fn(),
  assetManagerSearch: vi.fn(),
  dbRun: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: mocks.readFile, mkdir: mocks.mkdir, writeFile: mocks.writeFile, copyFile: mocks.copyFile },
  readFile: mocks.readFile,
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  copyFile: mocks.copyFile,
}));

vi.mock("node:path", () => ({
  default: { join: mocks.join, basename: mocks.basename, extname: mocks.extname, isAbsolute: mocks.isAbsolute },
  join: mocks.join,
  basename: mocks.basename,
  extname: mocks.extname,
  isAbsolute: mocks.isAbsolute,
}));

vi.mock("node:os", () => ({
  default: { homedir: mocks.homedir },
  homedir: mocks.homedir,
}));

vi.mock("../../video/generators/storyboard-engine.js", () => ({
  StoryboardEngine: vi.fn().mockImplementation(() => ({
    generate: mocks.storyboardGenerate,
  })),
}));

vi.mock("../../video/generators/image-gen-service.js", () => ({
  ImageGenService: Object.assign(
    vi.fn().mockImplementation(() => ({
      initialize: mocks.imageGenInitialize,
      generateImage: mocks.imageGenGenerateImage,
    })),
    { loadUserImageGenConfig: mocks.loadUserImageGenConfig },
  ),
}));

vi.mock("nanoid", () => ({
  nanoid: mocks.nanoid,
}));

vi.mock("../../video/ingestion/index.js", () => ({
  ingest: mocks.ingest,
}));

vi.mock("../../video/producer/producer-service.js", () => ({
  ProducerService: vi.fn().mockImplementation(() => ({
    produce: mocks.producerProduce,
  })),
}));

vi.mock("../../video/assets/asset-manager.js", () => ({
  AssetManager: vi.fn().mockImplementation(() => ({
    initialize: mocks.assetManagerInitialize,
    search: mocks.assetManagerSearch,
  })),
}));

vi.mock("../../productivity/database.js", () => ({
  getDatabase: () => ({
    prepare: () => ({ run: mocks.dbRun }),
  }),
}));

function createMockCopilot() {
  return {
    chat: function* () { yield "{}"; },
    authenticate: async () => ({}),
    waitForAuth: async () => {},
    isAuthenticated: async () => true,
    listModels: async () => [],
    onToolCall: async () => {},
    setMaxToolsPerRequest: () => {},
    getMaxToolsPerRequest: () => 30,
    destroySession: async () => {},
    hasSession: () => false,
    clearAllSessions: async () => {},
    getReasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    getProvider: () => undefined,
    setProvider: () => {},
    getWorkingDirectory: () => undefined,
    setWorkingDirectory: () => {},
    getCustomAgents: () => [],
    setCustomAgents: () => {},
    getNativeMcpServers: () => ({}),
    setNativeMcpServers: () => {},
    modelSupportsReasoning: () => false,
    getSessionUsage: () => null,
    clearSessionUsage: () => null,
  } as unknown as CopilotWrapper;
}

describe("createVideoTools", () => {
  it("returns 3 tool definitions", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    expect(tools).toHaveLength(3);
  });

  it("includes produce-video tool", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const pv = tools.find(t => t.name === "produce-video");
    expect(pv).toBeDefined();
    expect(pv!.category).toBe("productivity");
    expect(pv!.riskLevel).toBe("high");
  });

  it("includes list-templates tool", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const lt = tools.find(t => t.name === "list-templates");
    expect(lt).toBeDefined();
    expect(lt!.riskLevel).toBe("low");
  });

  it("includes search-assets tool", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const sa = tools.find(t => t.name === "search-assets");
    expect(sa).toBeDefined();
    expect(sa!.riskLevel).toBe("low");
  });

  it("list-templates handler returns template data", async () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const lt = tools.find(t => t.name === "list-templates")!;
    const result = await lt.handler({});
    const parsed = JSON.parse(result.text);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toHaveProperty("id");
    expect(parsed[0]).toHaveProperty("name");
  });

  it("list-templates filters by tag", async () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const lt = tools.find(t => t.name === "list-templates")!;
    const result = await lt.handler({ tag: "social" });
    const parsed = JSON.parse(result.text);
    for (const t of parsed) {
      expect(t.tags).toContain("social");
    }
  });

  // ── produce-video handler tests ──
  describe("produce-video handler", () => {
    const mockStoryboard = {
      title: "Test Video",
      styleAnchor: "modern",
      analysis: "test analysis",
      scenes: [
        { index: 0, voiceover: "Scene one narration", imagePrompt: "a landscape", durationEstimate: 5 },
        { index: 1, voiceover: "Scene two narration", imagePrompt: "a cityscape", durationEstimate: 3 },
      ],
      tokensUsed: 150,
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mocks.readFile.mockResolvedValue("Some document text");
      mocks.mkdir.mockResolvedValue(undefined);
      mocks.writeFile.mockResolvedValue(undefined);
      mocks.copyFile.mockResolvedValue(undefined);
      mocks.storyboardGenerate.mockResolvedValue(mockStoryboard);
      mocks.imageGenInitialize.mockResolvedValue(undefined);
      mocks.imageGenGenerateImage.mockResolvedValue({ filePath: "/mock-home/images/generated.png" });
      mocks.loadUserImageGenConfig.mockResolvedValue({});
      mocks.nanoid.mockReturnValue("mock-id");
    });

    function getProduceVideoTool() {
      const tools = createVideoTools({ copilot: createMockCopilot() });
      return tools.find(t => t.name === "produce-video")!;
    }

    it("presentation mode returns error when inputFile is missing", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "presentation" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("inputFile");
    });

    it("presentation mode generates manifest from text input", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.txt" });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.mode).toBe("presentation");
      expect(parsed.manifest).toBeDefined();
      expect(parsed.manifest.projectTitle).toBe("Test Video");
      expect(parsed.scenes).toHaveLength(2);
      expect(parsed.tokensUsed).toBe(150);
    });

    it("presentation mode strips markdown code blocks", async () => {
      const tool = getProduceVideoTool();
      mocks.readFile.mockResolvedValue("# Title\n```js\nconst x = 1;\n```\nSome text");
      await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.md", sourceType: "markdown" });
      const calledWith = mocks.storyboardGenerate.mock.calls[0][0];
      expect(calledWith).toContain("[code block removed]");
      expect(calledWith).not.toContain("const x = 1");
    });

    it("presentation mode applies markdown stripping based on .md extension", async () => {
      const tool = getProduceVideoTool();
      mocks.readFile.mockResolvedValue("```python\nprint('hi')\n```\nParagraph");
      await tool.handler({ mode: "presentation", inputFile: "/tmp/readme.md" });
      const calledWith = mocks.storyboardGenerate.mock.calls[0][0];
      expect(calledWith).toContain("[code block removed]");
    });

    it("presentation mode generates voiceover when voiceService is ready", async () => {
      const mockVoiceService = {
        isReady: vi.fn(() => true),
        initialize: vi.fn(),
        synthesize: vi.fn(async () => ({ audio: Buffer.from("audio") })),
      } as unknown as VoiceService;
      const tools = createVideoTools({ copilot: createMockCopilot(), voiceService: mockVoiceService });
      const tool = tools.find(t => t.name === "produce-video")!;
      const result = await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.txt" });
      const parsed = JSON.parse(result.text);
      expect(mockVoiceService.synthesize).toHaveBeenCalledTimes(2);
      expect(parsed.manifest.timeline).toBeDefined();
    });

    it("presentation mode initializes voiceService when not ready but credentials exist", async () => {
      const originalEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/path/to/creds.json";
      const mockVoiceService = {
        isReady: vi.fn()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true)
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true),
        initialize: vi.fn(),
        synthesize: vi.fn(async () => ({ audio: Buffer.from("audio") })),
      } as unknown as VoiceService;
      const tools = createVideoTools({ copilot: createMockCopilot(), voiceService: mockVoiceService });
      const tool = tools.find(t => t.name === "produce-video")!;
      await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.txt" });
      expect(mockVoiceService.initialize).toHaveBeenCalled();
      process.env.GOOGLE_APPLICATION_CREDENTIALS = originalEnv;
    });

    it("presentation mode handles TTS failure gracefully", async () => {
      const mockVoiceService = {
        isReady: vi.fn(() => true),
        initialize: vi.fn(),
        synthesize: vi.fn(async () => { throw new Error("TTS service down"); }),
      } as unknown as VoiceService;
      const tools = createVideoTools({ copilot: createMockCopilot(), voiceService: mockVoiceService });
      const tool = tools.find(t => t.name === "produce-video")!;
      const result = await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.txt" });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.manifest).toBeDefined();
    });

    it("presentation mode includes music track in manifest", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({
        mode: "presentation",
        inputFile: "/tmp/doc.txt",
        musicTrackPath: "/music/track.mp3",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.manifest.audioLayer.music).not.toBeNull();
      expect(parsed.manifest.audioLayer.music.track).toBe("/music/track.mp3");
      expect(parsed.manifest.audioLayer.music.ducking).toBe(true);
    });

    it("presentation mode includes voiceover path in audioLayer", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({
        mode: "presentation",
        inputFile: "/tmp/doc.txt",
        voiceoverPath: "/vo/narration.mp3",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.manifest.audioLayer.voiceover).not.toBeNull();
      expect(parsed.manifest.audioLayer.voiceover.source).toBe("/vo/narration.mp3");
    });

    it("presentation mode sets null for music/voiceover when not provided", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.txt" });
      const parsed = JSON.parse(result.text);
      expect(parsed.manifest.audioLayer.music).toBeNull();
      expect(parsed.manifest.audioLayer.voiceover).toBeNull();
    });

    it("presentation mode adds crossfade transitions between scenes", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.txt" });
      const parsed = JSON.parse(result.text);
      const transitions = parsed.manifest.timeline.filter((e: any) => e.type === "transition");
      expect(transitions).toHaveLength(1);
      expect(transitions[0].style).toBe("crossfade");
    });

    it("presentation mode alternates kenBurns pan direction by scene index", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "presentation", inputFile: "/tmp/doc.txt" });
      const parsed = JSON.parse(result.text);
      const imageScenes = parsed.manifest.timeline.filter((e: any) => e.type === "image_scene");
      expect(imageScenes[0].kenBurns.translateXTo).toBe(-10);
      expect(imageScenes[1].kenBurns.translateXTo).toBe(10);
    });

    it("presentation mode catches errors and returns error text", async () => {
      mocks.readFile.mockRejectedValue(new Error("File not found"));
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "presentation", inputFile: "/tmp/missing.txt" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("File not found");
    });

    it("highlight mode returns error when clips array is empty", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "highlight", clips: [] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("clips");
    });

    it("highlight mode returns error when clips is undefined", async () => {
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "highlight" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("clips");
    });

    it("highlight mode succeeds with clips", async () => {
      mocks.ingest.mockResolvedValue({
        clips: [{ duration: 10 }, { duration: 20 }],
        contextPayload: { someContext: true },
      });
      mocks.producerProduce.mockResolvedValue({
        manifest: { projectTitle: "Highlights" },
        tokensUsed: 200,
      });
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "highlight", clips: ["/clip1.mp4", "/clip2.mp4"] });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.manifest.projectTitle).toBe("Highlights");
      expect(parsed.clipsProcessed).toBe(2);
      expect(parsed.totalDuration).toBe(30);
    });

    it("script mode passes correct mode to ingestion", async () => {
      mocks.ingest.mockResolvedValue({
        clips: [{ duration: 15 }],
        contextPayload: {},
      });
      mocks.producerProduce.mockResolvedValue({
        manifest: {},
        tokensUsed: 100,
      });
      const tool = getProduceVideoTool();
      await tool.handler({
        mode: "script",
        clips: ["/clip.mp4"],
        scriptPath: "/script.txt",
        template: "Corporate",
      });
      expect(mocks.ingest).toHaveBeenCalledWith(
        { clips: ["/clip.mp4"], mode: "script" },
        {},
      );
      expect(mocks.producerProduce).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "script",
          scriptPath: "/script.txt",
          preferredTemplate: "Corporate",
        }),
      );
    });

    it("highlight/script mode catches errors and returns error text", async () => {
      mocks.ingest.mockRejectedValue(new Error("Ingestion failed"));
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "highlight", clips: ["/bad.mp4"] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Ingestion failed");
    });

    it("produce-video catches non-Error thrown values", async () => {
      mocks.ingest.mockRejectedValue("string error");
      const tool = getProduceVideoTool();
      const result = await tool.handler({ mode: "highlight", clips: ["/clip.mp4"] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("string error");
    });
  });

  // ── search-assets handler tests ──
  describe("search-assets handler", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    function getSearchAssetsTool() {
      const tools = createVideoTools({ copilot: createMockCopilot() });
      return tools.find(t => t.name === "search-assets")!;
    }

    it("returns search results from asset manager", async () => {
      mocks.assetManagerInitialize.mockResolvedValue(undefined);
      mocks.assetManagerSearch.mockResolvedValue([
        { id: "1", title: "Chill Beat", source: "local" },
      ]);
      const tool = getSearchAssetsTool();
      const result = await tool.handler({ query: "chill music" });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].title).toBe("Chill Beat");
    });

    it("passes source, type and maxResults to asset manager", async () => {
      mocks.assetManagerInitialize.mockResolvedValue(undefined);
      mocks.assetManagerSearch.mockResolvedValue([]);
      const tool = getSearchAssetsTool();
      await tool.handler({ query: "drums", source: "pixabay", type: "sfx", maxResults: 5 });
      expect(mocks.assetManagerSearch).toHaveBeenCalledWith({
        query: "drums",
        source: "pixabay",
        type: "sfx",
        perPage: 5,
      });
    });

    it("defaults source to 'all' and maxResults to 10", async () => {
      mocks.assetManagerInitialize.mockResolvedValue(undefined);
      mocks.assetManagerSearch.mockResolvedValue([]);
      const tool = getSearchAssetsTool();
      await tool.handler({ query: "nature" });
      expect(mocks.assetManagerSearch).toHaveBeenCalledWith({
        query: "nature",
        source: "all",
        type: undefined,
        perPage: 10,
      });
    });

    it("returns error on failure", async () => {
      mocks.assetManagerInitialize.mockRejectedValue(new Error("Connection refused"));
      const tool = getSearchAssetsTool();
      const result = await tool.handler({ query: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Connection refused");
    });

    it("handles non-Error thrown values", async () => {
      mocks.assetManagerInitialize.mockRejectedValue("unknown failure");
      const tool = getSearchAssetsTool();
      const result = await tool.handler({ query: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("unknown failure");
    });
  });
});
