import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFsMkdir, mockFsWriteFile, mockFsReadFile, mockFsRename, mockFsUnlink,
  mockExecFileAsync, mockNanoid,
} = vi.hoisted(() => ({
  mockFsMkdir: vi.fn(),
  mockFsWriteFile: vi.fn(),
  mockFsReadFile: vi.fn(),
  mockFsRename: vi.fn(),
  mockFsUnlink: vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockNanoid: vi.fn().mockReturnValue("testid12"),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: (...args: any[]) => mockFsMkdir(...args),
    writeFile: (...args: any[]) => mockFsWriteFile(...args),
    readFile: (...args: any[]) => mockFsReadFile(...args),
    rename: (...args: any[]) => mockFsRename(...args),
    unlink: (...args: any[]) => mockFsUnlink(...args),
  },
}));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));
vi.mock("nanoid", () => ({ nanoid: (...args: any[]) => mockNanoid(...args) }));
vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generateShortsVoiceover } from "./shorts-voice-pipeline.js";
import type { ViralClipResult } from "./viral-clip-extractor.js";
import type { TranscriptSegment } from "../ingestion/types.js";

function makeViralClip(overrides: Partial<ViralClipResult> = {}): ViralClipResult {
  return {
    startSeconds: 30,
    endSeconds: 75,
    rationale: "Best segment",
    suggestedHook: "You won't believe this!",
    ...overrides,
  };
}

function makeTranscript(): TranscriptSegment[] {
  return [
    { start: "0:00:10", end: "0:00:20", speech: "Some earlier content" },
    { start: "0:00:35", end: "0:00:45", speech: "This is the viral part" },
    { start: "0:00:50", end: "0:01:00", speech: "More exciting stuff" },
    { start: "0:02:00", end: "0:02:10", speech: "After the clip" },
  ];
}

function makeCopilot(response: string) {
  return {
    chat: vi.fn().mockImplementation(function* () {
      yield response;
    }),
  } as any;
}

function makeVoiceService(contentType = "audio/mp3") {
  return {
    isReady: vi.fn().mockReturnValue(true),
    initialize: vi.fn(),
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from("fake-audio-data"),
      contentType,
    }),
  } as any;
}

describe("generateShortsVoiceover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsRename.mockResolvedValue(undefined);
    mockFsUnlink.mockResolvedValue(undefined);
  });

  it("generates voiceover with mp3 output", async () => {
    const copilot = makeCopilot("This is the script for the short.");
    const voiceService = makeVoiceService("audio/mp3");

    const result = await generateShortsVoiceover(
      makeViralClip(),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts" },
    );

    expect(result.scriptText).toBe("This is the script for the short.");
    expect(result.voiceoverPath).toContain("shorts-vo-");
    expect(result.voiceoverPath).toContain(".mp3");
    expect(result.originalAudioVolume).toBe(0.1);
    expect(mockFsMkdir).toHaveBeenCalledWith("/tmp/shorts", { recursive: true });
    expect(voiceService.synthesize).toHaveBeenCalledWith("This is the script for the short.");
  });

  it("generates wav output and normalizes to PCM s16le", async () => {
    const copilot = makeCopilot("WAV script");
    const voiceService = makeVoiceService("audio/wav");
    mockFsReadFile.mockResolvedValue(Buffer.alloc(100)); // no fact chunk
    mockExecFileAsync.mockResolvedValue({ stdout: "" });

    const result = await generateShortsVoiceover(
      makeViralClip(),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts" },
    );

    expect(result.voiceoverPath).toContain(".wav");
    // Should have called ffmpeg for normalization
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-c:a", "pcm_s16le"]),
    );
    expect(mockFsRename).toHaveBeenCalled();
  });

  it("initializes voice service if not ready", async () => {
    const copilot = makeCopilot("Script");
    const voiceService = makeVoiceService();
    voiceService.isReady.mockReturnValue(false);

    await generateShortsVoiceover(
      makeViralClip(),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts" },
    );

    expect(voiceService.initialize).toHaveBeenCalled();
  });

  it("filters transcript to viral clip window", async () => {
    const copilot = makeCopilot("Script");
    const voiceService = makeVoiceService();

    await generateShortsVoiceover(
      makeViralClip({ startSeconds: 30, endSeconds: 75 }),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts" },
    );

    // The prompt should contain transcript segments in the 30-75s window
    const prompt = copilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("This is the viral part");
    expect(prompt).toContain("More exciting stuff");
    // Should NOT contain segments outside the window
    expect(prompt).not.toContain("After the clip");
  });

  it("handles empty transcript in window", async () => {
    const copilot = makeCopilot("Script");
    const voiceService = makeVoiceService();

    await generateShortsVoiceover(
      makeViralClip({ startSeconds: 100, endSeconds: 110 }),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts" },
    );

    const prompt = copilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("no speech in selected segment");
  });

  it("uses style option in prompt", async () => {
    const copilot = makeCopilot("React script");
    const voiceService = makeVoiceService();

    await generateShortsVoiceover(
      makeViralClip(),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts", style: "react" },
    );

    const prompt = copilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("energetic");
  });

  it("passes model option to copilot.chat", async () => {
    const copilot = makeCopilot("Script");
    const voiceService = makeVoiceService();

    await generateShortsVoiceover(
      makeViralClip(),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts", model: "gpt-4o" },
    );

    const opts = copilot.chat.mock.calls[0][1];
    expect(opts.model).toBe("gpt-4o");
  });

  it("patches malformed WAV fact chunk", async () => {
    const copilot = makeCopilot("Script");
    const voiceService = makeVoiceService("audio/wav");

    // Create a buffer with "fact" at offset 0x24
    const buf = Buffer.alloc(100);
    buf.write("fact", 0x24, "ascii");
    mockFsReadFile.mockResolvedValue(buf);
    mockExecFileAsync.mockResolvedValue({ stdout: "" });

    await generateShortsVoiceover(
      makeViralClip(),
      makeTranscript(),
      120,
      voiceService,
      copilot,
      { outputDir: "/tmp/shorts" },
    );

    // Should write the patched buffer (fact→data)
    // writeFile is called twice: once for audio, once for patched WAV
    const patchedCall = mockFsWriteFile.mock.calls.find(
      (call: any[]) => Buffer.isBuffer(call[1]) && call[1].toString("ascii", 0x24, 0x28) === "data",
    );
    expect(patchedCall).toBeTruthy();
  });

  it("cleans up tmp file on ffmpeg normalization failure", async () => {
    const copilot = makeCopilot("Script");
    const voiceService = makeVoiceService("audio/wav");
    mockFsReadFile.mockResolvedValue(Buffer.alloc(100));
    mockExecFileAsync.mockRejectedValue(new Error("ffmpeg failed"));

    await expect(
      generateShortsVoiceover(
        makeViralClip(),
        makeTranscript(),
        120,
        voiceService,
        copilot,
        { outputDir: "/tmp/shorts" },
      ),
    ).rejects.toThrow("ffmpeg failed");

    expect(mockFsUnlink).toHaveBeenCalled();
  });
});
