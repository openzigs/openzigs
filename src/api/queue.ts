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
import type { CreateMediaJobInput, MediaJobType, MediaJobStatus, TargetNode } from "../queue/types.js";
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

  // ── POST /jobs/:id/kill — Force-fail a dispatched job ───
  router.post("/jobs/:id/kill", async (req, res) => {
    try {
      const job = repo.getJob(req.params.id);
      if (!job || (job.status !== "dispatched" && job.status !== "processing")) {
        res.status(404).json({ error: "Job not found or not in a killable state" });
        return;
      }
      const killed = repo.killJob(req.params.id);
      if (!killed) { res.status(409).json({ error: "Kill failed — job may have already completed" }); return; }

      logger.info(`[QueueAPI] Job ${req.params.id} killed by user (was ${job.status} on ${job.targetNode})`);

      // Best-effort: unload the worker node to free VRAM
      try {
        await queueMaster.unloadNode(job.targetNode);
      } catch {
        // Non-fatal — job is already marked failed in DB
      }

      // Emit so Socket.IO listeners in server.ts re-broadcast to UI
      const updatedJob = repo.getJob(req.params.id);
      if (updatedJob) queueMaster.emit("job:failed", updatedJob, "Killed by user");

      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /complete — Webhook callback from workers ──────
  router.post("/complete", async (req, res) => {
    try {
      const { job_id, status, media_base64, media_type, metadata, error } = req.body;

      logger.info(
        `[QueueAPI] /complete called — job_id=${job_id ?? "(missing)"} status=${status ?? "(missing)"} ` +
        `has_media=${!!media_base64} media_type=${media_type ?? "(none)"} ` +
        `body_keys=${Object.keys(req.body ?? {}).join(",") || "(empty)"}`,
      );

      if (!job_id || !status) {
        logger.warn(`[QueueAPI] /complete rejected 400 — missing job_id or status. body=${JSON.stringify(req.body).slice(0, 200)}`);
        res.status(400).json({ error: "job_id and status are required" });
        return;
      }

      if (status === "failed") {
        await queueMaster.handleJobCompletion(job_id, { error: error ?? "Unknown worker error" });
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

      await queueMaster.handleJobCompletion(job_id, {
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
      // Allow cross-origin image/video/audio loads (NEXT_PUBLIC_OPENZIGS_API_BASE
      // is an absolute URL on a different port, so helmet's default same-origin
      // CORP would silently block <img> and <video> tags in the UI).
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      if (req.query.download === "1") {
        res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      }
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

  // ── POST /image/generate — Direct cloud/auto image gen, saves to gallery ──
  // Bypasses the queue; uses ImageGenService (cloud Imagen or local sidecar).
  router.post("/image/generate", async (req, res) => {
    try {
      const {
        prompt,
        provider,
        imageModel,
        width,
        height,
        steps,
        seed,
      } = req.body as {
        prompt?: string;
        provider?: "cloud" | "local" | "auto";
        imageModel?: string;
        width?: number;
        height?: number;
        steps?: number;
        seed?: number;
      };

      if (!prompt?.trim()) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const { ImageGenService } = await import("../video/generators/image-gen-service.js");
      await ensureGalleryDir();
      const userConfig = await ImageGenService.loadUserImageGenConfig();
      const imageService = new ImageGenService({ outputDir: GALLERY_DIR, ...userConfig });
      await imageService.initialize();

      const result = await imageService.generateImage(prompt.trim(), {
        provider: provider ?? "cloud",
        localModel: imageModel,
        width: width ?? 1024,
        height: height ?? 1024,
        steps,
        seed,
      });

      const filename = path.basename(result.filePath);
      const stats = await fs.stat(result.filePath);
      const modelLabel = result.provider === "cloud" ? "imagen-3" : (imageModel ?? "flux-schnell");

      const assetId = repo.createAsset({
        type: "image",
        filename,
        filePath: result.filePath,
        mimeType: "image/png",
        fileSizeBytes: stats.size,
        width: result.width || undefined,
        height: result.height || undefined,
        prompt: prompt.trim(),
        model: modelLabel,
        generationParams: { provider: result.provider, seed, generationTimeMs: result.generationTimeMs },
        source: "generated",
      });

      logger.info(`[QueueAPI] Cloud image generated: ${filename} via ${result.provider} in ${result.generationTimeMs}ms → asset ${assetId}`);
      res.status(201).json({ assetId, provider: result.provider, model: modelLabel, filename });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueAPI] Cloud image generate failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /nodes — Live status of all worker nodes ────────
  router.get("/nodes", async (_req, res) => {
    try {
      const nodes = await queueMaster.getNodeStatuses();
      res.json({ nodes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /nodes/:node/unload — Unload model from a node ─
  router.post("/nodes/:node/unload", async (req, res) => {
    try {
      const node = req.params.node as TargetNode;
      if (node !== "mac-mini" && node !== "m2-pro") {
        res.status(400).json({ error: "Invalid node. Must be 'mac-mini' or 'm2-pro'" });
        return;
      }

      const result = await queueMaster.unloadNode(node);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /nodes/switch — Switch active model domain ─────
  // Unloads the competing node and optionally preloads a model.
  // Body: { targetNode: "mac-mini"|"m2-pro", model?: "flux-schnell" }
  router.post("/nodes/switch", async (req, res) => {
    try {
      const { targetNode, model } = req.body as { targetNode?: string; model?: string };

      if (!targetNode || (targetNode !== "mac-mini" && targetNode !== "m2-pro")) {
        res.status(400).json({ error: "targetNode must be 'mac-mini' or 'm2-pro'" });
        return;
      }

      const result = await queueMaster.switchActiveNode(targetNode as TargetNode, model);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
