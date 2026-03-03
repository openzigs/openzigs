/**
 * Director Mode — Shared types for the wizard UI.
 */

export type ProductionMode = "highlight" | "script" | "presentation" | "shorts";

export type ImageProvider = "auto" | "local" | "cloud";
export type ImageModel = "sdxl-turbo" | "flux-schnell" | "flux";

export interface VisualAsset {
  name: string;
  /** Server-side path after upload */
  path: string;
  description: string;
  type: "image" | "video";
  size: number;
  /** Object URL for thumbnail preview (browser-only, ephemeral) */
  previewUrl?: string;
  /** AI-suggested placement, set after calling /assets/placement */
  placement?: {
    startTimeSec: number;
    endTimeSec: number;
    position: string;
    scale: number;
  } | null;
}

export interface WizardState {
  /** Step 1 */
  mode: ProductionMode | null;
  /** Step 2 */
  clips: MediaFile[];
  scriptFile: MediaFile | null;
  topic: string;
  /** Step 2 — presentation mode source documents (.txt / .md) */
  sourceFiles: MediaFile[];
  /** Step 3 */
  templateId: string | null;
  /** Step 4 */
  musicTrack: SelectedAsset | null;
  /** Step 5 — overlay images / video clips */
  visualAssets: VisualAsset[];
  /** Step 6 — model override (empty = use director default or system default) */
  model: string;
  /** Step 6 — image generation provider (auto | local | cloud) */
  imageProvider: ImageProvider;
  /** Step 6 — local sidecar model for image generation */
  imageModel: ImageModel;
  /** Step 6 — generate PowerPoint-style slides with text rendered into images (cloud only) */
  slideStyle: boolean;
  /** Step 6 — use uploaded visual assets for all middle scenes; only AI-generate intro + outro images */
  assetsOnlyMode: boolean;
  /** Step 6 — enable pop quizzes in Presenter Mode (SI-1 #276) */
  quizEnabled: boolean;
  /** Step 6 — render quality/codec settings */
  renderSettings: RenderSettings;
  /** Step 6 — brand voice to apply (null = use active default) */
  brandVoiceId: string | null;
  /** Step 6 (populated after production) */
  manifest: DirectorManifestSummary | null;
  renderJobId: string | null;
}

export interface MediaFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

export interface SelectedAsset {
  id: string;
  name: string;
  source: "local" | "pixabay" | "jamendo" | "pexels" | "upload" | "gallery";
  type: "music" | "sfx" | "image" | "video";
  filePath?: string;
  duration?: number;
  previewUrl?: string;
  thumbnailUrl?: string;
  license: string;
  attribution?: string;
}

export type RenderQuality = "draft" | "standard" | "high" | "lossless";

export interface RenderSettings {
  quality: RenderQuality;
  codec: string;
  crf: number;
}

export const QUALITY_PRESETS: Record<RenderQuality, { crf: number; label: string; description: string }> = {
  draft: { crf: 32, label: "Draft", description: "Fast preview, lower quality" },
  standard: { crf: 23, label: "Standard", description: "Balanced quality & size" },
  high: { crf: 18, label: "High", description: "High quality, larger files" },
  lossless: { crf: 0, label: "Lossless", description: "Maximum quality, very large files" },
};

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  aspectRatio: string;
  defaultComposition: { width: number; height: number; fps: number };
  defaultTransition: string;
  defaultTransitionDuration: number;
  captionsEnabled: boolean;
  defaultCaptionStyle?: string;
  tags: string[];
  titleCardBackground: string;
  fontFamily: string;
}

export interface DirectorManifestSummary {
  projectTitle: string;
  templateId: string;
  timelineEntries: number;
  totalDuration: number;
  tokensUsed: number;
}

export interface RenderJobStatus {
  id: string;
  status: "queued" | "bundling" | "rendering" | "encoding" | "finalizing" | "complete" | "failed" | "aborted";
  progress: number;
  projectTitle: string;
  templateId: string;
  outputPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  durationSec: number | null;
  fileSizeBytes: number | null;
}

export const WIZARD_STEPS = [
  { id: 1, label: "Mode", description: "Choose production mode" },
  { id: 2, label: "Media", description: "Add source media" },
  { id: 3, label: "Template", description: "Pick a visual style" },
  { id: 4, label: "Music", description: "Select background music" },
  { id: 5, label: "Visual Assets", description: "Add overlay images & clips" },
  { id: 6, label: "Produce", description: "Review & render" },
] as const;

export function createInitialState(): WizardState {
  return {
    mode: null,
    clips: [],
    scriptFile: null,
    topic: "",
    sourceFiles: [],
    templateId: null,
    musicTrack: null,
    visualAssets: [],
    model: "",
    imageProvider: "auto",
    imageModel: "flux-schnell",
    slideStyle: false,
    assetsOnlyMode: false,
    quizEnabled: false,
    renderSettings: { quality: "standard", codec: "h264", crf: 23 },
    brandVoiceId: null,
    manifest: null,
    renderJobId: null,
  };
}

// ── Studio Types ──────────────────────────────────────────────

export interface DraftSummary {
  id: string;
  title: string;
  thumbnail: string | null;
  productionMode: string;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export interface DraftFull extends DraftSummary {
  manifest: DirectorManifest | null;
}

/** Minimal typed subset of the DirectorManifest used by Studio UI. */
export interface DirectorManifest {
  projectTitle: string;
  templateId: string;
  composition: { width: number; height: number; fps: number };
  audioLayer: {
    music: { track: string; volume: number; loop: boolean } | null;
    voiceover: { src?: string; source?: string; volume: number; startAtFrame?: number } | null;
  };
  timeline?: TimelineEntry[];
  metadata?: Record<string, unknown>;
}

export type TimelineEntryType =
  | "video_clip"
  | "title_card"
  | "image_scene"
  | "transition"
  | "overlay"
  | "intro_card"
  | "outro_card";

export interface TimelineEntry {
  type: TimelineEntryType;
  startAtFrame?: number;
  duration?: number;
  durationInFrames?: number;
  src?: string;
  /** video_clip entries use `source` instead of `src` */
  source?: string;
  title?: string;
  voiceover?: string;
  scriptText?: string;
  [key: string]: unknown;
}

export interface TimelineTrack {
  id: string;
  label: string;
  type: "scenes" | "audio" | "voiceover" | "overlay";
  entries: TimelineTrackEntry[];
}

export interface TimelineTrackEntry {
  /** Index in the manifest timeline array */
  timelineIndex: number;
  startFrame: number;
  durationFrames: number;
  label: string;
  color: string;
}

export interface InspectorState {
  /** Index in the visual scenes array (not manifest timeline) */
  sceneIndex: number | null;
  /** The timeline entry being inspected */
  entry: TimelineEntry | null;
}

export interface StudioState {
  draftId: string;
  draft: DraftFull | null;
  currentFrame: number;
  isPlaying: boolean;
  inspector: InspectorState;
  tracks: TimelineTrack[];
}
