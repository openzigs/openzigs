/**
 * Media Queue API — Push-Based Distributed Queue Router
 * Issue #326: REST API for job submission, status, completion webhooks, and asset gallery.
 */

import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../logging/logger.js";
import type { QueueMaster } from "../queue/queue-master.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type { CreateMediaJobInput, MediaJobType, MediaJobStatus } from "../queue/types.js";
import { MAX_VIDEO_FRAMES, MAX_VIDEO_DURATION_SEC, DEFAULT_VIDEO_FPS } from "../queue/types.js";

// ── Helpers ─────────────────────────────────────────────────

const VALID_JOB_TYPES: MediaJobType[] = ["txt2img", "img2img", "txt2video", "img2video", "tts"];

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

async function ensureGalleryDir(): Promise<void> {
  await fs.mkdir(GALLERY_DIR, { recursive: true });
}

function mimeToExtension(mime: string): string {
  switch (mime) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "video/mp4": return ".mp4";
    case "audio/wav": return ".wav";
    case "audio/mp3": return ".mp3";
    default: return ".bin";
  }
}

function assetTypeFromMime(mime: string): "image" | "video" | "audio" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "image";
}

// ── Router Factory ──────────────────────────────────────────

export interface QueueRouterOptions {
  queueMaster: QueueMaster;
  repo: MediaQueueRepository;
}

export const createQueueRouter = ({ queueMaster, repo }: QueueRouterOptions): Router => {
  const router = Router();

  // ── POST /jobs — Submit a new media generation job ──────
  router.post("/jobs", (req, res) => {
    try {
      const { type, payload, model, projectId, priority } = req.body as Partial<CreateMediaJobInput>;

      if (!type || !VALID_JOB_TYPES.includes(type)) {
        res.status(400).json({ error: `Invalid job type. Must be one of: ${VALID_JOB_TYPES.join(", ")}` });
        return;
      }

      if (!payload || typeof payload !== "object" || !payload.prompt) {
        res.status(400).json({ error: "payload.prompt is required" });
        return;
      }

      // Enforce video frame limits
      if ((type === "txt2video" || type === "img2video") && payload.num_frames) {
        if (payload.num_frames > MAX_VIDEO_FRAMES) {
          res.status(400).json({
            error: `Video frame count ${payload.num_frames} exceeds maximum ${MAX_VIDEO_FRAMES} (${MAX_VIDEO_DURATION_SEC}s at ${DEFAULT_VIDEO_FPS}fps)`,
          });
          return;
        }
      }

      const job = repo.createJob({
        type,
        payload,
        model,
        projectId: projectId ?? undefined,
        priority: priority ?? 0,
      });

      logger.info(`[QueueAPI] Job created: ${job.id} (${job.type} → ${job.targetNode})`);
      res.status(201).json(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueAPI] Job creation failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /jobs — List jobs with optional filters ─────────
  router.get("/jobs", (req, res) => {
    try {
      const status = req.query.status as MediaJobStatus | undefined;
      const type = req.query.type as MediaJobType | undefined;
      const projectId = req.query.projectId as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const jobs = repo.listJobs({ status, type, projectId, limit, offset });
      res.json({ jobs, total: jobs.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /jobs/stats — Dashboard counters ────────────────
  router.get("/jobs/stats", (_req, res) => {
    try {
      const counts = repo.countByStatus();
      res.json(counts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /jobs/:id — Get a single job ────────────────────
  router.get("/jobs/:id", (req, res) => {
    const job = repo.getJob(req.params.id);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  });

  // ── DELETE /jobs/:id — Cancel a pending job ─────────────
  router.delete("/jobs/:id", (req, res) => {
    const cancelled = repo.cancelJob(req.params.id);
    if (!cancelled) { res.status(404).json({ error: "Job not found or not pending" }); return; }
    res.json({ ok: true });
  });

  // ── POST /complete — Webhook callback from workers ──────
  router.post("/complete", async (req, res) => {
    try {
      const { job_id, status, media_base64, media_type, metadata, error } = req.body;

      if (!job_id || !status) {
        res.status(400).json({ error: "job_id and status are required" });
        return;
      }

      if (status === "failed") {
        queueMaster.handleJobCompletion(job_id, { error: error ?? "Unknown worker error" });
        res.json({ ok: true });
        return;
      }

      // Save media to gallery filesystem
      let resultUrl = "";
      let galleryAssetId: string | undefined;

      if (media_base64 && media_type) {
        await ensureGalleryDir();
        const ext = mimeToExtension(media_type);
        const filename = `${job_id}${ext}`;
        const filePath = path.join(GALLERY_DIR, filename);
        const buffer = Buffer.from(media_base64, "base64");
        await fs.writeFile(filePath, buffer);
        resultUrl = `/api/queue/assets/file/${filename}`;

        // Get the job to pull metadata for the asset record
        const job = repo.getJob(job_id);
        const assetType = assetTypeFromMime(media_type);

        galleryAssetId = repo.createAsset({
          type: assetType,
          filename,
          filePath,
          mimeType: media_type,
          fileSizeBytes: buffer.length,
          width: (metadata?.width as number) ?? undefined,
          height: (metadata?.height as number) ?? undefined,
          durationSeconds: (metadata?.duration as number) ?? (assetType === "video" ? MAX_VIDEO_DURATION_SEC : undefined),
          prompt: job?.payload?.prompt,
          model: (metadata?.model as string) ?? job?.requiredModel,
          generationParams: metadata as Record<string, unknown> | undefined,
          source: "generated",
          jobId: job_id,
          projectId: job?.projectId ?? undefined,
        });

        logger.info(`[QueueAPI] Asset saved: ${galleryAssetId} (${filename}, ${buffer.length} bytes)`);
      }

      queueMaster.handleJobCompletion(job_id, {
        media_base64: undefined,
        media_type: undefined,
        metadata: {
          ...((metadata as Record<string, unknown>) ?? {}),
          result_url: resultUrl,
          gallery_asset_id: galleryAssetId,
        },
      });

      // Update the job with result URL and gallery asset ID
      if (resultUrl) {
        repo.markComplete(job_id, resultUrl, metadata as Record<string, unknown>, galleryAssetId);
      }

      res.json({ ok: true, asset_id: galleryAssetId, result_url: resultUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueAPI] Completion webhook failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /assets — List gallery assets ───────────────────
  router.get("/assets", (req, res) => {
    try {
      const type = req.query.type as string | undefined;
      const source = req.query.source as string | undefined;
      const projectId = req.query.projectId as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const assets = repo.listAssets({ type, source, projectId, limit, offset });
      res.json({ assets, total: assets.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /assets/:id — Get a single asset ────────────────
  router.get("/assets/:id", (req, res) => {
    const asset = repo.getAsset(req.params.id);
    if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json(asset);
  });

  // ── DELETE /assets/:id — Delete an asset ────────────────
  router.delete("/assets/:id", async (req, res) => {
    try {
      const asset = repo.getAsset(req.params.id);
      if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

      // Delete file from filesystem
      const filePath = asset.file_path as string;
      try { await fs.unlink(filePath); } catch { /* file may already be gone */ }

      repo.deleteAsset(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── PATCH /assets/:id/tags — Update asset tags ──────────
  router.patch("/assets/:id/tags", (req, res) => {
    try {
      const { tags } = req.body;
      if (!Array.isArray(tags)) { res.status(400).json({ error: "tags must be an array" }); return; }
      repo.updateAssetTags(req.params.id, tags);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /assets/upload — Upload a file directly to gallery ──
  router.post("/assets/upload", async (req, res) => {
    try {
      const { filename, data_base64, mime_type, tags, projectId } = req.body;

      if (!filename || !data_base64 || !mime_type) {
        res.status(400).json({ error: "filename, data_base64, and mime_type are required" });
        return;
      }

      await ensureGalleryDir();
      const buffer = Buffer.from(data_base64, "base64");
      const safeName = path.basename(filename);
      const filePath = path.join(GALLERY_DIR, `upload-${Date.now()}-${safeName}`);
      await fs.writeFile(filePath, buffer);

      const assetType = assetTypeFromMime(mime_type);
      const assetId = repo.createAsset({
        type: assetType,
        filename: safeName,
        filePath,
        mimeType: mime_type,
        fileSizeBytes: buffer.length,
        source: "uploaded",
        projectId,
        tags,
      });

      res.status(201).json({ id: assetId, file_path: filePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /assets/file/:filename — Serve a gallery file ───
  router.get("/assets/file/:filename", async (req, res) => {
    try {
      const safeName = path.basename(req.params.filename);
      const filePath = path.join(GALLERY_DIR, safeName);

      // Verify the file exists and is within gallery dir
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(GALLERY_DIR))) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      await fs.access(resolved);
      res.sendFile(resolved);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // ── GET /project/:projectId/status — Project completion ─
  router.get("/project/:projectId/status", (req, res) => {
    const status = repo.isProjectComplete(req.params.projectId);
    res.json(status);
  });

  return router;
};
