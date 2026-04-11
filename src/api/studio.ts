/**
 * Studio API — Video trimming, analysis, and screen capture management.
 * Issue #438: Studio Mode enhancements.
 */

import { Router } from "express";
import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logging/logger.js";
import type { TrimWorker } from "../video/trim-worker.js";
import type { AnalyzeWorker } from "../video/analyze-worker.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import { buildSceneGraph } from "../video/scene-graph.js";

const execFileAsync = promisify(execFile);

// ── Schemas ─────────────────────────────────────────────────

const trimRequestSchema = z
  .object({
    assetId: z.string().min(1, "assetId is required"),
    startTime: z.number().min(0, "startTime must be >= 0"),
    endTime: z.number().positive("endTime must be positive"),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "endTime must be greater than startTime",
  });

const analyzeRequestSchema = z.object({
  assetId: z.string().min(1, "assetId is required"),
  model: z.string().optional(),
});

// ── Factory ─────────────────────────────────────────────────

export interface StudioRouterOptions {
  trimWorker: TrimWorker;
  analyzeWorker: AnalyzeWorker;
  mediaQueueRepo: MediaQueueRepository;
}

export const createStudioRouter = ({
  trimWorker,
  analyzeWorker,
  mediaQueueRepo,
}: StudioRouterOptions): Router => {
  const router = Router();
  const galleryDir = path.join(os.homedir(), ".openzigs", "gallery");

  // ── POST /trim — Submit a trim job ──
  router.post("/trim", async (req, res) => {
    try {
      const parsed = trimRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }

      const { assetId, startTime, endTime } = parsed.data;
      const asset = mediaQueueRepo.getAsset(assetId);
      if (!asset) {
        res.status(404).json({ error: `Asset '${assetId}' not found` });
        return;
      }

      const inputPath = asset.file_path as string;
      if (!fs.existsSync(inputPath)) {
        res.status(404).json({ error: "Asset file not found on disk" });
        return;
      }

      const ext = path.extname(inputPath);
      const baseName = path.basename(inputPath, ext);
      const outputFilename = `${baseName}_trimmed_${Date.now()}${ext}`;
      fs.mkdirSync(galleryDir, { recursive: true });
      const outputPath = path.join(galleryDir, outputFilename);

      const jobId = await trimWorker.submit({
        inputPath,
        outputPath,
        startTime,
        endTime,
      });

      // Register trimmed asset in gallery on completion
      trimWorker.once(`trim:complete:${jobId}`, () => {
        // Use a one-time listener on the generic complete event
      });

      // Listen for completion to register the asset
      const cleanup = () => {
        trimWorker.removeListener("trim:complete", onComplete);
        trimWorker.removeListener("trim:failed", onFail);
      };

      const onComplete = (data: { jobId: string }) => {
        if (data.jobId !== jobId) return;
        cleanup();
        try {
          const stat = fs.statSync(outputPath);
          const duration = endTime - startTime;
          mediaQueueRepo.createAsset({
            type: "video",
            filename: outputFilename,
            filePath: outputPath,
            mimeType: ext === ".webm" ? "video/webm" : "video/mp4",
            fileSizeBytes: stat.size,
            durationSeconds: duration,
            source: "uploaded",
            tags: ["trimmed", `source:${assetId}`],
          });
          logger.info(
            `[StudioRouter] Trimmed asset registered in gallery: ${outputFilename}`,
          );
        } catch (err) {
          logger.error(
            `[StudioRouter] Failed to register trimmed asset: ${err}`,
          );
        }
      };

      const onFail = (data: { jobId: string }) => {
        if (data.jobId !== jobId) return;
        cleanup();
      };

      trimWorker.on("trim:complete", onComplete);
      trimWorker.on("trim:failed", onFail);

      res.json({ jobId, status: "queued" });
    } catch (err) {
      logger.error(`[StudioRouter] Trim error: ${err}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /trim/:jobId — Check trim job status ──
  router.get("/trim/:jobId", (req, res) => {
    const job = trimWorker.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    });
  });

  // ── POST /analyze — Submit a video analysis job ──
  router.post("/analyze", async (req, res) => {
    try {
      const parsed = analyzeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }

      const { assetId, model } = parsed.data;
      const asset = mediaQueueRepo.getAsset(assetId);
      if (!asset) {
        res.status(404).json({ error: `Asset '${assetId}' not found` });
        return;
      }

      const inputPath = asset.file_path as string;
      if (!fs.existsSync(inputPath)) {
        res.status(404).json({ error: "Asset file not found on disk" });
        return;
      }

      const jobId = await analyzeWorker.submit({ assetId, inputPath, model });
      res.json({ jobId, status: "queued" });
    } catch (err) {
      logger.error(`[StudioRouter] Analyze error: ${err}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /analyze/:jobId — Check analysis job status ──
  router.get("/analyze/:jobId", (req, res) => {
    const job = analyzeWorker.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      suggestedCuts: job.suggestedCuts,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    });
  });

  // ── POST /upload-recording — Accept a screen recording blob ──
  router.post("/upload-recording", async (req, res) => {
    try {
      if (
        !req.headers["content-type"]?.includes("multipart/form-data") &&
        !req.headers["content-type"]?.includes("video/")
      ) {
        res.status(400).json({
          error: "Expected multipart/form-data or video/* content-type",
        });
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        res.status(400).json({ error: "Empty request body" });
        return;
      }

      const isWebm = req.headers["content-type"]?.includes("webm");
      const ext = isWebm ? ".webm" : ".mp4";
      const filename = `recording_${Date.now()}${ext}`;
      fs.mkdirSync(galleryDir, { recursive: true });
      const filePath = path.join(galleryDir, filename);
      fs.writeFileSync(filePath, buffer);

      const assetId = mediaQueueRepo.createAsset({
        type: "video",
        filename,
        filePath,
        mimeType: isWebm ? "video/webm" : "video/mp4",
        fileSizeBytes: buffer.length,
        source: "uploaded",
        tags: ["screen-recording"],
      });

      logger.info(
        `[StudioRouter] Screen recording saved: ${filename} (${buffer.length} bytes)`,
      );
      res.json({ assetId, filename, size: buffer.length });
    } catch (err) {
      logger.error(`[StudioRouter] Upload error: ${err}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /import-youtube — Download a YouTube video into the gallery ──
  router.post("/import-youtube", async (req, res) => {
    const bodySchema = z.object({
      url: z.string().url("Invalid URL"),
      title: z.string().optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { url, title: userTitle } = parsed.data;

    // Validate URL protocol to prevent command injection
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        res.status(400).json({ error: "Only http/https URLs are allowed" });
        return;
      }
    } catch {
      res.status(400).json({ error: "Invalid URL" });
      return;
    }

    // Check yt-dlp availability
    try {
      await execFileAsync("which", ["yt-dlp"]);
    } catch {
      res.status(503).json({
        error:
          "yt-dlp is not installed. Install with: brew install yt-dlp",
      });
      return;
    }

    try {
      // Fetch metadata
      let metaTitle: string | undefined;
      let metaDuration: number | undefined;
      try {
        const { stdout } = await execFileAsync(
          "yt-dlp",
          ["--no-download", "--print", "%(title)s\n%(duration)s", "--no-warnings", "--no-playlist", url],
          { timeout: 30000 },
        );
        const lines = stdout.trim().split("\n");
        metaTitle = lines[0] || undefined;
        metaDuration = lines[1] ? parseFloat(lines[1]) : undefined;
      } catch {
        // metadata fetch is best-effort
      }

      const displayTitle = userTitle ?? metaTitle ?? "youtube-import";
      const safeTitle = displayTitle
        .replace(/[^\w\s\-_.]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 80);
      const timestamp = Date.now();
      const outputFilename = `${timestamp}-${safeTitle}.mp4`;
      const outputPath = path.join(galleryDir, outputFilename);

      fs.mkdirSync(galleryDir, { recursive: true });

      await execFileAsync(
        "yt-dlp",
        [
          "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
          "--merge-output-format", "mp4",
          "--no-playlist",
          "--no-warnings",
          "--force-overwrites",
          "-o", outputPath,
          url,
        ],
        { timeout: 600000 }, // 10 min
      );

      // Find the file (yt-dlp may suffix the name)
      const actualPath = await findYtDlpOutput(galleryDir, `${timestamp}-${safeTitle}`, [".mp4", ".mkv", ".webm"]);
      if (!actualPath) {
        res.status(500).json({ error: "Download completed but output file not found" });
        return;
      }

      const stat = fs.statSync(actualPath);
      const assetId = mediaQueueRepo.createAsset({
        type: "video",
        filename: path.basename(actualPath),
        filePath: actualPath,
        mimeType: "video/mp4",
        fileSizeBytes: stat.size,
        durationSeconds: metaDuration,
        prompt: displayTitle,
        source: "ingested",
        sourceUrl: url,
        tags: ["youtube", "video"],
      });

      const asset = mediaQueueRepo.getAsset(assetId);
      logger.info(`[StudioRouter] YouTube import complete: ${actualPath}`);
      res.json({ assetId, asset });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[StudioRouter] YouTube import failed: ${msg}`);
      res.status(500).json({ error: `Download failed: ${msg}` });
    }
  });

  // ── POST /split-scenes — Analyze a video and return timeline scene entries ──
  router.post("/split-scenes", async (req, res) => {
    const bodySchema = z.object({
      source: z.string().min(1, "source file path required"),
      fps: z.number().min(1).max(120).default(30),
      minSceneDuration: z.number().min(1).max(60).default(5),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { source, fps, minSceneDuration } = parsed.data;

    if (!fs.existsSync(source)) {
      res.status(404).json({ error: "Source file not found" });
      return;
    }

    try {
      // Get duration via ffprobe
      const duration = await getVideoDuration(source);
      if (duration <= 0) {
        res.status(400).json({ error: "Could not determine video duration" });
        return;
      }

      // Detect scene changes via FFmpeg
      const sceneChanges = await detectSceneChanges(source);

      // Build a lightweight scene graph (no LLM, no frames — just transcript + scene changes)
      const sceneGraph = buildSceneGraph({
        duration,
        transcript: [],
        frames: [],
        sceneChanges,
        segmentDuration: Math.max(minSceneDuration, 15),
      });

      const scenes = sceneGraph.segments;

      if (scenes.length === 0) {
        res.json({ scenes: [], totalDuration: duration });
        return;
      }

      // Convert to timeline entries (frame units)
      const timelineEntries = scenes
        .filter((s) => (s.end - s.start) >= minSceneDuration)
        .map((s, i) => ({
          type: "video_clip" as const,
          source,
          title: `Scene ${i + 1}`,
          startAtFrame: Math.round(s.start * fps),
          trimStart: s.start,
          trimEnd: s.end,
          duration: Math.round((s.end - s.start) * fps),
          durationInFrames: Math.round((s.end - s.start) * fps),
          sceneType: s.sceneType,
          hasSceneChange: s.hasSceneChange,
        }));

      logger.info(
        `[StudioRouter] split-scenes: ${timelineEntries.length} scenes from ${source}`,
      );
      res.json({ scenes: timelineEntries, totalDuration: duration, sceneChangeCount: sceneChanges.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[StudioRouter] split-scenes failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
};

// ── Private helpers ──────────────────────────────────────────

async function findYtDlpOutput(
  dir: string,
  prefix: string,
  extensions: string[],
): Promise<string | null> {
  const files = fs.readdirSync(dir);
  for (const ext of extensions) {
    const match = files.find((f) => f.startsWith(prefix) && f.endsWith(ext));
    if (match) return path.join(dir, match);
  }
  const fallback = files.find((f) => f.startsWith(prefix));
  return fallback ? path.join(dir, fallback) : null;
}

function getVideoDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.on("close", (code) => {
      if (code !== 0) { reject(new Error("ffprobe failed")); return; }
      const d = parseFloat(stdout.trim());
      resolve(isNaN(d) ? 0 : d);
    });
    proc.on("error", reject);
  });
}

function detectSceneChanges(inputPath: string): Promise<Array<{ timestamp: number; score: number }>> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-i", inputPath,
      "-vf", "select='gt(scene,0.3)',showinfo",
      "-f", "null", "-",
    ]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("close", () => {
      const changes: Array<{ timestamp: number; score: number }> = [];
      for (const line of stderr.split("\n")) {
        const ptsMatch = line.match(/pts_time:(\d+\.?\d*)/);
        const sceneMatch = line.match(/scene:(\d+\.?\d*)/);
        if (ptsMatch) {
          changes.push({
            timestamp: parseFloat(ptsMatch[1]),
            score: sceneMatch ? parseFloat(sceneMatch[1]) : 0.5,
          });
        }
      }
      resolve(changes);
    });
    proc.on("error", () => resolve([]));
  });
}
