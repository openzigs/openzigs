/**
 * Asset Overlay — Issue #270 (SI-2)
 *
 * Composites image/video overlays onto a background video track using ffmpeg.
 * Called by the Director Mode API when the LLM has determined timestamp-based
 * asset placements from the narration script.
 *
 * Design constraints:
 *   - Uses child_process.spawn (not exec) to avoid shell injection.
 *   - All paths are validated against an allowed-directory allowlist before use.
 *   - Composite operations are deterministic given the same inputs (no temp files
 *     left behind on success).
 *   - Supports overlaying multiple assets in a single ffmpeg invocation using
 *     a chain of [overlay] filtergraph nodes.
 *
 * Dependencies: ffmpeg must be on $PATH (brew install ffmpeg on macOS).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { logger } from "../logging/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type OverlayPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "custom";

export interface AssetPlacement {
  /** Absolute local path to the asset file (image or video). */
  assetPath: string;
  /** Stream number in the background — first input is always 0:v. */
  startTimeSec: number;
  endTimeSec: number;
  /** Pixel coordinates from top-left; overrides position preset when set. */
  x?: number;
  y?: number;
  position?: OverlayPosition;
  /** Scale multiplied against native asset dimensions (default 1.0). */
  scale?: number;
  /** Opacity 0–1 (default 1.0 — ffmpeg colorchannelmixer alpha). */
  opacity?: number;
}

export interface OverlayOptions {
  backgroundPath: string;
  placements: AssetPlacement[];
  outputPath: string;
  /**
   * If true, delete outputPath before writing (avoids ffmpeg "already exists" prompt).
   * Defaults to true.
   */
  overwrite?: boolean;
}

export interface OverlayResult {
  outputPath: string;
  durationSec: number;
  fileSizeBytes: number;
}

// ── Allowed-Directory Guard ───────────────────────────────────────────────────

const ALLOWED_ROOTS: ReadonlyArray<string> = [
  os.homedir(),
  os.tmpdir(),
  "/tmp",
  "/private/tmp",
];

function assertAllowedPath(p: string, label: string): void {
  const resolved = path.resolve(p);
  const allowed = ALLOWED_ROOTS.some(
    (root) =>
      resolved.startsWith(root + path.sep) || resolved === root,
  );
  if (!allowed) {
    throw new Error(
      `Security: ${label} path '${resolved}' is outside the allowed directories.`,
    );
  }
}

// ── Position → ffmpeg coordinates ────────────────────────────────────────────

function positionToXY(
  pos: OverlayPosition | undefined,
  customX: number | undefined,
  customY: number | undefined,
): string {
  if (pos === "custom" || (customX !== undefined && customY !== undefined)) {
    return `x=${customX ?? 0}:y=${customY ?? 0}`;
  }
  switch (pos) {
    case "top-left":     return "x=10:y=10";
    case "top-center":   return "x=(main_w-overlay_w)/2:y=10";
    case "top-right":    return "x=main_w-overlay_w-10:y=10";
    case "center":       return "x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2";
    case "bottom-left":  return "x=10:y=main_h-overlay_h-10";
    case "bottom-center":return "x=(main_w-overlay_w)/2:y=main_h-overlay_h-10";
    case "bottom-right": return "x=main_w-overlay_w-10:y=main_h-overlay_h-10";
    default:             return "x=10:y=10"; // safe default
  }
}

// ── ffmpeg Wrapper ────────────────────────────────────────────────────────────

/**
 * Run ffmpeg with the given argument array.
 * Uses spawn (not exec) to prevent shell injection.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.info(`[AssetOverlay] ffmpeg ${args.slice(0, 10).join(" ")} ...`);

    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
      // No shell: true — intentional security choice
    });

    const stderr: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errLog = stderr.join("").slice(-2000); // last 2000 chars
        reject(new Error(`ffmpeg exited with code ${code ?? "null"}:\n${errLog}`));
      }
    });

    proc.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn ffmpeg — is it installed? (${err.message})\n` +
          "Install with: brew install ffmpeg",
        ),
      );
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Composite one or more image/video overlays onto a background video using ffmpeg.
 *
 * Each placement specifies an asset path, display window (start/end seconds),
 * position preset or pixel coordinates, scale, and opacity.
 *
 * The output file is written to `options.outputPath`. All input and output paths
 * are validated against the allowed-directory allowlist before use.
 *
 * @throws Error if ffmpeg is not found, a path is disallowed, or processing fails.
 */
export async function overlayAssets(options: OverlayOptions): Promise<OverlayResult> {
  const { backgroundPath, placements, outputPath, overwrite = true } = options;

  if (!placements || placements.length === 0) {
    throw new Error("overlayAssets: at least one placement is required");
  }

  // ── Path safety checks ──
  assertAllowedPath(backgroundPath, "background");
  assertAllowedPath(outputPath, "output");
  for (const p of placements) {
    assertAllowedPath(p.assetPath, `asset ${p.assetPath}`);
  }

  // Verify background exists
  await fs.access(backgroundPath);

  // Remove output if overwriting (ffmpeg prompts on existing files)
  if (overwrite) {
    try {
      await fs.unlink(outputPath);
    } catch {
      /* file didn't exist — ok */
    }
  }

  // ── Build ffmpeg filter graph ──
  // Input 0 = background video
  // Inputs 1..N = overlay assets
  //
  // Filter chain:
  //   [1:v] scale=W:H, colorchannelmixer=aa=0.8 [ov1];
  //   [0:v][ov1] overlay=x=10:y=10:enable='between(t,2,8)' [bg1];
  //   [2:v] scale=W:H [ov2];
  //   [bg1][ov2] overlay=... [bg2];
  //   ...

  const inputArgs: string[] = ["-i", backgroundPath];

  for (const placement of placements) {
    inputArgs.push("-i", placement.assetPath);
  }

  const filterParts: string[] = [];
  let prevOutput = "0:v";           // starts with the background stream
  let prevLabel = "[base]";

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const inputIdx = i + 1;          // asset inputs start at 1
    const scaledLabel = `[ov${i}]`;
    const compositeLabel = `[bg${i}]`;

    // Determine scale
    const scaleW = p.scale && p.scale !== 1.0 ? `iw*${p.scale}` : "iw";
    const scaleH = p.scale && p.scale !== 1.0 ? `ih*${p.scale}` : "ih";

    // Opacity — use colorchannelmixer to set alpha channel
    const opacityFilter =
      p.opacity !== undefined && p.opacity < 1.0
        ? `,colorchannelmixer=aa=${p.opacity.toFixed(3)}`
        : "";

    filterParts.push(
      `[${inputIdx}:v] scale=${scaleW}:${scaleH}${opacityFilter} ${scaledLabel}`,
    );

    const xy = positionToXY(p.position, p.x, p.y);
    const enableClause = `enable='between(t,${p.startTimeSec},${p.endTimeSec})'`;

    // Use previous composite output as base; last composite omits output label
    //  → ffmpeg infers it as the final video stream
    const isLast = i === placements.length - 1;
    const outputLabel = isLast ? "" : compositeLabel;
    const outputSpec = isLast ? "" : ` ${outputLabel}`;

    filterParts.push(
      `[${prevOutput}]${scaledLabel} overlay=${xy}:${enableClause}${outputSpec}`,
    );

    if (!isLast) {
      prevOutput = compositeLabel.replace(/\[|\]/g, "");
    }
    void prevLabel;
    prevLabel = outputLabel;
  }

  const filterGraph = filterParts.join("; ");

  const ffmpegArgs: string[] = [
    ...inputArgs,
    "-filter_complex", filterGraph,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "22",
    "-c:a", "copy",     // preserve original audio unchanged
    "-movflags", "+faststart",
    outputPath,
  ];

  await runFfmpeg(ffmpegArgs);

  // Collect output stats
  const stat = await fs.stat(outputPath);

  // Determine duration via a second ffprobe call (lightweight)
  let durationSec = 0;
  try {
    const probeResult = await new Promise<string>((resolve, reject) => {
      const proc = spawn("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-select_streams", "v:0",
        outputPath,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let out = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`ffprobe exit ${code}`));
      });
      proc.on("error", reject);
    });
    const parsed = JSON.parse(probeResult) as { streams?: Array<{ duration?: string }> };
    const dur = parsed.streams?.[0]?.duration;
    if (dur) durationSec = parseFloat(dur);
  } catch {
    // Duration is best-effort; don't fail the whole operation
  }

  logger.info(
    `[AssetOverlay] Composite complete: ${outputPath} ` +
    `(${stat.size} bytes, ${durationSec.toFixed(1)}s, ${placements.length} overlay(s))`,
  );

  return { outputPath, durationSec, fileSizeBytes: stat.size };
}
