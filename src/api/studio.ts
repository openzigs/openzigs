/**
 * Studio API — Video trimming, analysis, and screen capture management.
 * Issue #438: Studio Mode enhancements.
 */

import { Router } from "express";
import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { logger } from "../logging/logger.js";
import type { TrimWorker } from "../video/trim-worker.js";
import type { AnalyzeWorker } from "../video/analyze-worker.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";

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
        res
          .status(400)
          .json({
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

  return router;
};
