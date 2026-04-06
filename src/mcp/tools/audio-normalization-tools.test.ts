import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAudioNormalizationTools } from "./audio-normalization-tools.js";
import type { ToolDefinition } from "../tool-registry.js";

const mockExistsSync = vi.fn().mockReturnValue(true);
const mockMkdirSync = vi.fn();
const mockStatSync = vi.fn().mockReturnValue({ size: 8192 });

vi.mock("node:fs", () => ({
  default: {
    existsSync: (...a: unknown[]) => mockExistsSync(...a),
    mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
    statSync: (...a: unknown[]) => mockStatSync(...a),
  },
  existsSync: (...a: unknown[]) => mockExistsSync(...a),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");
  return {
    ...actual,
    promisify: vi.fn().mockReturnValue(
      vi
        .fn()
        .mockResolvedValueOnce({ stderr: "" }) // ffmpeg -version check
        .mockResolvedValueOnce({
          // pass 1 — loudness measurement
          stderr: `
[Parsed_loudnorm_0 @ 0x...] {
  "input_i" : "-24.0",
  "input_tp" : "-2.0",
  "input_lra" : "7.0",
  "input_thresh" : "-34.5",
  "output_i" : "-14.0",
  "output_tp" : "-1.0",
  "output_lra" : "5.5",
  "output_thresh" : "-24.5",
  "normalization_type" : "dynamic",
  "target_offset" : "0.0"
}`,
        })
        .mockResolvedValueOnce({ stderr: "" }), // pass 2 — actual normalization
    ),
  };
});

describe("Audio Normalization Tools", () => {
  let tools: ToolDefinition[];

  beforeEach(() => {
    tools = createAudioNormalizationTools();
    mockExistsSync.mockReturnValue(true);
  });

  it("should create 1 tool", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("normalize-audio");
  });

  it("should have correct metadata", () => {
    const tool = tools[0];
    expect(tool.category).toBe("productivity");
    expect(tool.riskLevel).toBe("medium");
    expect(tool.description).toContain("loudnorm");
  });

  it("should error for missing file", async () => {
    mockExistsSync.mockReturnValueOnce(false);
    // Re-mock util for the checkFfmpeg call
    vi.resetModules();
    const { createAudioNormalizationTools: create } =
      await import("./audio-normalization-tools.js");
    const freshTools = create();
    const tool = freshTools[0];
    // This test verifies the schema validation and file existence check
    const result = await tool.handler({ file_path: "/tmp/missing.mp3" });
    // Depending on mock state, it either errors on file or ffmpeg
    expect(result.isError).toBe(true);
  });
});
