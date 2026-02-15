/**
 * Voice Interface — Type definitions
 * Part of Epic #228: Voice Interface Layer
 */

export interface VoiceServiceConfig {
  /** Enable/disable voice features globally */
  enabled: boolean;
  /** TTS provider (currently only "google") */
  provider: "google";
  /** Google TTS voice name (e.g., "en-US-Journey-D") */
  voiceName: string;
  /** Audio encoding format */
  audioEncoding: "MP3" | "LINEAR16" | "OGG_OPUS";
  /** Speaking rate (0.25 to 4.0, default: 1.0) */
  speakingRate: number;
  /** Pitch adjustment (-20.0 to 20.0, default: 0.0) */
  pitch: number;
  /** Cache directory path */
  cacheDir: string;
  /** Max cache size in MB (default: 500) */
  maxCacheSizeMb: number;
  /** Max text length per request (default: 5000) */
  maxTextLength: number;
}

export interface SynthesizeResult {
  /** Raw MP3 audio buffer */
  audio: Buffer;
  /** Whether the result came from cache */
  cached: boolean;
  /** Duration of the synthesis in milliseconds */
  durationMs: number;
}

export interface CacheStats {
  /** Number of cached files */
  files: number;
  /** Total cache size in bytes */
  sizeBytes: number;
}

export const DEFAULT_VOICE_CONFIG: VoiceServiceConfig = {
  enabled: true,
  provider: "google",
  voiceName: "en-US-Journey-D",
  audioEncoding: "MP3",
  speakingRate: 1.0,
  pitch: 0.0,
  cacheDir: "~/.openzigs/voice-cache",
  maxCacheSizeMb: 500,
  maxTextLength: 5000,
};

/** Available voice options for user selection */
export const AVAILABLE_VOICES = [
  { id: "en-US-Journey-D", type: "Journey", description: "Male, conversational, natural" },
  { id: "en-US-Journey-F", type: "Journey", description: "Female, conversational, natural" },
  { id: "en-US-Neural2-A", type: "Neural2", description: "Male, standard" },
  { id: "en-US-Neural2-C", type: "Neural2", description: "Female, standard" },
  { id: "en-US-Neural2-J", type: "Neural2", description: "Male, deeper voice" },
] as const;
