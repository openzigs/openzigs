/**
 * Voice Interface — Type definitions
 * Part of Epic #228: Voice Interface Layer
 * Extended in Epic #260: Multimodal Audio / Local TTS+STT sidecar
 */

/** Supported TTS providers */
export type VoiceProvider = "google" | "local";

export interface VoiceServiceConfig {
  /** Enable/disable voice features globally */
  enabled: boolean;
  /** TTS provider: "google" (Cloud TTS) or "local" (audio sidecar) */
  provider: VoiceProvider;
  /** Google TTS voice name OR local sidecar voice preset ID */
  voiceName: string;
  /** Audio encoding format (Google only) */
  audioEncoding: "MP3" | "LINEAR16" | "OGG_OPUS";
  /** Speaking rate (0.25 to 4.0 for Google; 0.5 to 2.0 for local) */
  speakingRate: number;
  /** Pitch adjustment (-20.0 to 20.0, Google only, default: 0.0) */
  pitch: number;
  /** Cache directory path */
  cacheDir: string;
  /** Max cache size in MB (default: 500) */
  maxCacheSizeMb: number;
  /** Max text length per request (default: 5000 for Google, 10000 for local) */
  maxTextLength: number;
  /** Audio sidecar URL for local provider (default: http://localhost:5006) */
  sidecarUrl?: string;
}

export interface VoiceOption {
  id: string;
  type: "Standard" | "Neural2" | "Journey" | "Kokoro";
  description: string;
  pricingTier: "free-tier-preferred" | "paid-tier" | "local";
}

export interface SynthesizeResult {
  /** Raw audio buffer (MP3 for Google, WAV for local) */
  audio: Buffer;
  /** Whether the result came from cache */
  cached: boolean;
  /** Duration of the synthesis in milliseconds */
  durationMs: number;
  /** Audio MIME type */
  contentType?: string;
}

export interface TranscribeResult {
  /** Transcribed text */
  text: string;
  /** Detected language code */
  language: string;
  /** Segment-level timestamps */
  segments: TranscriptSegment[];
  /** Total audio duration in seconds */
  durationSeconds: number;
}

export interface TranscriptSegment {
  /** Segment start time in seconds */
  start: number;
  /** Segment end time in seconds */
  end: number;
  /** Segment text */
  text: string;
}

export interface CacheStats {
  /** Number of cached files */
  files: number;
  /** Total cache size in bytes */
  sizeBytes: number;
}

/** Audio sidecar health status */
export interface AudioSidecarHealth {
  status: string;
  ready: boolean;
  ttsLoaded: boolean;
  sttLoaded: boolean;
  ttsLoading: boolean;
  sttLoading: boolean;
  ttsModel: string;
  sttModel: string;
  voiceCount: number;
}

/** Local voice preset (from audio sidecar) */
export interface LocalVoicePreset {
  id: string;
  language: string;
  gender: string;
  style: string;
}

export const DEFAULT_VOICE_CONFIG: VoiceServiceConfig = {
  enabled: true,
  provider: "google",
  voiceName: "en-US-Standard-C",
  audioEncoding: "MP3",
  speakingRate: 1.0,
  pitch: 0.0,
  cacheDir: "~/.openzigs/voice-cache",
  maxCacheSizeMb: 500,
  maxTextLength: 5000,
  sidecarUrl: "http://localhost:5006",
};

/** Default config for local (sidecar) voice provider */
export const DEFAULT_LOCAL_VOICE_CONFIG: Partial<VoiceServiceConfig> = {
  provider: "local",
  voiceName: "af_heart",
  maxTextLength: 10000,
  sidecarUrl: "http://localhost:5006",
};

/** Available voice options for user selection (Google Cloud TTS) */
export const AVAILABLE_VOICES: VoiceOption[] = [
  { id: "en-US-Standard-A", type: "Standard", description: "Male, generic American", pricingTier: "free-tier-preferred" },
  { id: "en-US-Standard-B", type: "Standard", description: "Male, slightly deeper", pricingTier: "free-tier-preferred" },
  { id: "en-US-Standard-C", type: "Standard", description: "Female, clear assistant style", pricingTier: "free-tier-preferred" },
  { id: "en-US-Standard-D", type: "Standard", description: "Male, news anchor style", pricingTier: "free-tier-preferred" },
  { id: "en-US-Standard-E", type: "Standard", description: "Female, slightly higher pitch", pricingTier: "free-tier-preferred" },
  { id: "en-US-Neural2-A", type: "Neural2", description: "Male, natural", pricingTier: "paid-tier" },
  { id: "en-US-Neural2-C", type: "Neural2", description: "Female, natural", pricingTier: "paid-tier" },
  { id: "en-US-Neural2-J", type: "Neural2", description: "Male, deeper voice", pricingTier: "paid-tier" },
  { id: "en-US-Journey-D", type: "Journey", description: "Male, conversational", pricingTier: "paid-tier" },
  { id: "en-US-Journey-F", type: "Journey", description: "Female, conversational", pricingTier: "paid-tier" },
];

/** Available local voice presets (Kokoro via audio sidecar) */
export const AVAILABLE_LOCAL_VOICES: VoiceOption[] = [
  // American English — Female
  { id: "af_heart", type: "Kokoro", description: "Warm, expressive (American Female)", pricingTier: "local" },
  { id: "af_bella", type: "Kokoro", description: "Calm, collected (American Female)", pricingTier: "local" },
  { id: "af_nova", type: "Kokoro", description: "Bright, energetic (American Female)", pricingTier: "local" },
  { id: "af_sarah", type: "Kokoro", description: "Soft, gentle (American Female)", pricingTier: "local" },
  { id: "af_sky", type: "Kokoro", description: "Clear, airy (American Female)", pricingTier: "local" },
  // American English — Male
  { id: "am_adam", type: "Kokoro", description: "Deep, authoritative (American Male)", pricingTier: "local" },
  { id: "am_echo", type: "Kokoro", description: "Smooth, resonant (American Male)", pricingTier: "local" },
  { id: "am_liam", type: "Kokoro", description: "Casual, friendly (American Male)", pricingTier: "local" },
  { id: "am_michael", type: "Kokoro", description: "Professional, clear (American Male)", pricingTier: "local" },
  // British English — Female
  { id: "bf_alice", type: "Kokoro", description: "Refined, posh (British Female)", pricingTier: "local" },
  { id: "bf_emma", type: "Kokoro", description: "Natural, warm (British Female)", pricingTier: "local" },
  { id: "bf_lily", type: "Kokoro", description: "Light, expressive (British Female)", pricingTier: "local" },
  // British English — Male
  { id: "bm_daniel", type: "Kokoro", description: "Deep, broadcast (British Male)", pricingTier: "local" },
  { id: "bm_george", type: "Kokoro", description: "Classic, distinguished (British Male)", pricingTier: "local" },
  { id: "bm_lewis", type: "Kokoro", description: "Modern, conversational (British Male)", pricingTier: "local" },
  // Japanese
  { id: "jf_alpha", type: "Kokoro", description: "Clear, natural (Japanese Female)", pricingTier: "local" },
  { id: "jm_kumo", type: "Kokoro", description: "Calm, measured (Japanese Male)", pricingTier: "local" },
  // Chinese
  { id: "zf_xiaobei", type: "Kokoro", description: "Bright, friendly (Chinese Female)", pricingTier: "local" },
  { id: "zm_yunxi", type: "Kokoro", description: "Smooth, professional (Chinese Male)", pricingTier: "local" },
];
