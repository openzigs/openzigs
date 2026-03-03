import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFsMkdir, mockFsReadFile, mockFsAccess } = vi.hoisted(() => ({
  mockFsMkdir: vi.fn(),
  mockFsReadFile: vi.fn(),
  mockFsAccess: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: (...args: any[]) => mockFsMkdir(...args),
    readFile: (...args: any[]) => mockFsReadFile(...args),
    access: (...args: any[]) => mockFsAccess(...args),
  },
}));

const { mockIngest, mockExtractViralClip, mockGenerateShortsVoiceover, mockGetAudioDuration } =
  vi.hoisted(() => ({
    mockIngest: vi.fn(),
    mockExtractViralClip: vi.fn(),
    mockGenerateShortsVoiceover: vi.fn(),
    mockGetAudioDuration: vi.fn(),
  }));

vi.mock("../ingestion/index.js", () => ({
  ingest: (...args: any[]) => mockIngest(...args),
}));
vi.mock("./viral-clip-extractor.js", () => ({
  extractViralClip: (...args: any[]) => mockExtractViralClip(...args),
}));
vi.mock("./shorts-voice-pipeline.js", () => ({
  generateShortsVoiceover: (...args: any[]) => mockGenerateShortsVoiceover(...args),
}));
vi.mock("../ingestion/audio-extractor.js", () => ({
  getAudioDuration: (...args: any[]) => mockGetAudioDuration(...args),
}));
vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createShort } from "./shorts-pipeline.js";

function setupDefaultMocks() {
  mockFsMkdir.mockResolvedValue(undefined);
  // loadSourceManifest reads manifest.json — default to not found
  mockFsReadFile.mockRejectedValue(new Error("ENOENT"));
  mockFsAccess.mockRejectedValue(new Error("ENOENT"));

  mockIngest.mockResolvedValue({
    clips: [
      {
        source: "/tmp/test.mp4",
        duration: 120,
        resolution: { width: 1920, height: 1080 },
        keyframes: [
          { timestamp: 0, path: "/tmp/f0.jpg", description: "Frame 0" },
          { timestamp: 30, path: "/tmp/f1.jpg", description: "Frame 1" },
          { timestamp: 60, path: "/tmp/f2.jpg", description: "Frame 2" },
        ],
        transcript: [
          { start: "0:00:00", end: "0:00:10", speech: "Hello world" },
          { start: "0:00:30", end: "0:00:40", speech: "Main content" },
        ],
      },
    ],
  });

  mockExtractViralClip.mockResolvedValue({
    startSeconds: 30,
    endSeconds: 75,
    rationale: "Best segment",
    suggestedHook: "You won't believe this!",
  });

  mockGenerateShortsVoiceover.mockResolvedValue({
    voiceoverPath: "/tmp/shorts/vo.mp3",
    scriptText: "This is the voiceover script. It has multiple sentences. Here is the third one.",
    originalAudioVolume: 0.1,
  });

  mockGetAudioDuration.mockResolvedValue(10.5);
}

const fakeCopilot = {} as any;
const fakeVoiceService = {} as any;

describe("createShort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("returns a complete ShortsPipelineResult", async () => {
    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    expect(result.manifest).toBeDefined();
    expect(result.manifest.templateId).toBe("ContentCreator");
    expect(result.manifest.composition.width).toBe(1080);
    expect(result.manifest.composition.height).toBe(1920);
    expect(result.manifest.composition.fps).toBe(30);
    expect(result.viralClip.startSeconds).toBe(30);
    expect(result.viralClip.endSeconds).toBe(75);
    expect(result.scriptText).toContain("voiceover script");
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("calls ingest with correct parameters", async () => {
    await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    expect(mockIngest).toHaveBeenCalledWith(
      { clips: ["/tmp/test.mp4"], mode: "highlight" },
      expect.objectContaining({ copilot: fakeCopilot, mode: "dense" }),
    );
  });

  it("throws when ingestion produces no clips", async () => {
    mockIngest.mockResolvedValue({ clips: [] });

    await expect(
      createShort({ sourceVideo: "/tmp/test.mp4" }, fakeCopilot, fakeVoiceService),
    ).rejects.toThrow("Ingestion produced no clip analysis");
  });

  it("passes style and targetDuration to extractViralClip", async () => {
    await createShort(
      { sourceVideo: "/tmp/test.mp4", style: "react", targetDuration: 30 },
      fakeCopilot,
      fakeVoiceService,
    );

    expect(mockExtractViralClip).toHaveBeenCalledWith(
      expect.anything(),
      fakeCopilot,
      expect.objectContaining({ targetDuration: 30, style: "react" }),
    );
  });

  it("passes model to extractViralClip", async () => {
    await createShort(
      { sourceVideo: "/tmp/test.mp4", model: "gpt-4o" },
      fakeCopilot,
      fakeVoiceService,
    );

    expect(mockExtractViralClip).toHaveBeenCalledWith(
      expect.anything(),
      fakeCopilot,
      expect.objectContaining({ model: "gpt-4o" }),
    );
  });

  it("builds manifest with voiceover in audio layer", async () => {
    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    expect(result.manifest.audioLayer.voiceover).toEqual(
      expect.objectContaining({
        source: "/tmp/shorts/vo.mp3",
        volume: 1.0,
        startAtFrame: 0,
      }),
    );
  });

  it("includes SmartCaptions overlay in timeline", async () => {
    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    const captionOverlay = result.manifest.timeline.find(
      (e: any) => e.type === "overlay" && e.component === "SmartCaptions",
    );
    expect(captionOverlay).toBeDefined();
    expect((captionOverlay as any).props.style).toBe("karaoke");
  });

  it("generates word timings from voiceover audio duration", async () => {
    mockGetAudioDuration.mockResolvedValue(8.0);

    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    const captionOverlay = result.manifest.timeline.find(
      (e: any) => e.type === "overlay",
    ) as any;
    expect(captionOverlay.props.words.length).toBeGreaterThan(0);
    expect(captionOverlay.props.words[0]).toHaveProperty("word");
    expect(captionOverlay.props.words[0]).toHaveProperty("start");
    expect(captionOverlay.props.words[0]).toHaveProperty("end");
  });

  it("falls back to clip duration when audio probe fails", async () => {
    mockGetAudioDuration.mockRejectedValue(new Error("ffprobe not found"));

    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    // Should still produce captions (using clip duration)
    const captionOverlay = result.manifest.timeline.find(
      (e: any) => e.type === "overlay",
    ) as any;
    expect(captionOverlay.props.words.length).toBeGreaterThan(0);
  });

  it("creates video_clip entries when no source manifest exists", async () => {
    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    const videoClips = result.manifest.timeline.filter(
      (e: any) => e.type === "video_clip",
    );
    expect(videoClips.length).toBeGreaterThan(0);
    expect((videoClips[0] as any).source).toBe("/tmp/test.mp4");
    expect((videoClips[0] as any).fitMode).toBe("cover");
  });

  it("uses image_scene entries when source manifest has images", async () => {
    // loadSourceManifest returns a manifest with image_scene entries
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        timeline: [
          {
            type: "image_scene",
            src: "/tmp/img1.jpg",
            startAtFrame: 800,
            duration: 300,
          },
          {
            type: "image_scene",
            src: "/tmp/img2.jpg",
            startAtFrame: 1100,
            duration: 300,
          },
        ],
      }),
    );
    // Images exist on disk
    mockFsAccess.mockResolvedValue(undefined);

    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    const imageScenes = result.manifest.timeline.filter(
      (e: any) => e.type === "image_scene",
    );
    expect(imageScenes.length).toBeGreaterThan(0);
  });

  it("falls back to video_clip when source images don't exist on disk", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        timeline: [
          {
            type: "image_scene",
            src: "/tmp/missing.jpg",
            startAtFrame: 800,
            duration: 300,
          },
        ],
      }),
    );
    // Image does not exist
    mockFsAccess.mockRejectedValue(new Error("ENOENT"));

    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    const videoClips = result.manifest.timeline.filter(
      (e: any) => e.type === "video_clip",
    );
    expect(videoClips.length).toBeGreaterThan(0);
  });

  it("skips title/intro/outro card frames from usable ranges", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        timeline: [
          {
            type: "title_card",
            startAtFrame: 900,
            duration: 90,
          },
          {
            type: "video_clip",
            source: "/tmp/test.mp4",
            startAtFrame: 990,
            duration: 500,
          },
        ],
      }),
    );

    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    // Should still produce a valid manifest
    expect(result.manifest.timeline.length).toBeGreaterThan(0);
  });

  it("sets metadata correctly", async () => {
    const result = await createShort(
      { sourceVideo: "/tmp/test.mp4", model: "gpt-4o" },
      fakeCopilot,
      fakeVoiceService,
    );

    expect(result.manifest.metadata!.llmModel).toBe("gpt-4o");
    expect(result.manifest.metadata!.productionMode).toBe("highlight");
    expect(result.manifest.metadata!.sourceClips).toEqual(["/tmp/test.mp4"]);
  });

  it("uses default style and targetDuration", async () => {
    await createShort(
      { sourceVideo: "/tmp/test.mp4" },
      fakeCopilot,
      fakeVoiceService,
    );

    expect(mockExtractViralClip).toHaveBeenCalledWith(
      expect.anything(),
      fakeCopilot,
      expect.objectContaining({ targetDuration: 45, style: "highlight" }),
    );
  });
});
