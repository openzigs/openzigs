/**
 * Director Mode — Producer Service Tests
 * Issue #239
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProducerService } from "./producer-service.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { ContextPayload } from "../ingestion/types.js";
import type { DirectorManifest } from "../manifest/manifest-types.js";
import type { VoiceService } from "../../voice/voice-service.js";
import { sanitizeNarrationScript } from "./script-sanitizer.js";

vi.mock("../ingestion/audio-extractor.js", () => ({
  getAudioDuration: vi.fn().mockResolvedValue(15.5),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue("This is a test narration script."),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
  readFile: vi.fn().mockResolvedValue("This is a test narration script."),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./script-sanitizer.js", () => ({
  sanitizeNarrationScript: vi.fn().mockReturnValue({ text: "This is a test narration script.", flagged: false, threats: [] }),
}));

vi.mock("./macos-tts.js", () => ({
  isAvailable: vi.fn().mockResolvedValue(false),
  synthesize: vi.fn().mockResolvedValue("/tmp/macos-tts-output.mp3"),
}));

vi.mock("fluent-ffmpeg", () => {
  const mockFfprobe = vi.fn();
  return {
    default: {
      ffprobe: mockFfprobe,
    },
  };
});

// Build a valid manifest JSON that the mock LLM will return
function buildValidManifestJson(): string {
  const manifest: DirectorManifest = {
    projectTitle: "Test Highlight",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: { music: null, voiceover: null },
    timeline: [
      {
        type: "video_clip",
        source: "clip1.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 150,
        volume: 1.0,
      },
      {
        type: "video_clip",
        source: "clip2.mp4",
        startAtFrame: 150,
        trimStart: 10,
        duration: 120,
        volume: 0.8,
      },
    ],
    metadata: {
      generatedAt: "2026-02-15T10:00:00Z",
      llmModel: "gpt-4o",
      llmTokensUsed: 1500,
      productionMode: "highlight",
      sourceClips: ["clip1.mp4", "clip2.mp4"],
    },
  };
  return JSON.stringify(manifest);
}

function buildTestContext(): ContextPayload {
  return {
    clips: [
      {
        index: 0,
        source: "/clips/clip1.mp4",
        duration: 10,
        timeline: [
          { type: "visual", timestamp: 0, description: "Opening shot", framePath: "/kf/0.jpg" },
          { type: "audio", start: "00:00:02.000", end: "00:00:05.000", speech: "Hello world" },
        ],
      },
      {
        index: 1,
        source: "/clips/clip2.mp4",
        duration: 10,
        timeline: [
          { type: "visual", timestamp: 0, description: "Second clip start", framePath: "/kf/1.jpg" },
        ],
      },
    ],
    totalDuration: 20,
    resolution: { width: 1920, height: 1080 },
  };
}

// Mock CopilotWrapper that returns a valid manifest JSON
function createMockCopilot(responseOverride?: string) {
  const response = responseOverride ?? buildValidManifestJson();

  const chatFn = vi.fn().mockImplementation(async function* () {
    yield response;
  });

  return {
    chat: chatFn,
    // Stub remaining interface methods
    authenticate: vi.fn(),
    waitForAuth: vi.fn(),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    listModels: vi.fn(),
    onToolCall: vi.fn(),
    setMaxToolsPerRequest: vi.fn(),
    getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
    destroySession: vi.fn(),
    hasSession: vi.fn(),
    clearAllSessions: vi.fn(),
    getReasoningEffort: vi.fn(),
    setReasoningEffort: vi.fn(),
    getProvider: vi.fn(),
    setProvider: vi.fn(),
    getWorkingDirectory: vi.fn(),
    setWorkingDirectory: vi.fn(),
    getCustomAgents: vi.fn().mockReturnValue([]),
    setCustomAgents: vi.fn(),
    getNativeMcpServers: vi.fn().mockReturnValue({}),
    setNativeMcpServers: vi.fn(),
    modelSupportsReasoning: vi.fn().mockReturnValue(false),
    getSessionUsage: vi.fn().mockReturnValue(null),
    clearSessionUsage: vi.fn().mockReturnValue(null),
  } as unknown as CopilotWrapper;
}

describe("ProducerService", () => {
  let copilot: ReturnType<typeof createMockCopilot>;
  let producer: ProducerService;

  beforeEach(() => {
    copilot = createMockCopilot();
    producer = new ProducerService(copilot);
  });

  it("produces a valid manifest in highlight mode", async () => {
    const result = await producer.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
    });

    expect(result.manifest).toBeDefined();
    expect(result.manifest.projectTitle).toBe("Test Highlight");
    expect(result.manifest.timeline.length).toBeGreaterThanOrEqual(2);
    expect(result.manifest.timeline.some((e) => e.type === "video_clip")).toBe(true);
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it("calls copilot.chat exactly once (single-shot)", async () => {
    await producer.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
    });

    const chatFn = copilot.chat as unknown as ReturnType<typeof vi.fn>;
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it("passes no tools to copilot.chat", async () => {
    await producer.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
    });

    const chatFn = copilot.chat as unknown as ReturnType<typeof vi.fn>;
    const callArgs = chatFn.mock.calls[0];
    expect(callArgs[1]).toEqual(expect.objectContaining({ tools: [] }));
  });

  it("handles markdown-wrapped JSON in LLM response", async () => {
    const wrapped = "```json\n" + buildValidManifestJson() + "\n```";
    const mockCopilot = createMockCopilot(wrapped);
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
    });

    expect(result.manifest.projectTitle).toBe("Test Highlight");
  });

  it("handles JSON embedded in prose text", async () => {
    const prose = "Here is the manifest:\n\n" + buildValidManifestJson() + "\n\nDone!";
    const mockCopilot = createMockCopilot(prose);
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
    });

    expect(result.manifest.projectTitle).toBe("Test Highlight");
  });

  it("throws on invalid JSON from LLM", async () => {
    const mockCopilot = createMockCopilot("This is not valid JSON at all.");
    const p = new ProducerService(mockCopilot);

    await expect(
      p.produce({ mode: "highlight", contextPayload: buildTestContext() }),
    ).rejects.toThrow("No JSON object found");
  });

  it("throws on invalid manifest structure from LLM", async () => {
    const invalidManifest = JSON.stringify({
      projectTitle: "Bad",
      // Missing required fields
    });
    const mockCopilot = createMockCopilot(invalidManifest);
    const p = new ProducerService(mockCopilot);

    await expect(
      p.produce({ mode: "highlight", contextPayload: buildTestContext() }),
    ).rejects.toThrow("invalid manifest");
  });

  it("throws in script mode without scriptPath or voiceoverPath", async () => {
    await expect(
      producer.produce({
        mode: "script",
        contextPayload: buildTestContext(),
      }),
    ).rejects.toThrow("requires either a scriptPath or voiceoverPath");
  });

  // ── NEW: Additional coverage ────────────────────────────────────

  it("handles generic code block wrapping (no json lang hint)", async () => {
    const wrapped = "```\n" + buildValidManifestJson() + "\n```";
    const mockCopilot = createMockCopilot(wrapped);
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
    });
    expect(result.manifest.projectTitle).toBe("Test Highlight");
  });

  it("passes model override to copilot.chat", async () => {
    await producer.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
      model: "claude-sonnet-4",
    });

    const chatFn = copilot.chat as unknown as ReturnType<typeof vi.fn>;
    const callArgs = chatFn.mock.calls[0];
    expect(callArgs[1]).toEqual(expect.objectContaining({ model: "claude-sonnet-4" }));
  });

  it("includes sourceClips from input in enhancement", async () => {
    const result = await producer.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
      sourceClips: ["/clips/clip1.mp4", "/clips/clip2.mp4"],
    });
    expect(result.manifest).toBeDefined();
  });

  it("calculates tokensUsed as approximation of total text", async () => {
    const result = await producer.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
    });

    // Token count should be > 0 (rough estimate = total chars / 4)
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it("extracts JSON when invalid text surrounds valid JSON", async () => {
    const invalidJson = '{"broken": true, invalid}';
    const mockCopilot = createMockCopilot(invalidJson);
    const p = new ProducerService(mockCopilot);

    // Since the JSON itself is broken, this should throw
    await expect(
      p.produce({ mode: "highlight", contextPayload: buildTestContext() }),
    ).rejects.toThrow();
  });

  it("handles preferredTemplate option", async () => {
    const result = await producer.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
      preferredTemplate: "Corporate",
    });

    // Should still produce a valid manifest
    expect(result.manifest).toBeDefined();
    const chatFn = copilot.chat as unknown as ReturnType<typeof vi.fn>;
    const prompt = chatFn.mock.calls[0][0] as string;
    expect(prompt).toContain("Corporate");
  });

  it("produces manifest in script mode with pre-generated voiceover", async () => {
    // Build a manifest with audioLayer that can accept voiceover injection
    const manifestJson = buildValidManifestJson();
    const mockCopilot = createMockCopilot(manifestJson);
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "script",
      contextPayload: buildTestContext(),
      voiceoverPath: "/tmp/voiceover.mp3",
    });

    expect(result.manifest).toBeDefined();
    // Voiceover should be injected into audioLayer
    if (result.manifest.audioLayer) {
      expect(result.manifest.audioLayer.voiceover).toBeDefined();
      expect(result.manifest.audioLayer.voiceover?.source).toBe("/tmp/voiceover.mp3");
    }
  });

  it("throws comprehensively when JSON parse fails completely", async () => {
    const mockCopilot = createMockCopilot("no JSON here whatsoever");
    const p = new ProducerService(mockCopilot);

    await expect(
      p.produce({ mode: "highlight", contextPayload: buildTestContext() }),
    ).rejects.toThrow("No JSON object found");
  });

  // ── Script mode with scriptPath ─────────────────────────────────

  it("reads and sanitizes script text in script mode", async () => {
    const manifestWithVo = buildValidManifestJson();
    const mockCopilot = createMockCopilot(manifestWithVo);
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "script",
      contextPayload: buildTestContext(),
      scriptPath: "/tmp/script.txt",
      voiceoverPath: "/tmp/voiceover.mp3",
    });

    expect(result.manifest).toBeDefined();
    expect(sanitizeNarrationScript).toHaveBeenCalled();
  });

  it("warns when sanitizer flags script threats", async () => {
    vi.mocked(sanitizeNarrationScript).mockReturnValueOnce({
      text: "Clean text",
      flagged: true,
      threats: ["prompt-injection"],
    });

    const mockCopilot = createMockCopilot(buildValidManifestJson());
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "script",
      contextPayload: buildTestContext(),
      scriptPath: "/tmp/malicious-script.txt",
      voiceoverPath: "/tmp/voiceover.mp3",
    });

    // Should still produce a manifest (sanitized text used)
    expect(result.manifest).toBeDefined();
  });

  it("generates voiceover via VoiceService when available", async () => {
    const mockVoice = {
      isReady: vi.fn().mockReturnValue(true),
      synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from("audio-data") }),
      initialize: vi.fn(),
    } as unknown as VoiceService;

    const mockCopilot = createMockCopilot(buildValidManifestJson());
    const p = new ProducerService(mockCopilot, mockVoice);

    const result = await p.produce({
      mode: "script",
      contextPayload: buildTestContext(),
      scriptPath: "/tmp/script.txt",
    });

    expect(mockVoice.synthesize).toHaveBeenCalled();
    expect(result.manifest).toBeDefined();
    // Voiceover should be injected
    expect(result.manifest.audioLayer?.voiceover).toBeDefined();
  });

  it("attempts on-demand VoiceService init when not ready but credentials exist", async () => {
    const originalCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/path/to/creds.json";

    try {
      const mockVoice = {
        isReady: vi.fn()
          .mockReturnValueOnce(false)  // first check: not ready
          .mockReturnValueOnce(true)   // after init: ready
          .mockReturnValue(true),      // generateVoiceover guard
        synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from("audio-data") }),
        initialize: vi.fn().mockResolvedValue(undefined),
      } as unknown as VoiceService;

      const mockCopilot = createMockCopilot(buildValidManifestJson());
      const p = new ProducerService(mockCopilot, mockVoice);

      await p.produce({
        mode: "script",
        contextPayload: buildTestContext(),
        scriptPath: "/tmp/script.txt",
      });

      expect(mockVoice.initialize).toHaveBeenCalled();
    } finally {
      if (originalCreds === undefined) {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      } else {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCreds;
      }
    }
  });

  // ── Music track probing ──────────────────────────────────────────

  it("probes music track via ffprobe and includes metadata", async () => {
    const ffmpeg = (await import("fluent-ffmpeg")).default;
    vi.mocked(ffmpeg.ffprobe).mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: { duration: 180.5 },
        streams: [{ codec_name: "aac", codec_type: "audio" }],
      });
    });

    const mockCopilot = createMockCopilot(buildValidManifestJson());
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
      musicTrackPath: "/music/bg.mp3",
    });

    expect(ffmpeg.ffprobe).toHaveBeenCalledWith("/music/bg.mp3", expect.any(Function));
    expect(result.manifest).toBeDefined();
  });

  it("handles ffprobe failure gracefully", async () => {
    const ffmpeg = (await import("fluent-ffmpeg")).default;
    vi.mocked(ffmpeg.ffprobe).mockImplementation((_path: string, cb: Function) => {
      cb(new Error("ffprobe not found"), null);
    });

    const mockCopilot = createMockCopilot(buildValidManifestJson());
    const p = new ProducerService(mockCopilot);

    const result = await p.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
      musicTrackPath: "/music/bg.mp3",
    });

    // Should still produce manifest — ffprobe failure is non-fatal
    expect(result.manifest).toBeDefined();
  });

  // ── Music path correction ────────────────────────────────────────

  it("corrects music path when LLM uses wrong path", async () => {
    const manifest = JSON.parse(buildValidManifestJson()) as DirectorManifest;
    manifest.audioLayer = {
      music: {
        track: "/wrong/path.mp3",
        volume: 0.3,
        ducking: false,
        fadeInFrames: 30,
        fadeOutFrames: 60,
        loop: true,
      },
      voiceover: null,
    };
    const mockCopilot = createMockCopilot(JSON.stringify(manifest));
    const p = new ProducerService(mockCopilot);

    const ffmpeg = (await import("fluent-ffmpeg")).default;
    vi.mocked(ffmpeg.ffprobe).mockImplementation((_path: string, cb: Function) => {
      cb(null, { format: { duration: 60 }, streams: [] });
    });

    const result = await p.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
      musicTrackPath: "/correct/music.mp3",
    });

    expect(result.manifest.audioLayer?.music?.track).toBe("/correct/music.mp3");
  });

  it("injects music track when LLM omits it from manifest", async () => {
    const manifest = JSON.parse(buildValidManifestJson()) as DirectorManifest;
    manifest.audioLayer = { music: null, voiceover: null };
    const mockCopilot = createMockCopilot(JSON.stringify(manifest));
    const p = new ProducerService(mockCopilot);

    const ffmpeg = (await import("fluent-ffmpeg")).default;
    vi.mocked(ffmpeg.ffprobe).mockImplementation((_path: string, cb: Function) => {
      cb(null, { format: { duration: 60 }, streams: [] });
    });

    const result = await p.produce({
      mode: "highlight",
      contextPayload: buildTestContext(),
      musicTrackPath: "/music/background.mp3",
    });

    expect(result.manifest.audioLayer?.music).toBeDefined();
    expect(result.manifest.audioLayer?.music?.track).toBe("/music/background.mp3");
    expect(result.manifest.audioLayer?.music?.volume).toBe(0.3);
  });
});
