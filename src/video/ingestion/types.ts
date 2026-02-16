/**
 * Director Mode — Ingestion Types
 * Issue #237: Type definitions for the media ingestion pipeline.
 */

export interface IngestionInput {
  /** File paths to input video/audio clips */
  clips: string[];
  /** Production mode */
  mode: "highlight" | "script";
  /** Path to script.txt (Mode B / script-driven only) */
  script?: string;
}

export interface IngestionResult {
  clips: ClipAnalysis[];
  contextPayload: ContextPayload;
  totalDuration: number;     // seconds
  workingDir: string;        // Temp dir with extracted assets
}

export interface ClipAnalysis {
  sourcePath: string;
  duration: number;          // seconds
  resolution: { width: number; height: number };
  fps: number;
  audioPath: string | null;  // Extracted audio WAV (null if no audio track)
  keyframes: KeyframeInfo[];
  transcript: TranscriptSegment[];
}

export interface KeyframeInfo {
  timestamp: number;         // seconds
  framePath: string;         // path to extracted JPEG
  sceneScore: number;        // 0-1 scene change confidence
  description?: string;      // Optional LLM-generated description
}

export interface TranscriptSegment {
  start: string;             // "00:00:14.310"
  end: string;               // "00:00:16.480"
  speech: string;
  clipIndex: number;         // Which input clip this belongs to
}

// ── Context Payload (assembled for LLM) ───────────────────────

export interface ContextPayload {
  clips: ClipContext[];
  totalDuration: number;
  resolution: { width: number; height: number };
}

export interface ClipContext {
  index: number;
  source: string;
  duration: number;
  timeline: TimelineContextEntry[];
}

export type TimelineContextEntry =
  | { type: "visual"; timestamp: number; description: string; framePath: string }
  | { type: "audio"; start: string; end: string; speech: string };
