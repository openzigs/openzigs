/**
 * Director Mode — Render Worker (Remotion SSR)
 * Issue #249: Renders video from a DirectorManifest using Remotion's SSR API.
 *
 * Runs in a Worker Thread spawned by RenderOrchestrator.
 * Pipeline: manifest → adapter → bundle() → selectComposition() → renderMedia() → MP4.
 *
 * Replaces the previous FFmpeg-based pipeline with Remotion's React component
 * rendering engine, enabling smooth transitions, animated title cards, smart
 * captions, lower thirds, logo watermarks, and Ken Burns effects.
 */

import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import type { WorkerMessage } from "./render-types.js";
import type { DirectorManifest } from "./manifest/manifest-types.js";

if (!parentPort) {
  throw new Error("render-worker.ts must be run inside a Worker Thread");
}

const port = parentPort;

// ── Cached bundle URL (expensive to create, reuse across renders) ────
let cachedServeUrl: string | null = null;

// ── Progress Reporter ─────────────────────────────────────────
function emitProgress(jobId: string, pct: number, framesRendered: number, totalFrames: number): void {
  port.postMessage({
    type: "progress",
    jobId,
    progress: Math.min(pct, 1),
    framesRendered,
    totalFrames,
  } satisfies WorkerMessage);
}

// ── Helpers ───────────────────────────────────────────────────
function calcTotalFrames(manifest: DirectorManifest): number {
  let max = 0;
  for (const entry of manifest.timeline) {
    const end = entry.startAtFrame + ("duration" in entry ? (entry.duration ?? 0) : 0);
    if (end > max) max = end;
  }
  return max || 1;
}

// ── Main Render Pipeline (Remotion SSR) ───────────────────────
async function renderManifest(
  jobId: string,
  manifest: DirectorManifest,
  outputDir: string,
  entryPoint?: string,
): Promise<{ outputPath: string; durationSec: number; fileSizeBytes: number }> {
  const totalFrames = calcTotalFrames(manifest);
  const { fps } = manifest.composition;
  const safeTitle = manifest.projectTitle.replace(/[^a-zA-Z0-9_-]/g, "_");
  const outputPath = path.join(outputDir, `${safeTitle}.mp4`);

  await fs.promises.mkdir(outputDir, { recursive: true });

  // ── Phase 1: Bundle the Remotion project (0–20%) ────────
  emitProgress(jobId, 0.02, 0, totalFrames);

  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  // Resolve the entry point for the Remotion bundle
  const remotionEntry = entryPoint ?? path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "..",
    "remotion",
    "index.tsx",
  );

  if (!cachedServeUrl) {
    emitProgress(jobId, 0.05, 0, totalFrames);
    cachedServeUrl = await bundle({
      entryPoint: remotionEntry,
      onProgress: (progress: number) => {
        const pct = 0.05 + progress * 0.15;
        emitProgress(jobId, pct, 0, totalFrames);
      },
    });
  }

  emitProgress(jobId, 0.20, 0, totalFrames);

  // ── Phase 2: Adapt manifest to input props (20–25%) ─────
  const { adaptManifest } = await import("../remotion/adapter.js");
  const inputProps = adaptManifest(manifest, outputDir);

  emitProgress(jobId, 0.25, Math.round(0.25 * totalFrames), totalFrames);

  // ── Phase 3: Select composition (25–30%) ────────────────
  const composition = await selectComposition({
    serveUrl: cachedServeUrl,
    id: manifest.templateId,
    inputProps,
  });

  emitProgress(jobId, 0.30, Math.round(0.30 * totalFrames), totalFrames);

  // ── Phase 4: Render the video (30–95%) ──────────────────
  await renderMedia({
    composition,
    serveUrl: cachedServeUrl,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    imageFormat: "jpeg",
    onProgress: ({ progress }) => {
      const pct = 0.30 + progress * 0.65;
      const frames = Math.round(progress * totalFrames);
      emitProgress(jobId, pct, frames, totalFrames);
    },
  });

  // ── Phase 5: Finalize (95–100%) ─────────────────────────
  emitProgress(jobId, 0.98, totalFrames, totalFrames);

  const stat = await fs.promises.stat(outputPath);
  const durationSec = totalFrames / fps;

  emitProgress(jobId, 1.0, totalFrames, totalFrames);

  return { outputPath, durationSec, fileSizeBytes: stat.size };
}

// ── Worker Message Loop ───────────────────────────────────────
port.on("message", async (msg: WorkerMessage) => {
  if (msg.type === "start") {
    try {
      const result = await renderManifest(
        msg.jobId,
        msg.manifest,
        msg.outputDir,
        msg.entryPoint,
      );
      port.postMessage({
        type: "complete",
        jobId: msg.jobId,
        outputPath: result.outputPath,
        durationSec: result.durationSec,
        fileSizeBytes: result.fileSizeBytes,
      } satisfies WorkerMessage);
    } catch (error) {
      port.postMessage({
        type: "error",
        jobId: msg.jobId,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerMessage);
    }
  }
});
