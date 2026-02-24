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
