/**
 * Voice Service — Google Cloud TTS with file system caching
 * Issue #229: Backend VoiceService with LRU eviction
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import type { google } from "@google-cloud/text-to-speech/build/protos/protos.js";
import { logger } from "../logging/logger.js";
import type { VoiceServiceConfig, SynthesizeResult, CacheStats } from "./types.js";
import { DEFAULT_VOICE_CONFIG } from "./types.js";

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

  constructor(config?: Partial<VoiceServiceConfig>) {
    this.config = { ...DEFAULT_VOICE_CONFIG, ...config };
    this.cacheDir = resolvePath(this.config.cacheDir);
  }

  /** Initialize the TTS client and cache directory */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create cache directory
    await fs.mkdir(this.cacheDir, { recursive: true });

    // Create TTS client — relies on GOOGLE_APPLICATION_CREDENTIALS env var
    // or Application Default Credentials
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

  /** Check if the service is ready to synthesize */
  isReady(): boolean {
    return this.initialized && this.client !== null;
  }

  /** Get the current config */
  getConfig(): VoiceServiceConfig {
    return { ...this.config };
  }

  /**
   * Synthesize text to MP3 audio with caching.
   * Returns the cached version if available, otherwise calls Google TTS API.
   */
  async synthesize(text: string, voiceOverride?: string): Promise<SynthesizeResult> {
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

    const request: google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input: { text },
      voice: {
        languageCode: voice.split("-").slice(0, 2).join("-"), // "en-US-Journey-D" → "en-US"
        name: voice,
      },
      audioConfig: {
        audioEncoding: this.config.audioEncoding as unknown as number,
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

    return { audio, cached: false, durationMs };
  }

  /** Get cache statistics */
  async getCacheStats(): Promise<CacheStats> {
    try {
      const entries = await fs.readdir(this.cacheDir);
      const mp3Files = entries.filter((e) => e.endsWith(".mp3"));
      let totalSize = 0;

      for (const file of mp3Files) {
        try {
          const stat = await fs.stat(path.join(this.cacheDir, file));
          totalSize += stat.size;
        } catch {
          // File may have been evicted
        }
      }

      return { files: mp3Files.length, sizeBytes: totalSize };
    } catch {
      return { files: 0, sizeBytes: 0 };
    }
  }

  /** Clear the entire cache */
  async clearCache(): Promise<void> {
    try {
      const entries = await fs.readdir(this.cacheDir);
      const mp3Files = entries.filter((e) => e.endsWith(".mp3"));
      await Promise.all(
        mp3Files.map((f) => fs.unlink(path.join(this.cacheDir, f)).catch(() => {}))
      );
      logger.info(`Voice cache cleared: ${mp3Files.length} files removed`);
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
    const mp3Files = entries.filter((e) => e.endsWith(".mp3"));

    // Gather file stats
    const fileStats: Array<{ name: string; path: string; size: number; mtime: number }> = [];
    let totalSize = 0;

    for (const file of mp3Files) {
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
