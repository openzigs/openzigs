/**
 * Director Mode — Render Types
 * Issue #235: Type definitions for the rendering pipeline.
 */

import type { DirectorManifest } from "./manifest/manifest-types.js";

export type RenderStatus = "queued" | "bundling" | "rendering" | "encoding" | "complete" | "failed" | "aborted";

export interface RenderJob {
  id: string;
  manifest: DirectorManifest;
  status: RenderStatus;
  progress: number;        // 0.0 – 1.0
  outputPath: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Duration of the final rendered video in seconds (set on completion). */
  durationSec: number | null;
  /** File size of the rendered output in bytes (set on completion). */
  fileSizeBytes: number | null;
}

export interface RenderProgress {
  jobId: string;
  status: RenderStatus;
  progress: number;
  framesRendered?: number;
  totalFrames?: number;
  estimatedTimeRemaining?: number;
}

export interface RenderRequest {
  manifest: DirectorManifest;
  /** Override the output directory (default: ~/.openzigs/renders/{jobId}/) */
  outputDir?: string;
}

export interface RenderResult {
  jobId: string;
  success: boolean;
  outputPath: string | null;
  error: string | null;
  durationSec: number | null;
  fileSizeBytes: number | null;
}

/** Messages sent between the main thread and the render worker. */
export type WorkerMessage =
  | { type: "start"; jobId: string; manifest: DirectorManifest; outputDir: string; entryPoint: string }
  | { type: "progress"; jobId: string; progress: number; framesRendered: number; totalFrames: number }
  | { type: "complete"; jobId: string; outputPath: string; durationSec: number; fileSizeBytes: number }
  | { type: "error"; jobId: string; error: string }
  | { type: "abort"; jobId: string };
