/**
 * Director Mode — Shared types for the wizard UI.
 */

export type ProductionMode = "highlight" | "script";

export interface WizardState {
  /** Step 1 */
  mode: ProductionMode | null;
  /** Step 2 */
  clips: MediaFile[];
  scriptFile: MediaFile | null;
  /** Step 3 */
  templateId: string | null;
  /** Step 4 */
  musicTrack: SelectedAsset | null;
  /** Step 5 — model override (empty = use director default or system default) */
  model: string;
  /** Step 5 (populated after production) */
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
  source: "local" | "pixabay" | "freesound";
  type: "music" | "sfx";
  filePath?: string;
  duration?: number;
  previewUrl?: string;
  license: string;
  attribution?: string;
}

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
  status: "queued" | "bundling" | "rendering" | "encoding" | "complete" | "failed" | "aborted";
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
  { id: 2, label: "Media", description: "Add video clips" },
  { id: 3, label: "Template", description: "Pick a visual style" },
  { id: 4, label: "Music", description: "Select background music" },
  { id: 5, label: "Produce", description: "Review & render" },
] as const;

export function createInitialState(): WizardState {
  return {
    mode: null,
    clips: [],
    scriptFile: null,
    templateId: null,
    musicTrack: null,
    model: "",
    manifest: null,
    renderJobId: null,
  };
}
