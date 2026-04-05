import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSpeechToTextTools } from "./speech-to-text-tools.js";
import type { ToolDefinition } from "../tool-registry.js";

const mockExistsSync = vi.fn().mockReturnValue(true);
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn().mockReturnValue(Buffer.from("fake-audio"));
const mockWriteFileSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    existsSync: (...a: unknown[]) => mockExistsSync(...a),
    mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
    readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
    writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  },
  existsSync: (...a: unknown[]) => mockExistsSync(...a),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Speech-to-Text Tools", () => {
  let tools: ToolDefinition[];

  beforeEach(() => {
    tools = createSpeechToTextTools({
      audioSidecarUrl: "http://localhost:5006",
    });
    mockFetch.mockReset();
    mockExistsSync.mockReturnValue(true);
  });

  it("should create 1 tool", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("speech-to-text");
  });

  it("should return plain text transcript by default", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: "Hello world, this is a test.",
        language: "en",
        segments: [
          { start: 0, end: 2, text: "Hello world," },
          { start: 2, end: 4, text: " this is a test." },
        ],
      }),
    });

    const tool = tools[0];
    const result = await tool.handler({ file_path: "/tmp/audio.mp3" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.format).toBe("text");
    expect(parsed.language).toBe("en");
    expect(parsed.text).toContain("Hello world");
  });

  it("should return SRT format", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: "Hello",
        language: "en",
        segments: [{ start: 0, end: 1.5, text: "Hello" }],
      }),
    });

    const tool = tools[0];
    const result = await tool.handler({
      file_path: "/tmp/audio.mp3",
      output_format: "srt",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.format).toBe("srt");
    expect(parsed.filePath).toContain("_transcript.srt");
  });

  it("should return VTT format", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: "Hello",
        language: "en",
        segments: [{ start: 0, end: 1, text: "Hello" }],
      }),
    });

    const tool = tools[0];
    const result = await tool.handler({
      file_path: "/tmp/audio.mp3",
      output_format: "vtt",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.format).toBe("vtt");
  });

  it("should error for missing file", async () => {
    mockExistsSync.mockReturnValueOnce(false);
    const tool = tools[0];
    const result = await tool.handler({ file_path: "/tmp/missing.mp3" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("File not found");
  });

  it("should handle sidecar error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Model not loaded",
    });
    const tool = tools[0];
    const result = await tool.handler({ file_path: "/tmp/audio.mp3" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("sidecar error");
  });
});
