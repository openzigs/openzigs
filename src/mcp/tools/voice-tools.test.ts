import { describe, it, expect, vi, beforeEach } from "vitest";
import { createVoiceTools } from "./voice-tools.js";
import type { VoiceService } from "../../voice/voice-service.js";

function createMockVoiceService(overrides: Partial<VoiceService> = {}): VoiceService {
  return {
    isReady: vi.fn().mockReturnValue(true),
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from("fake audio"),
      cached: false,
      durationMs: 2500,
      contentType: "audio/wav",
    }),
    getSidecarHealth: vi.fn().mockResolvedValue({ engine: "kokoro", status: "ready" }),
    ...overrides,
  } as unknown as VoiceService;
}

function getHandler(overrides: Partial<VoiceService> = {}) {
  const service = createMockVoiceService(overrides);
  const tools = createVoiceTools({ voiceService: service });
  return { handler: tools[0].handler, service };
}

describe("voice-tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates tool with correct metadata", () => {
    const tools = createVoiceTools({ voiceService: createMockVoiceService() });
    expect(tools[0].name).toBe("synthesize-speech");
    expect(tools[0].riskLevel).toBe("low");
  });

  it("synthesize returns audio info", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "synthesize", text: "Hello world" });
    expect(service.synthesize).toHaveBeenCalledWith("Hello world", undefined);
    const parsed = JSON.parse(result.text);
    expect(parsed.success).toBe(true);
    expect(parsed.duration_ms).toBe(2500);
  });

  it("synthesize requires text", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "synthesize" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("text");
  });

  it("synthesize returns error when sidecar not ready", async () => {
    const { handler } = getHandler({ isReady: vi.fn().mockReturnValue(false) });
    const result = await handler({ action: "synthesize", text: "Hello" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not ready");
  });

  it("synthesize passes voice parameter", async () => {
    const { handler, service } = getHandler();
    await handler({ action: "synthesize", text: "Test", voice: "af_heart" });
    expect(service.synthesize).toHaveBeenCalledWith("Test", "af_heart");
  });

  it("list_voices returns instruction", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "list_voices" });
    expect(result.text).toContain("/voices");
  });

  it("health returns sidecar health", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "health" });
    const parsed = JSON.parse(result.text);
    expect(parsed.engine).toBe("kokoro");
  });

  it("switch_engine requires engine", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "switch_engine" });
    expect(result.isError).toBe(true);
  });

  it("switch_engine returns confirmation", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "switch_engine", engine: "kokoro" });
    expect(result.text).toContain("kokoro");
  });

  it("handles errors gracefully", async () => {
    const { handler } = getHandler({
      synthesize: vi.fn().mockRejectedValue(new Error("sidecar down")),
    });
    const result = await handler({ action: "synthesize", text: "Hello" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("sidecar down");
  });
});
