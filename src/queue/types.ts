/**
 * Media Queue — Type Definitions
 * Issue #326: Type contracts for the push-based distributed media queue.
 */

// ── Job Types ─────────────────────────────────────────────────

export type MediaJobType =
  | "txt2img"
  | "img2img"
  | "txt2video"
  | "img2video"
  | "tts"
  | "txt2music"
  | "voice2voice"
  | "remix_analyze"
  | "remix_replace"
  | "remix_master";

export type MediaJobStatus =
  | "pending"
  | "dispatched"
  | "processing"
  | "complete"
  | "failed";

export type TargetNode = "mac-mini" | "m2-pro" | "local";

/** Valid LTX video pipeline types. */
export const VALID_PIPELINE_TYPES = [
  "distilled",
  "dev",
  "dev-two-stage",
  "dev-two-stage-hq",
] as const;
export type PipelineType = (typeof VALID_PIPELINE_TYPES)[number];

/** Valid VAE tiling modes for video decoding. */
export const VALID_TILING_MODES = [
  "auto",
  "none",
  "default",
  "aggressive",
  "conservative",
] as const;
export type TilingMode = (typeof VALID_TILING_MODES)[number];

/** Known LTX model catalog entries with memory and disk requirements. */
export const LTX_MODEL_CATALOG = [
  {
    id: "ltx-2-distilled-q4",
    repo: "AITRADER/ltx2-distilled-4bit-mlx",
    name: "LTX-2 Distilled Q4",
    memoryGB: 19,
    downloadGB: 19,
    version: "2.0",
    audio: true,
  },
  {
    id: "ltx-2.3-distilled-q4",
    repo: "dgrauet/ltx-2.3-mlx-distilled-q4",
    name: "LTX-2.3 Distilled Q4",
    memoryGB: 20,
    downloadGB: 41,
    version: "2.3",
    audio: true,
    warning:
      "Large download (~41 GB). Ensure sufficient disk space before selecting.",
  },
] as const;

/** Audio/music job types that have dedicated dispatch handlers and must NOT be dispatched via the video worker. */
export const AUDIO_JOB_TYPES: ReadonlySet<MediaJobType> = new Set<MediaJobType>(
  [
    "txt2music",
    "voice2voice",
    "remix_analyze",
    "remix_replace",
    "remix_master",
  ],
);

/** Determine which worker node handles a given job type. */
export function targetNodeForJobType(type: MediaJobType): TargetNode {
  switch (type) {
    case "txt2img":
    case "img2img":
      return "mac-mini";
    case "txt2video":
    case "img2video":
    case "tts":
    case "txt2music":
      return "m2-pro";
    case "voice2voice":
    case "remix_analyze":
    case "remix_replace":
    case "remix_master":
      return "local";
  }
}

/** Determine which model a job type requires by default. */
export function defaultModelForJobType(type: MediaJobType): string {
  switch (type) {
    case "txt2img":
      return "flux-schnell";
    case "img2img":
      return "flux-kontext";
    case "txt2video":
    case "img2video":
      return "ltx-2";
    case "tts":
      return "f5-tts";
    case "txt2music":
      return "ace-step";
    case "voice2voice":
      return "seed-vc";
    case "remix_analyze":
      return "htdemucs_6s";
    case "remix_replace":
      return "basic-pitch";
    case "remix_master":
      return "matchering";
  }
}

// ── Job Payload ───────────────────────────────────────────────

export interface MediaJobPayload {
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance_scale?: number;
  seed?: number;
  /** Base64-encoded source image for img2img / img2video */
  init_image?: string;
  /** Strength for img2img (0–1) */
  strength?: number;
  /** Number of frames for video generation */
  num_frames?: number;
  /** Frames per second for video */
  fps?: number;
  /** TTS voice name */
  voice?: string;
  /** Model override */
  model?: string;
  /** Pipeline type: "distilled" (fast) or "dev" (photorealistic, CFG-guided) */
  pipeline?: string;
  /** Negative prompt for quality control */
  negative_prompt?: string;
  /** CFG guidance scale for DEV pipeline (default 4.5) */
  cfg_scale?: number;
  /** Number of denoising steps for DEV pipeline (default 20) */
  num_inference_steps?: number;
  /** Duration in seconds for music generation (ACE-Step) */
  duration_seconds?: number;
  /** Lyrics text for vocal music generation */
  lyrics?: string;
  /** Whether to generate instrumental-only (no vocals) */
  instrumental?: boolean;
  /** LoRA adapter paths for character consistency (mac-mini only) */
  lora_paths?: string[];
  /** Scale factor for each LoRA adapter */
  lora_scales?: number[];
  /** Gallery asset ID of the source audio for voice2voice */
  source_asset_id?: string;
  /** Voice reference ID for Seed-VC zero-shot voice conversion */
  voice_reference_id?: string;
  /** Seed-VC diffusion steps (default 25, use 30-50 for singing) */
  diffusion_steps?: number;
  /** Whether to condition on f0 pitch (true for singing, false for speech) */
  f0_condition?: boolean;
  /** Voice model name (legacy RVC compat) */
  voice_model?: string;
  /** Semitone pitch shift (default 0) */
  pitch_shift?: number;
  /** Feature index rate 0–1 (default 0.75, legacy RVC) */
  index_rate?: number;
  /** Median filter radius (default 3, legacy RVC) */
  filter_radius?: number;
  /** Final vocal volume multiplier (default 1.0) */
  vocal_volume?: number;
  /** Final instrumental volume multiplier (default 1.0) */
  instrumental_volume?: number;
  /** Output audio format (default "wav") */
  output_format?: string;

  // ── Remix Lab fields ───────────────────────────────────────
  /** Path to an isolated stem WAV for instrument replacement */
  source_stem_url?: string;
  /** Target instrument ID (e.g. "80s_analog_synth") */
  target_instrument_id?: string;
  /** Detected BPM of source track */
  original_bpm?: number;
  /** Detected key of source track (e.g. "C major") */
  original_key?: string;
  /** Mapping: stem_name → WAV file path for mix & master */
  stem_paths?: Record<string, string>;
  /** Mapping: stem_name → volume (0.0–2.0) */
  volumes?: Record<string, number>;
  /** Mapping: stem_name → muted boolean */
  muted?: Record<string, boolean>;
  /** Vibe preset for smart mix: punchy_pop, warm_lofi, cinematic_wide, raw */
  vibe?: string;
  /** Skip auto-mastering; just mix stems and save to gallery */
  skip_mastering?: boolean;
  /** Device to use for analysis (cpu / mps / cuda) */
  device?: string;

  // ── LTX Video Engine v2 fields ─────────────────────────────
  /** Enable synchronized audio generation (LTX-2.3+) */
  audio?: boolean;
  /** VAE tiling mode: auto, none, default, aggressive, conservative */
  tiling?: string;
  /** Override model repository for video generation */
  model_repo?: string;
  /** Enable Gemma-based prompt enhancement before generation */
  enhance_prompt?: boolean;
  /** Image conditioning strength for img2video (0.0–1.0, default 1.0) */
  image_strength?: number;
  /** URL for the sidecar to POST real-time progress updates */
  progress_url?: string;

  // ── Multi-Segment Video fields ─────────────────────────────
  /** Total requested video duration in seconds (4, 8, 12, 16). Triggers multi-segment decomposition when > 4. */
  video_duration?: number;
  /** 0-based index of this segment within a multi-segment job. */
  segmentIndex?: number;
  /** Total number of segments in the parent multi-segment job. */
  totalSegments?: number;
  /** Parent job ID that spawned this segment sub-job. */
  parentJobId?: string;
}

// ── Stored Job ────────────────────────────────────────────────

export interface StoredMediaJob {
  id: string;
  type: MediaJobType;
  required_model: string;
  target_node: TargetNode;
  payload: string;
  status: MediaJobStatus;
  result_url: string | null;
  result_metadata: string | null;
  project_id: string | null;
  gallery_asset_id: string | null;
  priority: number;
  retries: number;
  max_retries: number;
  error: string | null;
  retry_after: string | null;
  created_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  notify_via_telegram: number; // 0 or 1 (SQLite boolean)
  telegram_chat_id: string | null;
}

/** Domain-level media job (parsed from stored row). */
export interface MediaJob {
  id: string;
  type: MediaJobType;
  requiredModel: string;
  targetNode: TargetNode;
  payload: MediaJobPayload;
  status: MediaJobStatus;
  resultUrl: string | null;
  resultMetadata: Record<string, unknown> | null;
  projectId: string | null;
  galleryAssetId: string | null;
  priority: number;
  retries: number;
  maxRetries: number;
  error: string | null;
  retryAfter: Date | null;
  createdAt: Date;
  dispatchedAt: Date | null;
  completedAt: Date | null;
  notifyViaTelegram: boolean;
  telegramChatId: string | null;
}

// ── Create Job Input ──────────────────────────────────────────

export interface CreateMediaJobInput {
  type: MediaJobType;
  payload: MediaJobPayload;
  model?: string;
  projectId?: string;
  priority?: number;
  notifyViaTelegram?: boolean;
  telegramChatId?: string;
}

// ── Worker Status ─────────────────────────────────────────────

export interface WorkerStatus {
  is_busy: boolean;
  loaded_model: string | null;
}

// ── Webhook Completion ────────────────────────────────────────

export interface JobCompletionPayload {
  job_id: string;
  status: "complete" | "failed";
  media_base64?: string;
  media_type?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

// ── Node Configuration ────────────────────────────────────────

export interface WorkerNodeConfig {
  url: string;
  token?: string;
}

export interface QueueConfig {
  pollIntervalMs: number;
  macMini: WorkerNodeConfig;
  m2Pro: WorkerNodeConfig;
  callbackUrl: string;
  /** Filesystem path where completed media assets are written. */
  galleryDir?: string;
  /**
   * How long (ms) a job can sit in 'dispatched' state before the watchdog
   * resets it to 'pending' for retry. Default: 45 minutes.
   */
  dispatchTimeoutMs?: number;
  /** Music Studio voice2voice sidecar node config. */
  musicStudio?: WorkerNodeConfig;
}

// ── Constants ─────────────────────────────────────────────────

/** Maximum video frames (4 seconds at 24fps). */
export const MAX_VIDEO_FRAMES = 97;

/** Maximum video duration in seconds. */
export const MAX_VIDEO_DURATION_SEC = 4;

/** Default video FPS. */
export const DEFAULT_VIDEO_FPS = 24;

/** Valid total video durations for multi-segment generation (seconds). */
export const VALID_VIDEO_DURATIONS = [4, 8, 12, 16] as const;
export type VideoDuration = (typeof VALID_VIDEO_DURATIONS)[number];

/** Segment duration constant — each segment is 4 seconds. */
export const SEGMENT_DURATION_SEC = 4;

/**
 * Decompose a requested video duration into segment count.
 * @returns number of 4s segments needed (1 for ≤4s, 2 for 8s, etc.)
 */
export function computeSegmentCount(durationSec: number): number {
  if (durationSec <= SEGMENT_DURATION_SEC) return 1;
  return Math.ceil(durationSec / SEGMENT_DURATION_SEC);
}

/**
 * Calculate aggregate multi-segment progress as a weighted average.
 * @param totalSegments total segments in the job
 * @param completedSegments count of fully completed segments
 * @param currentSegmentProgress progress (0-100) of the currently active segment
 * @returns aggregate progress 0-100
 */
export function computeAggregateProgress(
  totalSegments: number,
  completedSegments: number,
  currentSegmentProgress: number,
): number {
  if (totalSegments <= 0) return 0;
  const completed = Math.min(completedSegments, totalSegments);
  const current = Math.max(0, Math.min(100, currentSegmentProgress));
  return Math.round(((completed * 100 + current) / totalSegments) * 100) / 100;
}
