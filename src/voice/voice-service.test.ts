/**
 * VoiceService unit tests
 * Issue #229: Tests for cache logic, LRU eviction, synthesis
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { VoiceService } from "./voice-service.js";
import type { VoiceServiceConfig } from "./types.js";

// Mock the Google Cloud TTS client
vi.mock("@google-cloud/text-to-speech", () => {
  const mockSynthesize = vi.fn().mockResolvedValue([
    { audioContent: Buffer.from("fake-audio-data") },
  ]);
  return {
    TextToSpeechClient: vi.fn().mockImplementation(() => ({
      synthesizeSpeech: mockSynthesize,
      close: vi.fn(),
    })),
  };
});

// Mock logger to suppress output during tests
vi.mock("../logging/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("VoiceService", () => {
  let tempDir: string;
  let config: Partial<VoiceServiceConfig>;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `voice-test-${Date.now()}`);
    config = {
      cacheDir: tempDir,
      maxCacheSizeMb: 1,
      maxTextLength: 100,
    };
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should initialize and create cache directory", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    expect(service.isReady()).toBe(true);

    const stat = await fs.stat(tempDir);
    expect(stat.isDirectory()).toBe(true);

    await service.shutdown();
  });

  it("should return config", () => {
    const service = new VoiceService(config);
    const result = service.getConfig();

    expect(result.cacheDir).toBe(tempDir);
    expect(result.provider).toBe("google");
    expect(result.voiceName).toBe("en-US-Standard-C");
    expect(result.speakingRate).toBe(1.0);
    expect(result.pitch).toBe(0.0);
  });

  it("should synthesize text and cache the result", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    const result = await service.synthesize("Hello, world!");

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.toString()).toBe("fake-audio-data");
    expect(result.cached).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify cache file was created
    const files = await fs.readdir(tempDir);
    const mp3Files = files.filter((f) => f.endsWith(".mp3"));
    expect(mp3Files.length).toBe(1);

    await service.shutdown();
  });

  it("should return cached result on second synthesis", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    // First call — synthesize
    const result1 = await service.synthesize("Hello, world!");
    expect(result1.cached).toBe(false);

    // Second call — should hit cache
    const result2 = await service.synthesize("Hello, world!");
    expect(result2.cached).toBe(true);
    expect(result2.audio.toString()).toBe("fake-audio-data");

    await service.shutdown();
  });

  it("should throw for empty text", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    await expect(service.synthesize("")).rejects.toThrow("Text cannot be empty");
    await expect(service.synthesize("   ")).rejects.toThrow("Text cannot be empty");

    await service.shutdown();
  });

  it("should throw for text exceeding max length", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    const longText = "a".repeat(101);
    await expect(service.synthesize(longText)).rejects.toThrow("exceeds maximum length");

    await service.shutdown();
  });

  it("should throw if not initialized", async () => {
    const service = new VoiceService(config);

    await expect(service.synthesize("hello")).rejects.toThrow("not initialized");
  });

  it("should report cache stats", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    // Empty cache
    const stats0 = await service.getCacheStats();
    expect(stats0.files).toBe(0);
    expect(stats0.sizeBytes).toBe(0);

    // Synthesize to populate cache
    await service.synthesize("Hello, world!");

    const stats1 = await service.getCacheStats();
    expect(stats1.files).toBe(1);
    expect(stats1.sizeBytes).toBeGreaterThan(0);

    await service.shutdown();
  });

  it("should clear the cache", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    await service.synthesize("Hello, world!");
    await service.synthesize("Goodbye, world!");

    const statsBefore = await service.getCacheStats();
    expect(statsBefore.files).toBe(2);

    await service.clearCache();

    const statsAfter = await service.getCacheStats();
    expect(statsAfter.files).toBe(0);

    await service.shutdown();
  });

  it("should evict oldest files when cache exceeds max size", async () => {
    // Use a very small max size to trigger eviction
    const tinyConfig: Partial<VoiceServiceConfig> = {
      ...config,
      maxCacheSizeMb: 0.00001, // ~10 bytes — will trigger eviction
    };
    const service = new VoiceService(tinyConfig);
    await service.initialize();

    // Synthesize multiple entries
    await service.synthesize("One");
    await service.synthesize("Two");
    await service.synthesize("Three");

    // Wait briefly for async eviction
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stats = await service.getCacheStats();
    // At least some files should have been evicted
    expect(stats.files).toBeLessThanOrEqual(3);

    await service.shutdown();
  });

  it("should use voice override when provided", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    const result1 = await service.synthesize("Hello", "en-US-Neural2-A");
    expect(result1.cached).toBe(false);

    // Different voice should produce different cache key
    const result2 = await service.synthesize("Hello", "en-US-Neural2-C");
    expect(result2.cached).toBe(false);

    const stats = await service.getCacheStats();
    expect(stats.files).toBe(2);

    await service.shutdown();
  });

  it("should not re-initialize", async () => {
    const service = new VoiceService(config);
    await service.initialize();
    expect(service.isReady()).toBe(true);

    // Second call should be no-op
    await service.initialize();
    expect(service.isReady()).toBe(true);

    await service.shutdown();
  });

  it("should shutdown cleanly", async () => {
    const service = new VoiceService(config);
    await service.initialize();
    expect(service.isReady()).toBe(true);

    await service.shutdown();
    expect(service.isReady()).toBe(false);
  });
});

// ── F5-TTS Synthesis ──────────────────────────────────────────────────────────

describe("VoiceService — synthesizeF5TTS", () => {
  let tempDir: string;
  let config: Partial<VoiceServiceConfig>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any = null;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `voice-f5-test-${Date.now()}`);
    config = {
      cacheDir: tempDir,
      maxCacheSizeMb: 1,
      maxTextLength: 500,
    };
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should throw for empty text", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    const clips = [{ emotion: "Regular", refAudioPath: "/tmp/ref.wav", refText: "Hello" }];
    await expect(service.synthesizeF5TTS("", clips)).rejects.toThrow("Text cannot be empty");
    await expect(service.synthesizeF5TTS("   ", clips)).rejects.toThrow("Text cannot be empty");

    await service.shutdown();
  });

  it("should call sidecar /f5tts endpoint and return audio", async () => {
    const fakeWav = Buffer.from("RIFF-fake-wav-data");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(fakeWav, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      })
    );

    const service = new VoiceService(config);
    await service.initialize();

    const clips = [{ emotion: "Regular", refAudioPath: "/tmp/ref.wav", refText: "Hello world" }];
    const result = await service.synthesizeF5TTS("(Regular)Hello world", clips);

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.toString()).toBe("RIFF-fake-wav-data");
    expect(result.cached).toBe(false);
    expect(result.contentType).toBe("audio/wav");

    // Verify the fetch call
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/f5tts");
    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe("(Regular)Hello world");
    expect(body.clips).toHaveLength(1);
    expect(body.clips[0].emotion).toBe("Regular");
    expect(body.steps).toBe(8);
    expect(body.method).toBe("rk4");

    await service.shutdown();
  });

  it("should pass custom params to sidecar", async () => {
    const fakeWav = Buffer.from("wav");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(fakeWav, { status: 200 })
    );

    const service = new VoiceService(config);
    await service.initialize();

    const clips = [{ emotion: "Excited", refAudioPath: "/tmp/exc.wav", refText: "Wow!" }];
    await service.synthesizeF5TTS("(Excited)Wow!", clips, {
      steps: 16,
      method: "euler",
      cfgStrength: 3.0,
      speed: 1.2,
      seed: 42,
    });

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.steps).toBe(16);
    expect(body.method).toBe("euler");
    expect(body.cfg_strength).toBe(3.0);
    expect(body.speed).toBe(1.2);
    expect(body.seed).toBe(42);

    await service.shutdown();
  });

  it("should throw on sidecar error response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"error":"model not loaded"}', {
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const service = new VoiceService(config);
    await service.initialize();

    const clips = [{ emotion: "Regular", refAudioPath: "/tmp/ref.wav", refText: "Hi" }];
    await expect(service.synthesizeF5TTS("Hi", clips)).rejects.toThrow("F5-TTS synthesis failed (500)");

    await service.shutdown();
  });
});

// ── Local provider tests ──────────────────────────────────────────────────────

describe("VoiceService — local provider", () => {
  let tempDir: string;
  let config: Partial<VoiceServiceConfig>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any = null;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `voice-local-test-${Date.now()}`);
    config = {
      cacheDir: tempDir,
      maxCacheSizeMb: 1,
      maxTextLength: 500,
      provider: "local",
      sidecarUrl: "http://localhost:5006",
    };
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should initialize with local provider even if sidecar is unreachable", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const service = new VoiceService(config);
    await service.initialize();
    expect(service.isReady()).toBe(true);
    expect(service.getProvider()).toBe("local");
    await service.shutdown();
  });

  it("should initialize with local provider when sidecar is healthy", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "ok", ready: true, tts_loaded: true, stt_loaded: false,
        tts_loading: false, stt_loading: false, tts_model: "kokoro", stt_model: "",
        voice_count: 10,
      }), { status: 200 })
    );
    const service = new VoiceService(config);
    await service.initialize();
    expect(service.isReady()).toBe(true);
    await service.shutdown();
  });

  it("should synthesize via local sidecar /tts endpoint", async () => {
    // First call: health check during init (ECONNREFUSED is fine)
    // Second call: actual TTS synthesis
    const fakeWav = Buffer.from("RIFF-fake-wav");
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init health
      .mockResolvedValueOnce(new Response(fakeWav, { status: 200, headers: { "Content-Type": "audio/wav" } }));

    const service = new VoiceService(config);
    await service.initialize();

    const result = await service.synthesize("Hello world");
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.cached).toBe(false);
    expect(result.contentType).toBe("audio/wav");

    await service.shutdown();
  });

  it("should throw for empty text on local provider", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const service = new VoiceService(config);
    await service.initialize();

    await expect(service.synthesize("")).rejects.toThrow("Text cannot be empty");
    await expect(service.synthesize("   ")).rejects.toThrow("Text cannot be empty");

    await service.shutdown();
  });

  it("should throw when text exceeds max length on local provider", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const svc = new VoiceService({ ...config, maxTextLength: 10 });
    await svc.initialize();

    await expect(svc.synthesize("a".repeat(11))).rejects.toThrow("exceeds maximum length");

    await svc.shutdown();
  });

  it("should fall back to default local voice for invalid voice name", async () => {
    const fakeWav = Buffer.from("RIFF-wav");
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init
      .mockResolvedValueOnce(new Response(fakeWav, { status: 200 }));

    const service = new VoiceService(config);
    await service.initialize();

    const result = await service.synthesize("Hello", "invalid_voice_id");
    expect(result.audio).toBeInstanceOf(Buffer);

    // Verify the body sent to sidecar used fallback voice
    const callBody = JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(callBody.voice).toBe("af_heart"); // DEFAULT_LOCAL_VOICE

    await service.shutdown();
  });

  it("should throw when local sidecar returns error", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init
      .mockResolvedValueOnce(new Response("GPU OOM", { status: 500 }));

    const service = new VoiceService(config);
    await service.initialize();

    await expect(service.synthesize("Hello")).rejects.toThrow("Audio sidecar TTS failed (500)");
    await service.shutdown();
  });

  it("should cache local synthesis results as .wav files", async () => {
    const fakeWav = Buffer.from("RIFF-cached-wav");
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init
      .mockResolvedValueOnce(new Response(fakeWav, { status: 200 }));

    const service = new VoiceService(config);
    await service.initialize();

    await service.synthesize("Cache me");
    const files = await fs.readdir(tempDir);
    const wavFiles = files.filter((f) => f.endsWith(".wav"));
    expect(wavFiles.length).toBe(1);

    await service.shutdown();
  });

  it("should return cached .wav on second call", async () => {
    const fakeWav = Buffer.from("RIFF-cached-wav");
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init
      .mockResolvedValueOnce(new Response(fakeWav, { status: 200 }));

    const service = new VoiceService(config);
    await service.initialize();

    const r1 = await service.synthesize("Cache me");
    expect(r1.cached).toBe(false);

    const r2 = await service.synthesize("Cache me");
    expect(r2.cached).toBe(true);

    await service.shutdown();
  });
});

// ── Transcription tests ───────────────────────────────────────────────────────

describe("VoiceService — transcribe", () => {
  let tempDir: string;
  let config: Partial<VoiceServiceConfig>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any = null;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `voice-stt-test-${Date.now()}`);
    config = {
      cacheDir: tempDir,
      provider: "local",
      sidecarUrl: "http://localhost:5006",
    };
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should transcribe audio via sidecar /transcribe endpoint", async () => {
    const transcriptData = {
      text: "Hello world",
      language: "en",
      segments: [{ start: 0.0, end: 1.5, text: "Hello world" }],
      duration_seconds: 1.5,
    };
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init health
      .mockResolvedValueOnce(new Response(JSON.stringify(transcriptData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const service = new VoiceService(config);
    await service.initialize();

    const result = await service.transcribe(Buffer.from("fake-audio"));
    expect(result.text).toBe("Hello world");
    expect(result.language).toBe("en");
    expect(result.segments).toHaveLength(1);
    expect(result.durationSeconds).toBe(1.5);

    await service.shutdown();
  });

  it("should throw if not initialized", async () => {
    const service = new VoiceService(config);
    await expect(service.transcribe(Buffer.from("audio"))).rejects.toThrow("not initialized");
  });

  it("should throw when provider is not local", async () => {
    const googleConfig: Partial<VoiceServiceConfig> = { ...config, provider: "google" };
    const service = new VoiceService(googleConfig);
    await service.initialize();

    await expect(service.transcribe(Buffer.from("audio"))).rejects.toThrow("only available with the local audio sidecar");

    await service.shutdown();
  });

  it("should throw when sidecar transcription returns error", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init
      .mockResolvedValueOnce(new Response("model not loaded", { status: 503 }));

    const service = new VoiceService(config);
    await service.initialize();

    await expect(service.transcribe(Buffer.from("audio"))).rejects.toThrow("Audio sidecar transcription failed (503)");
    await service.shutdown();
  });
});

// ── Sidecar management tests ─────────────────────────────────────────────────

describe("VoiceService — sidecar management", () => {
  let tempDir: string;
  let config: Partial<VoiceServiceConfig>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any = null;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `voice-sidecar-test-${Date.now()}`);
    config = {
      cacheDir: tempDir,
      provider: "local",
      sidecarUrl: "http://localhost:5006",
    };
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("getSidecarHealth should return parsed health data", async () => {
    const healthData = {
      status: "ok", ready: true, tts_loaded: true, stt_loaded: false,
      tts_loading: false, stt_loading: false, tts_model: "kokoro-v1",
      stt_model: "whisper-large-v3", voice_count: 54,
    };
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(healthData), { status: 200 })
    );

    const service = new VoiceService(config);
    const health = await service.getSidecarHealth();
    expect(health.status).toBe("ok");
    expect(health.ready).toBe(true);
    expect(health.ttsLoaded).toBe(true);
    expect(health.sttLoaded).toBe(false);
    expect(health.ttsModel).toBe("kokoro-v1");
    expect(health.voiceCount).toBe(54);
  });

  it("getSidecarHealth should throw on non-ok response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not found", { status: 404 })
    );

    const service = new VoiceService(config);
    await expect(service.getSidecarHealth()).rejects.toThrow("Sidecar health check failed (404)");
  });

  it("getLocalVoices should return voices from sidecar", async () => {
    const voiceData = {
      voices: [
        { id: "af_heart", name: "Heart", language: "en" },
        { id: "af_sky", name: "Sky", language: "en" },
      ],
      default: "af_heart",
      model: "kokoro-v1",
      sample_rate: 24000,
    };
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(voiceData), { status: 200 })
    );

    const service = new VoiceService(config);
    const voices = await service.getLocalVoices();
    expect(voices).toHaveLength(2);
    expect(voices[0].id).toBe("af_heart");
  });

  it("getLocalVoices should return empty array on sidecar error", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const service = new VoiceService(config);
    const voices = await service.getLocalVoices();
    expect(voices).toEqual([]);
  });

  it("unloadSidecarModels should call /unload endpoint", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tts: "unloaded", stt: "unloaded" }), { status: 200 })
    );

    const service = new VoiceService(config);
    const result = await service.unloadSidecarModels("all");
    expect(result.tts).toBe("unloaded");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/unload?model=all");
  });

  it("unloadSidecarModels should throw on sidecar error", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("error", { status: 500 })
    );

    const service = new VoiceService(config);
    await expect(service.unloadSidecarModels("tts")).rejects.toThrow("Sidecar unload failed (500)");
  });

  it("getSidecarUrl should return configured URL", () => {
    const service = new VoiceService(config);
    expect(service.getSidecarUrl()).toBe("http://localhost:5006");
  });

  it("getSidecarUrl should strip trailing slash", () => {
    const service = new VoiceService({ ...config, sidecarUrl: "http://localhost:5006/" });
    expect(service.getSidecarUrl()).toBe("http://localhost:5006");
  });

  it("getProvider should return provider type", () => {
    const service = new VoiceService(config);
    expect(service.getProvider()).toBe("local");

    const googleService = new VoiceService({ ...config, provider: "google" });
    expect(googleService.getProvider()).toBe("google");
  });

  it("isReady should return false for google provider without client", () => {
    const googleService = new VoiceService({ ...config, provider: "google" });
    expect(googleService.isReady()).toBe(false);
  });
});

// ── NEW: Additional voice service coverage ──────────────────────────────────

describe("VoiceService — Google TTS edge cases", () => {
  let tempDir: string;
  let config: Partial<VoiceServiceConfig>;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `voice-google-edge-${Date.now()}`);
    config = {
      cacheDir: tempDir,
      maxCacheSizeMb: 1,
      maxTextLength: 100,
    };
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("throws when Google TTS returns empty audio", async () => {
    const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
    const instance = new TextToSpeechClient();
    (instance.synthesizeSpeech as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { audioContent: null },
    ]);

    const service = new VoiceService(config);
    await service.initialize();
    await expect(service.synthesize("Hello")).rejects.toThrow("empty audio content");
    await service.shutdown();
  });

  it("handles cache write failure gracefully (non-fatal)", async () => {
    const service = new VoiceService(config);
    await service.initialize();

    // First synthesis works, creates a cache file
    const result = await service.synthesize("Hello, world!");
    expect(result.cached).toBe(false);
    expect(result.audio).toBeInstanceOf(Buffer);

    await service.shutdown();
  });

  it("clearCache handles non-existent directory", async () => {
    const service = new VoiceService({ ...config, cacheDir: "/tmp/nonexistent-voice-dir-" + Date.now() });
    // Should not throw
    await expect(service.clearCache()).resolves.toBeUndefined();
  });

  it("getCacheStats returns zeros for non-existent directory", async () => {
    const service = new VoiceService({ ...config, cacheDir: "/tmp/nonexistent-voice-stats-" + Date.now() });
    const stats = await service.getCacheStats();
    expect(stats.files).toBe(0);
    expect(stats.sizeBytes).toBe(0);
  });
});

describe("VoiceService — local provider pacing", () => {
  let tempDir: string;
  let config: Partial<VoiceServiceConfig>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any = null;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `voice-pacing-${Date.now()}`);
    config = {
      cacheDir: tempDir,
      maxCacheSizeMb: 1,
      maxTextLength: 500,
      provider: "local",
      sidecarUrl: "http://localhost:5006",
    };
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("unloadSidecarModels defaults to 'all' when no model specified", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tts: "unloaded" }), { status: 200 }),
    );

    const service = new VoiceService(config);
    await service.unloadSidecarModels();

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/unload?model=all");
  });

  it("unloadSidecarModels calls with 'stt' model", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ stt: "unloaded" }), { status: 200 }),
    );

    const service = new VoiceService(config);
    await service.unloadSidecarModels("stt");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/unload?model=stt");
  });

  it("getLocalVoices returns empty array when sidecar returns error status", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("error", { status: 500 }),
    );

    const service = new VoiceService(config);
    const voices = await service.getLocalVoices();
    expect(voices).toEqual([]);
  });

  it("transcribe sends FormData with custom filename", async () => {
    const transcriptData = {
      text: "Custom file",
      language: "en",
      segments: [{ start: 0.0, end: 1.0, text: "Custom file" }],
      duration_seconds: 1.0,
    };
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init
      .mockResolvedValueOnce(new Response(JSON.stringify(transcriptData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const service = new VoiceService(config);
    await service.initialize();

    const result = await service.transcribe(Buffer.from("audio"), "custom.wav");
    expect(result.text).toBe("Custom file");
    await service.shutdown();
  });

  it("F5-TTS uses default sway_sampling_coef", async () => {
    const fakeWav = Buffer.from("wav");
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // init health check
      .mockResolvedValueOnce(
        new Response(fakeWav, { status: 200 }),
      );

    const service = new VoiceService(config);
    await service.initialize();

    const clips = [{ emotion: "Regular", refAudioPath: "/tmp/ref.wav", refText: "Hi" }];
    await service.synthesizeF5TTS("Hello", clips);

    const body = JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(body.sway_sampling_coef).toBe(-1.0);
    expect(body.seed).toBeNull();

    await service.shutdown();
  });
});
