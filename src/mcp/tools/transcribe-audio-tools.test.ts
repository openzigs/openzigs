import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTranscribeAudioTools } from "./transcribe-audio-tools.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock fs/promises
const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    access: (...args: unknown[]) => mockAccess(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
  access: (...args: unknown[]) => mockAccess(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

function getHandler() {
  const tools = createTranscribeAudioTools({ audioSidecarUrl: "http://localhost:5006" });
  const tool = tools.find((t) => t.name === "transcribe-audio")!;
  return tool.handler;
}

describe("transcribe-audio tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("creates a tool with correct metadata", () => {
    const tools = createTranscribeAudioTools({ audioSidecarUrl: "http://localhost:5006" });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("transcribe-audio");
    expect(tools[0].category).toBe("productivity");
    expect(tools[0].riskLevel).toBe("low");
  });

  it("returns error when file not found", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const handler = getHandler();
    const result = await handler({ file_path: "/nonexistent/audio.mp3" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Audio file not found");
  });

  it("returns error for unsupported extension", async () => {
    mockAccess.mockResolvedValue(undefined);
    const handler = getHandler();
    const result = await handler({ file_path: "/tmp/audio.xyz" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unsupported audio format");
  });

  it("accepts valid audio extensions", async () => {
    // We just check the extension validation doesn't reject valid ones
    // by verifying it gets past that check (will fail at fetch)
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("fake audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection refused"));

    const handler = getHandler();
    for (const ext of [".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac", ".mp4"]) {
      const result = await handler({ file_path: `/tmp/audio${ext}` });
      // Should get past extension check — error is from fetch, not extension validation
      expect(result.text).toContain("Transcription failed");
      expect(result.text).not.toContain("Unsupported audio format");
    }

    globalThis.fetch = originalFetch;
  });

  it("handles sidecar error response", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const handler = getHandler();
    const result = await handler({ file_path: "/tmp/audio.mp3" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Transcription failed (500)");

    globalThis.fetch = originalFetch;
  });

  it("formats successful transcription result", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          text: "Hello world, this is a test.",
          language: "en",
          segments: [
            { start: 0, end: 5, text: "Hello world," },
            { start: 5, end: 10, text: "this is a test." },
          ],
          duration_seconds: 10,
        }),
    });

    const handler = getHandler();
    const result = await handler({ file_path: "/tmp/audio.mp3" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("## Transcript");
    expect(result.text).toContain("**Language**: en");
    expect(result.text).toContain("**Duration**: 10s");
    expect(result.text).toContain("Hello world, this is a test.");
    expect(result.text).toContain("### Timestamped Segments");
    expect(result.text).toContain("[0:00 → 0:05]");
    expect(result.text).toContain("[0:05 → 0:10]");

    globalThis.fetch = originalFetch;
  });

  it("resolves relative paths to gallery directory", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection refused"));

    const handler = getHandler();
    await handler({ file_path: "my-video.mp3" });

    // access() is called with a resolved gallery path
    const accessArg = mockAccess.mock.calls[0][0] as string;
    expect(accessArg).toContain(".openzigs/gallery/my-video.mp3");

    globalThis.fetch = originalFetch;
  });

  it("saves transcript file to knowledge dir on success", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          text: "Transcript content",
          language: "en",
          segments: [],
          duration_seconds: 5,
        }),
    });

    const handler = getHandler();
    const result = await handler({ file_path: "/tmp/audio.mp3" });
    expect(result.text).toContain("Transcript file saved to");
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("auto-ingests into knowledge service when provided", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          text: "Transcript content",
          language: "en",
          segments: [],
          duration_seconds: 5,
        }),
    });

    const knowledgeService = { ingestText: vi.fn().mockResolvedValue(undefined) };
    const tools = createTranscribeAudioTools({
      audioSidecarUrl: "http://localhost:5006",
      knowledgeService: knowledgeService as any,
    });
    const handler = tools[0].handler;
    const result = await handler({ file_path: "/tmp/audio.mp3" });
    expect(result.text).toContain("Transcript indexed in Knowledge");
    expect(knowledgeService.ingestText).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("handles knowledge ingestion failure gracefully", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          text: "Transcript content",
          language: "en",
          segments: [],
          duration_seconds: 5,
        }),
    });

    const knowledgeService = { ingestText: vi.fn().mockRejectedValue(new Error("ingest fail")) };
    const tools = createTranscribeAudioTools({
      audioSidecarUrl: "http://localhost:5006",
      knowledgeService: knowledgeService as any,
    });
    const handler = tools[0].handler;
    const result = await handler({ file_path: "/tmp/audio.mp3" });
    // Should not throw, just warn
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("## Transcript");

    globalThis.fetch = originalFetch;
  });

  it("formats duration over 60s as minutes", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("audio data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          text: "Long transcript",
          language: "en",
          segments: [],
          duration_seconds: 125,
        }),
    });

    const handler = getHandler();
    const result = await handler({ file_path: "/tmp/audio.mp3" });
    expect(result.text).toContain("**Duration**: 2m 5s");

    globalThis.fetch = originalFetch;
  });
});
