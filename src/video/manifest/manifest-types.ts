/**
 * Director Mode — JSON Manifest Data Contract
 * Issue #240: The strict data contract between the Single-Shot LLM
 * output and the Remotion rendering engine.
 */

// ── Template IDs ──────────────────────────────────────────────
export type TemplateId = "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo";

// ── Composition ───────────────────────────────────────────────
export interface CompositionConfig {
  width: number;
  height: number;
  fps: number;
}

// ── Audio Layer ───────────────────────────────────────────────
export interface MusicConfig {
  /** Path to the music file (local or downloaded) */
  track: string;
  /** Volume level 0.0 – 1.0 */
  volume: number;
  /** Whether to duck volume during voiceover segments */
  ducking: boolean;
  /** Fade in duration in frames */
  fadeInFrames?: number;
  /** Fade out duration in frames */
  fadeOutFrames?: number;
  /** Loop music if shorter than video (default: true) */
  loop?: boolean;
}

export interface VoiceoverConfig {
  /** Path to the voiceover audio file */
  source: string;
  /** Volume level 0.0 – 1.0 (default: 1.0) */
  volume?: number;
  /** Delay before voiceover starts, in frames */
  startAtFrame?: number;
}

export interface AudioLayerConfig {
  music?: MusicConfig | null;
  voiceover?: VoiceoverConfig | null;
}

// ── Video Effects ─────────────────────────────────────────────
export type VideoEffect =
  | { type: "slowZoom"; from: number; to: number }
  | { type: "fadeIn"; durationFrames: number }
  | { type: "fadeOut"; durationFrames: number }
  | { type: "blur"; amount: number; startFrame: number; endFrame: number }
  | { type: "grayscale" }
  | { type: "speedRamp"; factor: number; startFrame: number; endFrame: number };

// ── Timeline Entries ──────────────────────────────────────────
export interface VideoClipEntry {
  type: "video_clip";
  /** Path to the source video file */
  source: string;
  /** Frame number where this clip starts in the composition */
  startAtFrame: number;
  /** Frame offset into the source clip to begin playback */
  trimStart: number;
  /** Duration of this clip in frames */
  duration: number;
  /** Playback volume of original audio 0.0 – 1.0 (0 = muted) */
  volume?: number;
  /** Visual effects applied to this clip */
  effects?: VideoEffect[];
}

export interface OverlayEntry {
  type: "overlay";
  /** Which shared component to render */
  component: "SmartCaptions" | "LowerThird" | "LogoWatermark" | "ProgressBar";
  /** Props passed to the component */
  props: Record<string, unknown>;
  /** Frame number where this overlay starts */
  startAtFrame: number;
  /** Duration in frames (optional — defaults to end of composition) */
  duration?: number;
}

export interface TitleCardEntry {
  type: "title_card";
  /** Title text */
  title: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Background colour or image path */
  background?: string;
  /** Frame number where title card starts */
  startAtFrame: number;
  /** Duration in frames */
  duration: number;
  /** Animation style */
  animation?: "fade" | "slide-up" | "typewriter";
}

export interface TransitionEntry {
  type: "transition";
  /** Transition style */
  style: "crossfade" | "wipe-left" | "wipe-right" | "dissolve" | "cut";
  /** Duration of transition in frames */
  duration: number;
  /** Frame number where transition starts (overlaps adjacent clips) */
  startAtFrame: number;
}

export type TimelineEntry = VideoClipEntry | OverlayEntry | TitleCardEntry | TransitionEntry;

// ── Branding ──────────────────────────────────────────────────
export interface BrandingConfig {
  logoUrl?: string;
  accentColor?: string;
  fontFamily?: string;
  watermarkOpacity?: number;
  watermarkPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

// ── Metadata ──────────────────────────────────────────────────
export interface ManifestMetadata {
  generatedAt: string;
  llmModel: string;
  llmTokensUsed: number;
  productionMode: "highlight" | "script" | "presentation";
  sourceClips: string[];
  estimatedRenderTime?: number;
}

// ── Top-Level Manifest ────────────────────────────────────────
export interface DirectorManifest {
  /** Human-readable project name */
  projectTitle: string;
  /** Which template to render with — must match a registered TemplateId */
  templateId: TemplateId;
  /** Output composition settings */
  composition: CompositionConfig;
  /** Audio mixing layer */
  audioLayer: AudioLayerConfig;
  /** Ordered timeline of visual + overlay entries */
  timeline: TimelineEntry[];
  /** Optional branding overrides */
  branding?: BrandingConfig;
  /** Metadata for the rendered file */
  metadata?: ManifestMetadata;
}

// ── Validation Result ─────────────────────────────────────────
export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
