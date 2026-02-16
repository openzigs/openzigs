/**
 * Director Mode — Render Worker (FFmpeg-based)
 * Issue #235: Renders video from a DirectorManifest using ffmpeg + sharp.
 *
 * Runs in a Worker Thread spawned by RenderOrchestrator.
 * Pipeline: timeline entries → individual MP4 segments → concat → audio mix → final output.
 *
 * Title cards are rendered via SVG → sharp → PNG → ffmpeg (image→video).
 * Video clips are trimmed/scaled/normalized via ffmpeg.
 * Segments are concatenated via ffmpeg's concat demuxer.
 * Background music + voiceover mixed via ffmpeg's amix filter.
 */

import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerMessage } from "./render-types.js";
import type { DirectorManifest, TitleCardEntry, VideoClipEntry } from "./manifest/manifest-types.js";

if (!parentPort) {
  throw new Error("render-worker.ts must be run inside a Worker Thread");
}

const port = parentPort;
const execFileAsync = promisify(execFile);

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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── FFmpeg / FFprobe ──────────────────────────────────────────
async function ffmpeg(args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000, // 5 min per segment
    });
    return stderr;
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err);
    throw new Error(`ffmpeg failed: ${msg.slice(-1000)}`);
  }
}

async function probeFile(filePath: string): Promise<{ hasAudio: boolean; durationSec: number }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-print_format", "json",
      "-show_streams", "-show_format", filePath,
    ]);
    const info = JSON.parse(stdout);
    const hasAudio = Array.isArray(info.streams)
      && info.streams.some((s: Record<string, unknown>) => s.codec_type === "audio");
    const durationSec = parseFloat(String(info.format?.duration ?? "0"));
    return { hasAudio, durationSec };
  } catch {
    return { hasAudio: false, durationSec: 0 };
  }
}

// ── Title Card SVG Builder ────────────────────────────────────
function buildTitleCardSvg(
  title: string,
  subtitle: string | undefined,
  bgColor: string,
  w: number,
  h: number,
): string {
  const titleSize = Math.round(w / 18);
  const subSize = Math.round(w / 28);
  const titleY = subtitle ? "42%" : "50%";

  let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="100%" height="100%" fill="${bgColor}"/>`;
  svg += `<text x="50%" y="${titleY}" text-anchor="middle" dominant-baseline="middle"`;
  svg += ` font-family="system-ui, -apple-system, Helvetica Neue, sans-serif"`;
  svg += ` font-size="${titleSize}" font-weight="700" fill="#ffffff">`;
  svg += escapeXml(title);
  svg += `</text>`;

  if (subtitle) {
    svg += `<text x="50%" y="58%" text-anchor="middle" dominant-baseline="middle"`;
    svg += ` font-family="system-ui, -apple-system, Helvetica Neue, sans-serif"`;
    svg += ` font-size="${subSize}" fill="#bbbbbb">`;
    svg += escapeXml(subtitle);
    svg += `</text>`;
  }

  svg += `</svg>`;
  return svg;
}

// ── Segment Builders ──────────────────────────────────────────

/**
 * Render a title card as a video segment.
 * Tries sharp (SVG→PNG) first; falls back to a plain colored background if sharp is unavailable.
 */
async function buildTitleCardSegment(
  entry: TitleCardEntry,
  segPath: string,
  tempDir: string,
  idx: number,
  w: number,
  h: number,
  fps: number,
): Promise<void> {
  const durSec = Math.max(entry.duration / fps, 0.1);
  const bg = entry.background ?? "#1a1a1a";

  let imagePath: string | null = null;

  try {
    const sharp = (await import("sharp")).default;
    const svgStr = buildTitleCardSvg(entry.title, entry.subtitle, bg, w, h);
    imagePath = path.join(tempDir, `title_${idx}.png`);
    await sharp(Buffer.from(svgStr)).png().toFile(imagePath);
  } catch {
    // sharp unavailable — fall through to color source
    imagePath = null;
  }

  if (imagePath) {
    // Image → video + silent audio
    await ffmpeg([
      "-y",
      "-loop", "1", "-t", String(durSec), "-i", imagePath,
      "-f", "lavfi", "-t", String(durSec),
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage",
      "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "128k",
      "-shortest",
      segPath,
    ]);
  } else {
    // Fallback: plain colored background (no text)
    const hex = bg.replace("#", "0x");
    await ffmpeg([
      "-y",
      "-f", "lavfi", "-t", String(durSec),
      "-i", `color=c=${hex}:s=${w}x${h}:r=${fps}`,
      "-f", "lavfi", "-t", String(durSec),
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-shortest",
      segPath,
    ]);
  }
}

/**
 * Trim, scale, and normalize a video clip into a standardized segment.
 * If source file is missing, generates a dark gray placeholder.
 */
async function buildVideoClipSegment(
  entry: VideoClipEntry,
  segPath: string,
  w: number,
  h: number,
  fps: number,
): Promise<void> {
  const durSec = Math.max(entry.duration / fps, 0.1);
  const trimSec = entry.trimStart / fps;

  if (!fs.existsSync(entry.source)) {
    // Missing source → gray placeholder with silent audio
    await ffmpeg([
      "-y",
      "-f", "lavfi", "-t", String(durSec),
      "-i", `color=c=0x333333:s=${w}x${h}:r=${fps}`,
      "-f", "lavfi", "-t", String(durSec),
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-shortest",
      segPath,
    ]);
    return;
  }

  const probe = await probeFile(entry.source);

  // Build ffmpeg args: trim + scale + normalize
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");

  const args: string[] = [
    "-y",
    "-ss", String(trimSec),
    "-t", String(durSec),
    "-i", entry.source,
  ];

  // Add silent audio source if input has no audio track
  if (!probe.hasAudio) {
    args.push(
      "-f", "lavfi", "-t", String(durSec),
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    );
  }

  args.push(
    "-vf", vf,
    "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
  );

  // Volume adjustment
  if (entry.volume !== undefined && entry.volume !== 1) {
    args.push("-af", `volume=${entry.volume}`);
  }

  args.push("-shortest", segPath);
  await ffmpeg(args);
}

// ── Concat ────────────────────────────────────────────────────
async function concatenateSegments(
  segPaths: string[],
  outputPath: string,
  tempDir: string,
): Promise<void> {
  const listFile = path.join(tempDir, "segments.txt");
  const listContent = segPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.promises.writeFile(listFile, listContent);

  await ffmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listFile,
    "-c", "copy",
    outputPath,
  ]);
}

// ── Audio Mixing ──────────────────────────────────────────────
async function mixAudio(
  videoPath: string,
  outputPath: string,
  manifest: DirectorManifest,
): Promise<void> {
  const music = manifest.audioLayer?.music;
  const vo = manifest.audioLayer?.voiceover;

  const hasMusic = music && fs.existsSync(music.track);
  const hasVo = vo && fs.existsSync(vo.source);

  if (!hasMusic && !hasVo) {
    await fs.promises.copyFile(videoPath, outputPath);
    return;
  }

  // Build filter_complex for audio mixing
  const inputs: string[] = ["-y", "-i", videoPath];
  const filterParts: string[] = [];
  const trackLabels: string[] = ["[0:a]"];
  let nextIdx = 1;

  if (hasMusic) {
    inputs.push("-i", music.track);
    filterParts.push(`[${nextIdx}:a]volume=${music.volume ?? 1}[mus]`);
    trackLabels.push("[mus]");
    nextIdx++;
  }

  if (hasVo) {
    inputs.push("-i", vo.source);
    filterParts.push(`[${nextIdx}:a]volume=${vo.volume ?? 1}[vo]`);
    trackLabels.push("[vo]");
    nextIdx++;
  }

  const amixFilter = `${trackLabels.join("")}amix=inputs=${trackLabels.length}:duration=first:dropout_transition=3[aout]`;
  const fullFilter = [...filterParts, amixFilter].join(";");

  await ffmpeg([
    ...inputs,
    "-filter_complex", fullFilter,
    "-map", "0:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "128k",
    outputPath,
  ]);
}

// ── Main Render Pipeline ──────────────────────────────────────
async function renderManifest(
  jobId: string,
  manifest: DirectorManifest,
  outputDir: string,
): Promise<{ outputPath: string; durationSec: number; fileSizeBytes: number }> {
  const totalFrames = calcTotalFrames(manifest);
  const { width: w, height: h, fps } = manifest.composition;
  const safeTitle = manifest.projectTitle.replace(/[^a-zA-Z0-9_-]/g, "_");
  const outputPath = path.join(outputDir, `${safeTitle}.mp4`);
  const tempDir = path.join(outputDir, "_tmp");

  await fs.promises.mkdir(tempDir, { recursive: true });

  // ─── Phase 1: Build individual segments (5–60%) ─────────
  emitProgress(jobId, 0.02, 0, totalFrames);

  const renderables = manifest.timeline
    .filter((e): e is VideoClipEntry | TitleCardEntry =>
      e.type === "video_clip" || e.type === "title_card",
    )
    .sort((a, b) => a.startAtFrame - b.startAtFrame);

  if (renderables.length === 0) {
    throw new Error("No renderable timeline entries (video_clip or title_card)");
  }

  const segPaths: string[] = [];

  for (let i = 0; i < renderables.length; i++) {
    const entry = renderables[i];
    const segPath = path.join(tempDir, `seg_${String(i).padStart(4, "0")}.mp4`);
    const pct = 0.05 + (i / renderables.length) * 0.55;
    emitProgress(jobId, pct, Math.round(pct * totalFrames), totalFrames);

    if (entry.type === "title_card") {
      await buildTitleCardSegment(entry, segPath, tempDir, i, w, h, fps);
    } else {
      await buildVideoClipSegment(entry, segPath, w, h, fps);
    }

    segPaths.push(segPath);
  }

  // ─── Phase 2: Concatenate segments (60–75%) ─────────────
  emitProgress(jobId, 0.62, Math.round(0.62 * totalFrames), totalFrames);

  const concatPath = path.join(tempDir, "concat.mp4");

  if (segPaths.length === 1) {
    await fs.promises.copyFile(segPaths[0], concatPath);
  } else {
    await concatenateSegments(segPaths, concatPath, tempDir);
  }

  // ─── Phase 3: Mix audio (75–92%) ───────────────────────
  emitProgress(jobId, 0.78, Math.round(0.78 * totalFrames), totalFrames);

  const hasExtraAudio =
    (manifest.audioLayer?.music && fs.existsSync(manifest.audioLayer.music.track)) ||
    (manifest.audioLayer?.voiceover && fs.existsSync(manifest.audioLayer.voiceover.source));

  if (hasExtraAudio) {
    await mixAudio(concatPath, outputPath, manifest);
  } else {
    await fs.promises.copyFile(concatPath, outputPath);
  }

  // ─── Phase 4: Cleanup & finalize (92–100%) ─────────────
  emitProgress(jobId, 0.95, Math.round(0.95 * totalFrames), totalFrames);
  await fs.promises.rm(tempDir, { recursive: true, force: true });

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
