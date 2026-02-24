/**
 * Voice Service — Google Cloud TTS + Local Audio Sidecar (MLX)
 * Issue #229: Backend VoiceService with LRU eviction
 * Issue #260/#264: Extended with local audio sidecar support (STT + TTS)
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import type { google } from "@google-cloud/text-to-speech/build/protos/protos.js";
import { logger } from "../logging/logger.js";
import type {
  VoiceServiceConfig,
  SynthesizeResult,
  CacheStats,
  TranscribeResult,
  AudioSidecarHealth,
  LocalVoicePreset,
  F5TTSParams,
} from "./types.js";
import { DEFAULT_VOICE_CONFIG, AVAILABLE_LOCAL_VOICES } from "./types.js";
import { translatePacingTags, hasPacingTags } from "./pacing-translator.js";

const DEFAULT_LOCAL_VOICE = "af_heart";
const LOCAL_VOICE_IDS = new Set(AVAILABLE_LOCAL_VOICES.map((voice) => voice.id));

/**
 * Resolves a path that may contain `~` to an absolute path.
 */
function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

export class VoiceService {
  private readonly config: VoiceServiceConfig;
  private readonly cacheDir: string;
  private client: TextToSpeechClient | null = null;
  private initialized = false;
  private readonly sidecarUrl: string;

  constructor(config?: Partial<VoiceServiceConfig>) {
    this.config = { ...DEFAULT_VOICE_CONFIG, ...config };
    this.cacheDir = resolvePath(this.config.cacheDir);
    this.sidecarUrl = (this.config.sidecarUrl ?? "http://localhost:5006").replace(/\/$/, "");
  }

  /** Initialize the TTS client and cache directory */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create cache directory
    await fs.mkdir(this.cacheDir, { recursive: true });

    if (this.config.provider === "local") {
      // Local provider: verify sidecar is reachable at startup
      try {
        const health = await this.getSidecarHealth();
        this.initialized = true;
        logger.info(
          `Voice service initialized (provider: local, sidecar: ${this.sidecarUrl}, ready: ${health.ready})`
        );
      } catch (error) {
        // Non-fatal: sidecar may start later
        this.initialized = true;
        const details = error instanceof Error ? error.message : String(error);
        logger.warn(`Voice service initialized but sidecar not reachable: ${details}`);
      }
    } else {
      // Google Cloud TTS — relies on GOOGLE_APPLICATION_CREDENTIALS env var
      try {
        this.client = new TextToSpeechClient();
        this.initialized = true;
        logger.info(
          `Voice service initialized (provider: ${this.config.provider}, voice: ${this.config.voiceName})`
        );
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        logger.warn(`Voice service initialization failed: ${details}`);
        throw new Error(`Failed to initialize Google TTS client: ${details}`);
      }
    }
  }

  /** Check if the service is ready to synthesize */
  isReady(): boolean {
    if (this.config.provider === "local") {
      return this.initialized;
    }
    return this.initialized && this.client !== null;
  }

  /** Get the current provider type */
  getProvider(): string {
    return this.config.provider;
  }

  /** Get the sidecar URL (for local provider) */
  getSidecarUrl(): string {
    return this.sidecarUrl;
  }

  /** Get the current config */
  getConfig(): VoiceServiceConfig {
    return { ...this.config };
  }

  /**
   * Synthesize text to audio with caching.
   * Returns the cached version if available, otherwise calls the configured provider.
   * Google provider: returns MP3. Local provider: returns WAV.
   */
  async synthesize(text: string, voiceOverride?: string): Promise<SynthesizeResult> {
    if (!this.initialized) {
      throw new Error("Voice service not initialized.");
    }

    if (this.config.provider === "local") {
      return this.synthesizeLocal(text, voiceOverride);
    }

    return this.synthesizeGoogle(text, voiceOverride);
  }

  /**
   * Synthesize via Google Cloud TTS with caching.
   */
  private async synthesizeGoogle(text: string, voiceOverride?: string): Promise<SynthesizeResult> {
    if (!this.client) {
      throw new Error("Voice service not initialized. Check GOOGLE_APPLICATION_CREDENTIALS.");
    }

    if (!text || text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    if (text.length > this.config.maxTextLength) {
      throw new Error(`Text exceeds maximum length of ${this.config.maxTextLength} characters`);
    }

    const voice = voiceOverride ?? this.config.voiceName;
    const cacheKey = this.computeCacheKey(text, voice);
    const cachePath = path.join(this.cacheDir, `${cacheKey}.mp3`);

    // Check cache
    try {
      const cached = await fs.readFile(cachePath);
      // Touch mtime for LRU tracking
      const now = new Date();
      await fs.utimes(cachePath, now, now).catch(() => {});
      return { audio: cached, cached: true, durationMs: 0 };
    } catch {
      // Cache miss — synthesize
    }

    const startTime = Date.now();

    // Use SSML input when pacing tags are present, plain text otherwise
    const useSsml = hasPacingTags(text);
    const input: google.cloud.texttospeech.v1.ISynthesizeSpeechRequest["input"] = useSsml
      ? { ssml: translatePacingTags(text).ssml }
      : { text };

    const request: google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input,
      voice: {
        languageCode: voice.split("-").slice(0, 2).join("-"), // "en-US-Journey-D" → "en-US"
        name: voice,
      },
      audioConfig: {
        audioEncoding: this.config.audioEncoding,
        speakingRate: this.config.speakingRate,
        pitch: this.config.pitch,
      },
    };

    const [response] = await this.client.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error("Google TTS returned empty audio content");
    }

    const audio = Buffer.from(response.audioContent as Uint8Array);
    const durationMs = Date.now() - startTime;

    // Write to cache (atomic: write to temp, rename)
    const tmpPath = cachePath + `.tmp-${Date.now()}`;
    try {
      await fs.writeFile(tmpPath, audio);
      await fs.rename(tmpPath, cachePath);
    } catch (error) {
      // Non-fatal: cache write failure doesn't break synthesis
      await fs.unlink(tmpPath).catch(() => {});
      const details = error instanceof Error ? error.message : String(error);
      logger.warn(`Voice cache write failed: ${details}`);
    }

    // Run LRU eviction in background (non-blocking)
    void this.evictIfNeeded().catch((err) => {
      const details = err instanceof Error ? err.message : String(err);
      logger.warn(`Voice cache eviction failed: ${details}`);
    });

    logger.info(`Voice synthesis: ${text.length} chars → ${audio.length} bytes in ${durationMs}ms`);

    return { audio, cached: false, durationMs, contentType: "audio/mpeg" };
  }

  /**
   * Synthesize via local audio sidecar (Kokoro TTS on Apple Silicon).
   * Returns WAV audio. Uses file-system caching with LRU eviction.
   */
  private async synthesizeLocal(text: string, voiceOverride?: string): Promise<SynthesizeResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    if (text.length > this.config.maxTextLength) {
      throw new Error(`Text exceeds maximum length of ${this.config.maxTextLength} characters`);
    }

    const requestedVoice = voiceOverride ?? this.config.voiceName;
    const voice = LOCAL_VOICE_IDS.has(requestedVoice) ? requestedVoice : DEFAULT_LOCAL_VOICE;
    if (voice !== requestedVoice) {
      logger.warn(
        `Invalid local voice '${requestedVoice}' for sidecar provider; falling back to '${voice}'.`
      );
    }
    const cacheKey = this.computeCacheKey(text, voice);
    const cachePath = path.join(this.cacheDir, `${cacheKey}.wav`);

    // Check cache
    try {
      const cached = await fs.readFile(cachePath);
      const now = new Date();
      await fs.utimes(cachePath, now, now).catch(() => {});
      return { audio: cached, cached: true, durationMs: 0, contentType: "audio/wav" };
    } catch {
      // Cache miss
    }

    const startTime = Date.now();

    // If pacing tags are present, split into segments and pad with silence
    if (hasPacingTags(text)) {
      const pacing = translatePacingTags(text);
      if (pacing.plainSegments.length > 0) {
        const segmentBuffers: Buffer[] = [];
        for (const segment of pacing.plainSegments) {
          if (!segment.text) {
            // Empty segment (e.g. leading pause) — just add silence
            if (segment.pauseAfterMs > 0) {
              segmentBuffers.push(generateSilenceWav(segment.pauseAfterMs));
            }
            continue;
          }
          // Per-segment speed and voice overrides (fall back to global config)
          const segSpeed = segment.speed ?? this.config.speakingRate;
          const segVoiceRaw = segment.voice ?? voice;
          const segVoice = LOCAL_VOICE_IDS.has(segVoiceRaw) ? segVoiceRaw : voice;

          // Synthesize each segment individually
          const resp = await fetch(`${this.sidecarUrl}/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: segment.text,
              voice: segVoice,
              speed: segSpeed,
            }),
          });
          if (!resp.ok) {
            const errorBody = await resp.text().catch(() => "");
            throw new Error(`Audio sidecar TTS failed (${resp.status}): ${errorBody}`);
          }
          segmentBuffers.push(Buffer.from(await resp.arrayBuffer()));

          // Generate silence padding if needed
          if (segment.pauseAfterMs > 0) {
            segmentBuffers.push(generateSilenceWav(segment.pauseAfterMs));
          }
        }

        // Concatenate all WAV segments (strip headers from subsequent buffers)
        const audio = concatenateWavBuffers(segmentBuffers);
        const durationMs = Date.now() - startTime;

        // Write to cache
        const tmpPath = cachePath + `.tmp-${Date.now()}`;
        try {
          await fs.writeFile(tmpPath, audio);
          await fs.rename(tmpPath, cachePath);
        } catch (error) {
          await fs.unlink(tmpPath).catch(() => {});
          const details = error instanceof Error ? error.message : String(error);
          logger.warn(`Voice cache write failed: ${details}`);
        }

        void this.evictIfNeeded().catch((err) => {
          const details = err instanceof Error ? err.message : String(err);
          logger.warn(`Voice cache eviction failed: ${details}`);
        });

        logger.info(`Local TTS synthesis (paced): ${pacing.plainSegments.length} segments → ${audio.length} bytes in ${durationMs}ms`);
        return { audio, cached: false, durationMs, contentType: "audio/wav" };
      }
    }

    const resp = await fetch(`${this.sidecarUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice,
        speed: this.config.speakingRate,
      }),
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "");
      throw new Error(`Audio sidecar TTS failed (${resp.status}): ${errorBody}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);
    const durationMs = Date.now() - startTime;

    // Write to cache (atomic)
    const tmpPath = cachePath + `.tmp-${Date.now()}`;
    try {
      await fs.writeFile(tmpPath, audio);
      await fs.rename(tmpPath, cachePath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      const details = error instanceof Error ? error.message : String(error);
      logger.warn(`Voice cache write failed: ${details}`);
    }

    void this.evictIfNeeded().catch((err) => {
      const details = err instanceof Error ? err.message : String(err);
      logger.warn(`Voice cache eviction failed: ${details}`);
    });

    logger.info(`Local TTS synthesis: ${text.length} chars → ${audio.length} bytes in ${durationMs}ms`);

    return { audio, cached: false, durationMs, contentType: "audio/wav" };
  }

  /**
   * Synthesize via F5-TTS sidecar (Engine C).
   * Sends multi-clip emotion-tagged text to the /f5tts endpoint.
   * Returns WAV audio.
   */
  async synthesizeF5TTS(
    text: string,
    clips: Array<{ emotion: string; refAudioPath: string; refText: string }>,
    params?: F5TTSParams,
  ): Promise<SynthesizeResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    const startTime = Date.now();

    const payload = {
      text,
      clips: clips.map((c) => ({
        emotion: c.emotion,
        ref_audio_path: c.refAudioPath,
        ref_text: c.refText,
      })),
      steps: params?.steps ?? 8,
      method: params?.method ?? "rk4",
      cfg_strength: params?.cfgStrength ?? 2.0,
      sway_sampling_coef: params?.swayCoef ?? -1.0,
      speed: params?.speed ?? 1.0,
      seed: params?.seed ?? null,
    };

    const resp = await fetch(`${this.sidecarUrl}/f5tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "");
      throw new Error(`F5-TTS synthesis failed (${resp.status}): ${errorBody}`);
    }

    const audio = Buffer.from(await resp.arrayBuffer());
    const durationMs = Date.now() - startTime;

    logger.info(`F5-TTS synthesis: ${text.length} chars → ${audio.length} bytes in ${durationMs}ms`);

    return { audio, cached: false, durationMs, contentType: "audio/wav" };
  }

  /**
   * Transcribe an audio buffer to text via the local audio sidecar (Whisper STT).
   * Only available when provider is "local".
   */
  async transcribe(audioBuffer: Buffer, filename?: string): Promise<TranscribeResult> {
    if (!this.initialized) {
      throw new Error("Voice service not initialized.");
    }
    if (this.config.provider !== "local") {
      throw new Error("Transcription is only available with the local audio sidecar provider.");
    }

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: "audio/wav" });
    formData.append("audio", blob, filename ?? "audio.wav");

    const resp = await fetch(`${this.sidecarUrl}/transcribe`, {
      method: "POST",
      body: formData,
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "");
      throw new Error(`Audio sidecar transcription failed (${resp.status}): ${errorBody}`);
    }

    const data = (await resp.json()) as {
      text: string;
      language: string;
      segments: Array<{ start: number; end: number; text: string }>;
      duration_seconds: number;
    };

    return {
      text: data.text,
      language: data.language,
      segments: data.segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })),
      durationSeconds: data.duration_seconds,
    };
  }

  /**
   * Get the health status of the audio sidecar.
   * Only meaningful for "local" provider.
   */
  async getSidecarHealth(): Promise<AudioSidecarHealth> {
    const resp = await fetch(`${this.sidecarUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      throw new Error(`Sidecar health check failed (${resp.status})`);
    }

    const data = (await resp.json()) as {
      status: string;
      ready: boolean;
      tts_loaded: boolean;
      stt_loaded: boolean;
      tts_loading: boolean;
      stt_loading: boolean;
      tts_model: string;
      stt_model: string;
      voice_count: number;
    };

    return {
      status: data.status,
      ready: data.ready,
      ttsLoaded: data.tts_loaded,
      sttLoaded: data.stt_loaded,
      ttsLoading: data.tts_loading,
      sttLoading: data.stt_loading,
      ttsModel: data.tts_model,
      sttModel: data.stt_model,
      voiceCount: data.voice_count,
    };
  }

  /**
   * Get available voice presets from the audio sidecar.
   * Falls back to the static list if sidecar is unreachable.
   */
  async getLocalVoices(): Promise<LocalVoicePreset[]> {
    try {
      const resp = await fetch(`${this.sidecarUrl}/voices`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        throw new Error(`Sidecar voices endpoint failed (${resp.status})`);
      }

      const data = (await resp.json()) as {
        voices: LocalVoicePreset[];
        default: string;
        model: string;
        sample_rate: number;
      };

      return data.voices;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to fetch local voices from sidecar: ${details}`);
      return [];
    }
  }

  /**
   * Unload models from the audio sidecar to free RAM.
   * @param model Which model to unload: "tts", "stt", or "all".
   */
  async unloadSidecarModels(model: "tts" | "stt" | "all" = "all"): Promise<Record<string, string>> {
    const resp = await fetch(`${this.sidecarUrl}/unload?model=${model}`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      throw new Error(`Sidecar unload failed (${resp.status})`);
    }

    return (await resp.json()) as Record<string, string>;
  }

  /** Get cache statistics */
  async getCacheStats(): Promise<CacheStats> {
    try {
      const entries = await fs.readdir(this.cacheDir);
      const audioFiles = entries.filter((e) => e.endsWith(".mp3") || e.endsWith(".wav"));
      let totalSize = 0;

      for (const file of audioFiles) {
        try {
          const stat = await fs.stat(path.join(this.cacheDir, file));
          totalSize += stat.size;
        } catch {
          // File may have been evicted
        }
      }

      return { files: audioFiles.length, sizeBytes: totalSize };
    } catch {
      return { files: 0, sizeBytes: 0 };
    }
  }

  /** Clear the entire cache */
  async clearCache(): Promise<void> {
    try {
      const entries = await fs.readdir(this.cacheDir);
      const audioFiles = entries.filter((e) => e.endsWith(".mp3") || e.endsWith(".wav"));
      await Promise.all(
        audioFiles.map((f) => fs.unlink(path.join(this.cacheDir, f)).catch(() => {}))
      );
      logger.info(`Voice cache cleared: ${audioFiles.length} files removed`);
    } catch {
      // Directory may not exist
    }
  }

  /** Shutdown the service */
  async shutdown(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.initialized = false;
    logger.info("Voice service shut down");
  }

  /**
   * Compute an MD5 cache key from the synthesis parameters.
   * Ensures the same text + voice + rate + pitch always maps to the same file.
   */
  private computeCacheKey(text: string, voice: string): string {
    const payload = JSON.stringify({
      text,
      voice,
      rate: this.config.speakingRate,
      pitch: this.config.pitch,
    });
    return createHash("md5").update(payload).digest("hex");
  }

  /**
   * LRU eviction: remove oldest files when cache exceeds maxCacheSizeMb.
   */
  private async evictIfNeeded(): Promise<void> {
    const maxBytes = this.config.maxCacheSizeMb * 1024 * 1024;

    const entries = await fs.readdir(this.cacheDir);
    const audioFiles = entries.filter((e) => e.endsWith(".mp3") || e.endsWith(".wav"));

    // Gather file stats
    const fileStats: Array<{ name: string; path: string; size: number; mtime: number }> = [];
    let totalSize = 0;

    for (const file of audioFiles) {
      const filePath = path.join(this.cacheDir, file);
      try {
        const stat = await fs.stat(filePath);
        fileStats.push({ name: file, path: filePath, size: stat.size, mtime: stat.mtimeMs });
        totalSize += stat.size;
      } catch {
        // File may have been removed concurrently
      }
    }

    if (totalSize <= maxBytes) return;

    // Sort by mtime ascending (oldest first)
    fileStats.sort((a, b) => a.mtime - b.mtime);

    let evicted = 0;
    for (const file of fileStats) {
      if (totalSize <= maxBytes) break;
      try {
        await fs.unlink(file.path);
        totalSize -= file.size;
        evicted++;
      } catch {
        // Already removed
      }
    }

    if (evicted > 0) {
      logger.info(`Voice cache LRU eviction: removed ${evicted} files`);
    }
  }
}

// ── WAV utility helpers for pacing segment concatenation ──────

const WAV_HEADER_SIZE = 44;
const WAV_SAMPLE_RATE = 24000; // Kokoro default sample rate
const WAV_BITS_PER_SAMPLE = 16;
const WAV_NUM_CHANNELS = 1;

/**
 * Generate a WAV buffer containing silence of the given duration.
 */
function generateSilenceWav(durationMs: number): Buffer {
  const numSamples = Math.round((WAV_SAMPLE_RATE * durationMs) / 1000);
  const dataSize = numSamples * WAV_NUM_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(WAV_HEADER_SIZE + dataSize);

  // WAV header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(WAV_NUM_CHANNELS, 22);
  buffer.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(WAV_SAMPLE_RATE * WAV_NUM_CHANNELS * (WAV_BITS_PER_SAMPLE / 8), 28);
  buffer.writeUInt16LE(WAV_NUM_CHANNELS * (WAV_BITS_PER_SAMPLE / 8), 32);
  buffer.writeUInt16LE(WAV_BITS_PER_SAMPLE, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // Data region is already zero-filled (silence)

  return buffer;
}

/**
 * Concatenate multiple WAV buffers into a single WAV file.
 * The first buffer's header (sample rate, channels) is used for the output.
 * Subsequent buffers have their headers stripped and raw PCM data appended.
 *
 * Handles non-standard headers (e.g. with metadata chunks between the fmt and
 * data subchunks) by searching for the "data" marker rather than assuming a
 * fixed 44-byte header.
 */
function concatenateWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];

  /** Search for the "data" subchunk and return the offset of the first PCM byte. */
  function findDataOffset(buf: Buffer): number {
    for (let i = 12; i < Math.min(buf.length - 4, 200); i++) {
      if (buf.toString("ascii", i, i + 4) === "data") {
        return i + 8; // skip "data" (4 bytes) + size field (4 bytes)
      }
    }
    return WAV_HEADER_SIZE; // fall back to standard 44-byte offset
  }

  // Extract raw PCM data from each buffer using the detected data offset
  const pcmChunks: Buffer[] = buffers.map((buf) => {
    if (buf.length <= WAV_HEADER_SIZE) return Buffer.alloc(0);
    return buf.subarray(findDataOffset(buf));
  });

  const totalPcmSize = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  // Use the first buffer's detected data offset so the output header is correct
  // even when the first buffer has non-standard extra subchunks before "data".
  const firstDataOffset = findDataOffset(buffers[0]);
  const output = Buffer.alloc(firstDataOffset + totalPcmSize);

  // Copy header from first buffer (up to and including the "data" subchunk label)
  buffers[0].copy(output, 0, 0, firstDataOffset);

  // Update RIFF chunk size (always at byte 4):  total file size minus the 8-byte RIFF descriptor
  output.writeUInt32LE(firstDataOffset - 8 + totalPcmSize, 4);

  // Update data chunk size at the field immediately before the PCM region
  output.writeUInt32LE(totalPcmSize, firstDataOffset - 4);

  // Append PCM data
  let offset = firstDataOffset;
  for (const chunk of pcmChunks) {
    chunk.copy(output, offset);
    offset += chunk.length;
  }

  return output;
}
