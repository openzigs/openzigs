/**
 * Media Queue API — Push-Based Distributed Queue Router
 * Issue #326: REST API for job submission, status, completion webhooks, and asset gallery.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../logging/logger.js";
import { getDatabase } from "../productivity/database.js";
import {
  verifyHmacCallback,
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
} from "./hmac.js";
import {
  createTokenBucketLimiter,
  bucketKeyFromRequest,
  type RateLimiter,
} from "./rate-limit.js";
import type { QueueMaster } from "../queue/queue-master.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type {
  CreateMediaJobInput,
  MediaJobType,
  MediaJobStatus,
  TargetNode,
  MediaJobPayload,
} from "../queue/types.js";
import {
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_DURATION_SEC,
  DEFAULT_VIDEO_FPS,
  VALID_VIDEO_DURATIONS,
} from "../queue/types.js";
import {
  resolveNodeConfig,
  buildNodeAuthHeaders,
} from "../queue/node-config-resolver.js";
import {
  isMultiSegmentDuration,
  isValidVideoDuration,
  decomposeMultiSegmentJob,
  registerSegmentJob,
  isSegmentJob as isSegmentJobCheck,
  formatSegmentProgress,
} from "../queue/multi-segment.js";
import { createTalkingHeadPipeline } from "../queue/talking-head-pipeline.js";
import type { CharacterRepository } from "../characters/character-repository.js";
import type { KnowledgeIngestionService } from "../knowledge/index.js";
import { injectCharacterLora as injectCharacterLoraShared } from "./inject-character-lora.js";

// ── Helpers ─────────────────────────────────────────────────

const VALID_JOB_TYPES: MediaJobType[] = [
  "txt2img",
  "img2img",
  "txt2video",
  "img2video",
  "tts",
  "txt2music",
  "voice2voice",
  "remix_analyze",
  "remix_replace",
  "remix_master",
  "lipsync",
];

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

async function ensureGalleryDir(): Promise<void> {
  await fs.mkdir(GALLERY_DIR, { recursive: true });
}

function mimeToExtension(mime: string): string {
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "audio/wav":
      return ".wav";
    case "audio/mp3":
      return ".mp3";
    default:
      return ".bin";
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
  characterRepo?: CharacterRepository;
  knowledgeService?: KnowledgeIngestionService;
  /** Optional shared secret for worker callback authentication. */
  workerSecret?: string;
  /** Issue #1089 — accept legacy Bearer auth in addition to HMAC. Default true. */
  allowLegacyBearer?: boolean;
  /** Issue #1087 — per-node-type token-bucket rate limit. */
  callbackRateLimit?: { perMinute: number; burst: number };
}

// Throttle the legacy-bearer deprecation warning so we don't spam logs.
const LEGACY_WARN_INTERVAL_MS = 60 * 60 * 1000;
const lastLegacyWarn = new Map<string, number>();
function warnLegacyBearerOnce(key: string, ip: string): void {
  const now = Date.now();
  const prev = lastLegacyWarn.get(key) ?? 0;
  if (now - prev > LEGACY_WARN_INTERVAL_MS) {
    lastLegacyWarn.set(key, now);
    logger.warn(
      `[QueueAPI] Legacy Bearer auth used for callback by ${key} (${ip}) — will be removed in next release. Upgrade sidecar to HMAC.`,
    );
  }
}

/**
 * Callback router for worker completion webhooks.  When `workerSecret` is configured,
 * callbacks require `Authorization: Bearer <secret>` (timing-safe comparison).
 * When no secret is configured, callbacks are accepted without auth (backward-compatible).
 * Safety: the handler also validates that job_id matches an existing dispatched
 * job via queueMaster.handleJobCompletion; unknown job IDs are rejected.
 */
export const createQueueCallbackRouter = ({
  queueMaster,
  repo,
  knowledgeService,
  workerSecret,
  allowLegacyBearer = true,
  callbackRateLimit = { perMinute: 60, burst: 10 },
}: QueueRouterOptions): Router => {
  const callbackRouter = Router();

  // Issue #1087 — per-node-type rate limit applied BEFORE auth verification
  // so that bad actors can't burn CPU brute-forcing signatures.
  const limiter: RateLimiter = createTokenBucketLimiter(callbackRateLimit);
  const rateLimitMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const key = bucketKeyFromRequest(req);
    const verdict = limiter.consume(key);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSec ?? 1));
      logger.warn(
        `[QueueAPI] Rate-limited callback from ${key} (ip=${req.ip}) — retry-after ${verdict.retryAfterSec}s`,
      );
      res.status(429).json({
        error: "rate_limited",
        retry_after_sec: verdict.retryAfterSec,
      });
      return;
    }
    next();
  };

  // Issue #1089 — HMAC + timestamp verification with optional legacy Bearer
  // fallback. NOT applied as callbackRouter.use() because the callback and
  // main queue routers are both mounted at /api/queue.
  let callbackAuthMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;

  if (workerSecret) {
    const expectedBuf = Buffer.from(workerSecret);
    callbackAuthMiddleware = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      const tsHeader = req.headers[HMAC_HEADER_TIMESTAMP];
      const sigHeader = req.headers[HMAC_HEADER_SIGNATURE];
      const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

      if (timestamp && signature) {
        const rawBody =
          (req as unknown as { rawBody?: Buffer }).rawBody ??
          Buffer.from(JSON.stringify(req.body ?? {}));
        const verdict = verifyHmacCallback({
          secret: workerSecret,
          timestamp,
          signature,
          rawBody,
        });
        if (!verdict.ok) {
          logger.warn(
            `[QueueAPI] Rejected HMAC callback from ${req.ip} ${req.method} ${req.originalUrl} — reason=${verdict.reason}`,
          );
          res.status(401).json({
            error:
              verdict.reason === "stale_timestamp"
                ? "stale_timestamp"
                : "bad_signature",
          });
          return;
        }
        return next();
      }

      // No HMAC headers — fall back to legacy Bearer when allowed.
      if (allowLegacyBearer) {
        const authHeader = req.headers.authorization ?? "";
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : "";
        const tokenBuf = Buffer.from(token);
        if (
          tokenBuf.length === expectedBuf.length &&
          timingSafeEqual(tokenBuf, expectedBuf)
        ) {
          warnLegacyBearerOnce(bucketKeyFromRequest(req), req.ip ?? "unknown");
          return next();
        }
      }

      logger.warn(
        `[QueueAPI] Rejected callback — missing/invalid HMAC and legacy Bearer ${
          allowLegacyBearer ? "rejected" : "disabled"
        } from ${req.ip} ${req.method} ${req.originalUrl}`,
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    };
    logger.info(
      `[QueueAPI] Worker callback auth: HMAC enabled${allowLegacyBearer ? " (legacy Bearer fallback ON)" : ""}`,
    );
  } else {
    // No workerSecret — only allow localhost requests
    const LOCALHOST_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    callbackAuthMiddleware = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (LOCALHOST_IPS.has(req.ip ?? "")) {
        return next();
      }
      logger.warn(
        `[QueueAPI] Rejected callback from non-localhost ${req.ip} — auth.workerSecret not configured`,
      );
      res.status(401).json({
        error:
          "Queue callback requires auth.workerSecret when accessed from non-localhost. Set it in ~/.openzigs/config.json",
      });
      return;
    };
    logger.warn(
      "[QueueAPI] auth.workerSecret not configured — queue callbacks will only be accepted from localhost",
    );
  }

  // Apply rate limit before auth on every callback route below.
  callbackRouter.use(["/complete", "/progress"], rateLimitMiddleware);

  callbackRouter.post("/complete", callbackAuthMiddleware, async (req, res) => {
    try {
      const {
        job_id,
        status,
        media_base64,
        media_type,
        file_path,
        metadata,
        error,
        ...extraFields
      } = req.body;

      logger.info(
        `[QueueAPI] /complete called — job_id=${job_id ?? "(missing)"} status=${status ?? "(missing)"} ` +
          `has_media=${!!media_base64} has_file=${!!file_path} media_type=${media_type ?? "(none)"} ` +
          `body_keys=${Object.keys(req.body ?? {}).join(",") || "(empty)"}`,
      );

      if (!job_id || !status) {
        logger.warn(
          `[QueueAPI] /complete rejected 400 — missing job_id or status. body=${JSON.stringify(req.body).slice(0, 200)}`,
        );
        res.status(400).json({ error: "job_id and status are required" });
        return;
      }

      if (status === "failed") {
        await queueMaster.handleJobCompletion(job_id, {
          error: error ?? "Unknown worker error",
        });
        res.json({ ok: true });
        return;
      }

      // Save media to gallery filesystem
      let resultUrl = "";
      let galleryAssetId: string | undefined;
      let savedFilePath: string | undefined;

      // Check if this is a multi-segment sub-job — if so, pass base64 directly
      // to handleJobCompletion for segment orchestration instead of saving to gallery.
      const completedJob = repo.getJob(job_id);
      if (
        completedJob &&
        isSegmentJobCheck(completedJob) &&
        (media_base64 || file_path)
      ) {
        // Read video bytes from file_path or use base64
        let videoBase64 = media_base64;
        if (!videoBase64 && file_path) {
          const resolved = path.resolve(String(file_path));
          if (resolved.startsWith(path.resolve(GALLERY_DIR))) {
            const fileData = await fs.readFile(resolved);
            videoBase64 = fileData.toString("base64");
          }
        }

        await queueMaster.handleJobCompletion(job_id, {
          media_base64: videoBase64,
          media_type: media_type ?? "video/mp4",
          metadata: {
            ...((metadata as Record<string, unknown>) ?? {}),
            ...(extraFields as Record<string, unknown>),
          },
        });
        res.json({ ok: true, segment: true });
        return;
      }

      // File-based callback: sidecar already wrote the file to gallery dir
      let filePathUsable = false;
      if (file_path && media_type) {
        const resolved = path.resolve(String(file_path));
        // Security: ensure file is within gallery dir
        if (!resolved.startsWith(path.resolve(GALLERY_DIR))) {
          logger.warn(
            `[QueueAPI] /complete file_path outside gallery: ${file_path} — will fall through to base64 if available`,
          );
          // Don't reject — fall through to base64 handler below
        } else {
          filePathUsable = true;
        }
      }

      if (filePathUsable && file_path && media_type) {
        const resolved = path.resolve(String(file_path));

        const filename = path.basename(resolved);
        const stat = await fs.stat(resolved);
        resultUrl = `/api/queue/assets/file/${filename}`;
        savedFilePath = resolved;

        const job = repo.getJob(job_id);
        const assetType = assetTypeFromMime(media_type);

        galleryAssetId = repo.createAsset({
          type: assetType,
          filename,
          filePath: resolved,
          mimeType: media_type,
          fileSizeBytes: stat.size,
          width: (metadata?.width as number) ?? undefined,
          height: (metadata?.height as number) ?? undefined,
          durationSeconds: (metadata?.duration as number) ?? undefined,
          prompt: job?.payload?.prompt,
          model: (metadata?.model as string) ?? job?.requiredModel,
          generationParams: metadata as Record<string, unknown> | undefined,
          source: "generated",
          jobId: job_id,
          projectId: job?.projectId ?? undefined,
        });

        logger.info(
          `[QueueAPI] Asset saved (file-based): ${galleryAssetId} (${filename}, ${stat.size} bytes)`,
        );
      } else if (media_base64 && media_type) {
        // Legacy base64 callback (kept for backward compat with other sidecars)
        await ensureGalleryDir();
        const ext = mimeToExtension(media_type);
        const safeJobId = String(job_id).replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `${safeJobId}${ext}`;
        const filePath = path.join(GALLERY_DIR, filename);
        const buffer = Buffer.from(media_base64, "base64");
        await fs.writeFile(filePath, buffer);
        resultUrl = `/api/queue/assets/file/${filename}`;
        savedFilePath = filePath;

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
          durationSeconds:
            (metadata?.duration as number) ??
            (assetType === "video" ? MAX_VIDEO_DURATION_SEC : undefined),
          prompt: job?.payload?.prompt,
          model: (metadata?.model as string) ?? job?.requiredModel,
          generationParams: metadata as Record<string, unknown> | undefined,
          source: "generated",
          jobId: job_id,
          projectId: job?.projectId ?? undefined,
        });

        logger.info(
          `[QueueAPI] Asset saved: ${galleryAssetId} (${filename}, ${buffer.length} bytes)`,
        );
      }

      await queueMaster.handleJobCompletion(job_id, {
        media_base64: undefined,
        media_type: media_type ?? undefined,
        metadata: {
          ...((metadata as Record<string, unknown>) ?? {}),
          ...(extraFields as Record<string, unknown>),
          result_url: resultUrl,
          gallery_asset_id: galleryAssetId,
          file_path: savedFilePath,
        },
      });

      // Update the job with result URL and gallery asset ID
      if (resultUrl) {
        repo.markComplete(
          job_id,
          resultUrl,
          metadata as Record<string, unknown>,
          galleryAssetId,
        );
      }

      // Ingest the new asset into the RAG knowledge base
      if (galleryAssetId && knowledgeService) {
        const asset = repo.getAsset(galleryAssetId);
        if (asset) {
          const job = repo.getJob(job_id);
          const tags = asset.tags
            ? (JSON.parse(String(asset.tags)) as string[])
            : [];
          void knowledgeService
            .ingestAsset({
              id: galleryAssetId,
              type: asset.type as "image" | "video" | "audio" | "scene",
              filename: String(asset.filename),
              filePath: asset.file_path as string | undefined,
              prompt:
                job?.payload?.prompt ?? (asset.prompt as string | undefined),
              model: asset.model as string | undefined,
              tags,
              source: String(asset.source ?? "generated"),
              durationSeconds: asset.duration_seconds as number | undefined,
              width: asset.width as number | undefined,
              height: asset.height as number | undefined,
            })
            .catch((err) => {
              logger.warn(
                `[QueueAPI] RAG ingest failed for asset ${galleryAssetId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }

      res.json({ ok: true, asset_id: galleryAssetId, result_url: resultUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueAPI] Completion webhook failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /progress — Granular pipeline progress updates (called by sidecars) ──
  callbackRouter.post("/progress", callbackAuthMiddleware, (req, res) => {
    try {
      const { job_id, stage, progress, message } = req.body as {
        job_id?: string;
        stage?: string;
        progress?: number;
        message?: string;
      };

      if (!job_id) {
        res.status(400).json({ error: "job_id is required" });
        return;
      }

      // For segment sub-jobs, also report aggregate progress on the parent
      const progressJob = repo.getJob(job_id);
      if (progressJob?.payload?.parentJobId) {
        const segMsg = formatSegmentProgress(
          progressJob.payload.segmentIndex ?? 0,
          progressJob.payload.totalSegments ?? 1,
          progress,
        );
        queueMaster.reportProgress(progressJob.payload.parentJobId, {
          stage,
          progress,
          message: segMsg,
        });
      }

      queueMaster.reportProgress(job_id, { stage, progress, message });
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueAPI] Progress webhook failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return callbackRouter;
};

export const createQueueRouter = ({
  queueMaster,
  repo,
  characterRepo,
  knowledgeService,
}: QueueRouterOptions): Router => {
  const router = Router();

  /**
   * Auto-inject LoRA adapters when a prompt contains a trained character's trigger word.
   * Delegates to the shared helper in ``./inject-character-lora.ts`` so the
   * Creative Studio inpaint endpoint and the queue API share one
   * implementation (epic #868).
   */
  function injectCharacterLora(payload: MediaJobPayload): void {
    injectCharacterLoraShared(payload, characterRepo);
  }

  // ── POST /jobs — Submit a new media generation job ──────
  router.post("/jobs", (req, res) => {
    try {
      const {
        type,
        payload,
        model,
        projectId,
        priority,
        notifyViaTelegram,
        telegramChatId,
      } = req.body as Partial<CreateMediaJobInput>;

      if (!type || !VALID_JOB_TYPES.includes(type)) {
        res.status(400).json({
          error: `Invalid job type. Must be one of: ${VALID_JOB_TYPES.join(", ")}`,
        });
        return;
      }

      // Remix and lipsync jobs don't require a prompt — only a payload object
      const isNoPromptType =
        type.startsWith("remix_") || type === "lipsync" || type === "sadtalker";
      if (!payload || typeof payload !== "object") {
        res.status(400).json({ error: "payload is required" });
        return;
      }
      if (!isNoPromptType && !payload.prompt) {
        res.status(400).json({ error: "payload.prompt is required" });
        return;
      }

      const MAX_TASK_INPUT_LENGTH = 50_000;
      if (
        typeof payload.prompt === "string" &&
        payload.prompt.length > MAX_TASK_INPUT_LENGTH
      ) {
        res.status(400).json({
          error: `Prompt exceeds ${MAX_TASK_INPUT_LENGTH} characters`,
        });
        return;
      }

      // Enforce video frame limits
      if (
        (type === "txt2video" || type === "img2video") &&
        payload.num_frames
      ) {
        if (payload.num_frames > MAX_VIDEO_FRAMES) {
          res.status(400).json({
            error: `Video frame count ${payload.num_frames} exceeds maximum ${MAX_VIDEO_FRAMES} (${MAX_VIDEO_DURATION_SEC}s at ${DEFAULT_VIDEO_FPS}fps)`,
          });
          return;
        }
      }

      // Automatically inject character LoRA when trigger word detected in prompt
      if (type === "txt2img" || type === "img2img") {
        injectCharacterLora(payload);
      }

      // ── Multi-Segment Video Decomposition ─────────────────
      // If video_duration > 4, decompose into chained 4s segment jobs
      if (
        (type === "txt2video" || type === "img2video") &&
        isMultiSegmentDuration(payload.video_duration)
      ) {
        const duration = payload.video_duration!;
        if (!isValidVideoDuration(duration)) {
          res.status(400).json({
            error: `Invalid video_duration ${duration}. Must be one of: ${VALID_VIDEO_DURATIONS.join(", ")}`,
          });
          return;
        }

        // Create parent job (tracks overall progress)
        const parentJob = repo.createJob({
          type,
          payload: { ...payload, video_duration: duration },
          model,
          projectId: projectId ?? undefined,
          priority: priority ?? 0,
          notifyViaTelegram: notifyViaTelegram ?? undefined,
          telegramChatId: telegramChatId ?? undefined,
        });

        // Decompose into first segment
        const decomposed = decomposeMultiSegmentJob(parentJob);
        if (decomposed) {
          const firstSegment = repo.createJob({
            type: decomposed.type,
            payload: decomposed.payload,
            model,
            priority: (priority ?? 0) + 1, // segments get higher priority
          });
          registerSegmentJob(parentJob.id, 0, firstSegment.id);

          logger.info(
            `[QueueAPI] Multi-segment job created: parent=${parentJob.id} (${duration}s, ${decomposed.totalSegments} segments), first segment=${firstSegment.id}`,
          );

          res.status(201).json({
            ...parentJob,
            multiSegment: true,
            totalSegments: decomposed.totalSegments,
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
        notifyViaTelegram: notifyViaTelegram ?? undefined,
        telegramChatId: telegramChatId ?? undefined,
      });

      logger.info(
        `[QueueAPI] Job created: ${job.id} (${job.type} → ${job.targetNode})`,
      );
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
      const total = repo.countJobs({ status, type, projectId });
      res.json({ jobs, total });
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
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  });

  // ── DELETE /jobs/:id — Cancel a pending job ─────────────
  router.delete("/jobs/:id", (req, res) => {
    const cancelled = repo.cancelJob(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: "Job not found or not pending" });
      return;
    }
    res.json({ ok: true });
  });

  // ── POST /pipelines/talking-head — Create a talking-head pipeline ──
  router.post("/pipelines/talking-head", (req, res) => {
    try {
      const {
        text,
        voice,
        referenceAudio,
        f5ttsProfileId,
        videoPrompt,
        referenceImage,
        videoModel,
        lipsyncModelVersion,
        inferenceSteps,
        guidanceScale,
        enableDeepCache,
        maxDurationSec,
        projectId,
        priority,
      } = req.body as Record<string, unknown>;

      if (!text || typeof text !== "string" || text.trim().length === 0) {
        res.status(400).json({ error: "text is required" });
        return;
      }

      const MAX_TEXT_LENGTH = 10_000;
      if (text.length > MAX_TEXT_LENGTH) {
        res
          .status(400)
          .json({ error: `Text exceeds ${MAX_TEXT_LENGTH} characters` });
        return;
      }

      // Resolve F5-TTS profile clips from DB if a profile ID was provided
      let f5ttsClips:
        | Array<{ emotion: string; ref_audio_path: string; ref_text: string }>
        | undefined;
      if (f5ttsProfileId && typeof f5ttsProfileId === "string") {
        const db = getDatabase();
        const clips = db
          .prepare(
            `SELECT emotion, ref_audio_path, ref_text FROM f5tts_clips WHERE profile_id = ? ORDER BY sort_order ASC`,
          )
          .all(f5ttsProfileId) as Array<{
          emotion: string;
          ref_audio_path: string;
          ref_text: string;
        }>;
        if (clips.length === 0) {
          res
            .status(400)
            .json({ error: `F5-TTS profile ${f5ttsProfileId} has no clips` });
          return;
        }
        f5ttsClips = clips;
      }

      const { pipelineId, stages, firstJob } = createTalkingHeadPipeline({
        text: text as string,
        voice: voice as string | undefined,
        referenceAudio: referenceAudio as string | undefined,
        f5ttsClips,
        videoPrompt: videoPrompt as string | undefined,
        referenceImage: referenceImage as string | undefined,
        videoModel: videoModel as string | undefined,
        lipsyncModelVersion: lipsyncModelVersion as string | undefined,
        inferenceSteps: inferenceSteps as number | undefined,
        guidanceScale: guidanceScale as number | undefined,
        enableDeepCache: enableDeepCache as boolean | undefined,
        maxDurationSec: maxDurationSec as number | undefined,
        projectId: projectId as string | undefined,
        priority: priority as number | undefined,
      });

      // Enqueue the first stage (TTS)
      const job = repo.createJob({
        type: firstJob.type,
        payload: firstJob.payload,
        model: firstJob.model,
        projectId: projectId as string | undefined,
        priority: (priority as number) ?? 0,
      });

      res.status(201).json({
        pipeline_id: pipelineId,
        pipeline_type: "talking-head",
        stages,
        first_job_id: job.id,
        status: "started",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueueAPI] Pipeline creation failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /sidecars/lipsync/health — Check if lipsync sidecar is reachable ──
  router.get("/sidecars/lipsync/health", async (_req, res) => {
    try {
      // Resolve the configured node URL (CF tunnel or localhost fallback).
      // Issue #1104: canonical local port is 5012; remote URL comes from config.
      const nodeConfig = await resolveNodeConfig("lip-sync", {
        skipValidation: true,
      });
      const candidates: Array<{
        url: string;
        headers: Record<string, string>;
      }> = [
        { url: nodeConfig.url, headers: buildNodeAuthHeaders(nodeConfig) },
        // Always fall back to localhost so the endpoint works even if the
        // resolver returns the CF URL but the local sidecar is also running.
        ...(nodeConfig.url !== "http://127.0.0.1:5012"
          ? [{ url: "http://127.0.0.1:5012", headers: {} }]
          : []),
      ];
      for (const candidate of candidates) {
        try {
          const resp = await fetch(`${candidate.url}/health`, {
            headers: candidate.headers,
            signal: AbortSignal.timeout(5000),
          });
          if (resp.ok) {
            const data = (await resp.json()) as Record<string, unknown>;
            res.json({ status: "ok", url: candidate.url, ...data });
            return;
          }
        } catch {
          // try next candidate
        }
      }
      res.json({ status: "unreachable" });
    } catch {
      res.json({ status: "unreachable" });
    }
  });

  // ── POST /jobs/:id/kill — Force-fail a dispatched job ───
  router.post("/jobs/:id/kill", async (req, res) => {
    try {
      const job = repo.getJob(req.params.id);
      if (
        !job ||
        (job.status !== "dispatched" && job.status !== "processing")
      ) {
        res
          .status(404)
          .json({ error: "Job not found or not in a killable state" });
        return;
      }
      const killed = repo.killJob(req.params.id);
      if (!killed) {
        res
          .status(409)
          .json({ error: "Kill failed — job may have already completed" });
        return;
      }

      logger.info(
        `[QueueAPI] Job ${req.params.id} killed by user (was ${job.status} on ${job.targetNode})`,
      );

      // Best-effort: unload the worker node to free VRAM
      try {
        await queueMaster.unloadNode(job.targetNode);
      } catch {
        // Non-fatal — job is already marked failed in DB
      }

      // Emit so Socket.IO listeners in server.ts re-broadcast to UI
      const updatedJob = repo.getJob(req.params.id);
      if (updatedJob)
        queueMaster.emit("job:failed", updatedJob, "Killed by user");

      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /assets — List gallery assets ───────────────────
  router.get("/assets", (req, res) => {
    try {
      const type = req.query.type as string | undefined;
      const source = req.query.source as string | undefined;
      const projectId = req.query.projectId as string | undefined;
      const folder = req.query.folder as string | undefined;
      const q = req.query.q as string | undefined;
      const collection = req.query.collection as string | undefined;
      const tags = req.query.tags as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      let assets = repo.listAssets({
        type,
        source,
        projectId,
        folder,
        q,
        limit,
        offset,
      });
      let total = repo.countAssets({ type, source, projectId, folder, q });

      // Server-side filtering by collection and/or tags from gallery tables
      if (collection || tags) {
        try {
          const dirDb = getDatabase();
          let allowedPaths: Set<string> | null = null;

          if (collection) {
            const rows = dirDb
              .prepare(
                `SELECT asset_path FROM gallery_collection_items WHERE collection_id = ?`,
              )
              .all(collection) as Array<{ asset_path: string }>;
            allowedPaths = new Set(rows.map((r) => r.asset_path));
          }

          if (tags) {
            const tagList = tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            for (const tag of tagList) {
              const rows = dirDb
                .prepare(`SELECT asset_path FROM gallery_tags WHERE tag = ?`)
                .all(tag.toLowerCase()) as Array<{ asset_path: string }>;
              const tagPaths = new Set(rows.map((r) => r.asset_path));
              if (allowedPaths) {
                allowedPaths = new Set(
                  [...allowedPaths].filter((p) => tagPaths.has(p)),
                );
              } else {
                allowedPaths = tagPaths;
              }
            }
          }

          if (allowedPaths !== null) {
            assets = assets.filter(
              (a) =>
                allowedPaths!.has(String(a.file_path)) ||
                allowedPaths!.has(String(a.filename)),
            );
            total = assets.length;
          }
        } catch {
          // Gallery tables may not exist yet — fall through without filtering
        }
      }

      res.json({ assets, total });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /assets/folders — List all folders with counts ──
  router.get("/assets/folders", (_req, res) => {
    try {
      const folders = repo.listFolders();
      res.json({ folders });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /assets/:id — Get a single asset ────────────────
  router.get("/assets/:id", (req, res) => {
    const asset = repo.getAsset(req.params.id);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.json(asset);
  });

  // ── DELETE /assets/:id — Delete an asset ────────────────
  router.delete("/assets/:id", async (req, res) => {
    try {
      const asset = repo.getAsset(req.params.id);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }

      // Delete file from filesystem
      const filePath = asset.file_path as string;
      try {
        await fs.unlink(filePath);
      } catch {
        /* file may already be gone */
      }

      // Remove from RAG knowledge base
      if (knowledgeService) {
        void knowledgeService.removeAsset(req.params.id).catch((err) => {
          logger.warn(
            `[QueueAPI] RAG removal failed for asset ${req.params.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

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
      if (!Array.isArray(tags)) {
        res.status(400).json({ error: "tags must be an array" });
        return;
      }
      repo.updateAssetTags(req.params.id, tags);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── PATCH /assets/:id/knowledge — Update RAG visibility/category ──
  router.patch("/assets/:id/knowledge", async (req, res) => {
    try {
      const { visibility, category } = req.body as {
        visibility?: string;
        category?: string;
      };
      const VALID_VISIBILITY = ["public", "internal", "private"];
      const VALID_CATEGORY = [
        "media",
        "document",
        "presentation",
        "social",
        "system",
        "conversation",
      ];

      if (visibility && !VALID_VISIBILITY.includes(visibility)) {
        res.status(400).json({
          error: `visibility must be one of: ${VALID_VISIBILITY.join(", ")}`,
        });
        return;
      }
      if (category && !VALID_CATEGORY.includes(category)) {
        res.status(400).json({
          error: `category must be one of: ${VALID_CATEGORY.join(", ")}`,
        });
        return;
      }

      const asset = repo.getAsset(req.params.id);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }

      const newVisibility =
        visibility ?? String(asset.knowledge_visibility ?? "public");
      const newCategory =
        category ?? String(asset.knowledge_category ?? "media");

      repo.updateAssetKnowledgeMeta(req.params.id, newVisibility, newCategory);

      // Re-ingest into RAG with updated metadata
      if (knowledgeService) {
        const tags = asset.tags
          ? (JSON.parse(String(asset.tags)) as string[])
          : [];
        void knowledgeService
          .ingestAsset({
            id: req.params.id,
            type: asset.type as "image" | "video" | "audio" | "scene",
            filename: String(asset.filename),
            filePath: asset.file_path as string | undefined,
            prompt: asset.prompt as string | undefined,
            model: asset.model as string | undefined,
            tags,
            source: String(asset.source ?? "generated"),
            durationSeconds: asset.duration_seconds as number | undefined,
            width: asset.width as number | undefined,
            height: asset.height as number | undefined,
            visibility:
              newVisibility as import("../knowledge/types.js").KnowledgeVisibility,
            category:
              newCategory as import("../knowledge/types.js").KnowledgeCategory,
          })
          .catch((err) => {
            logger.warn(
              `[QueueAPI] RAG re-ingest failed for ${req.params.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      res.json({ ok: true, visibility: newVisibility, category: newCategory });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── PATCH /assets/:id/folder — Move asset to folder ────
  router.patch("/assets/:id/folder", (req, res) => {
    try {
      const { folder } = req.body as { folder?: string | null };
      if (
        folder !== null &&
        folder !== undefined &&
        typeof folder !== "string"
      ) {
        res.status(400).json({ error: "folder must be a string or null" });
        return;
      }
      const asset = repo.getAsset(req.params.id);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      const sanitized = folder
        ? folder
            .trim()
            .replace(/[<>:"|?*]/g, "")
            .slice(0, 100)
        : null;
      repo.updateAssetFolder(req.params.id, sanitized);
      res.json({ ok: true, folder: sanitized });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── PATCH /assets/:id/rename — Rename an asset ──────────
  router.patch("/assets/:id/rename", (req, res) => {
    try {
      const { filename } = req.body;
      if (!filename || typeof filename !== "string") {
        res.status(400).json({ error: "filename is required" });
        return;
      }
      const safeName = path.basename(filename);
      const asset = repo.getAsset(req.params.id);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      repo.renameAsset(req.params.id, safeName);
      res.json({ ok: true, filename: safeName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── PATCH /assets/:id/description — Update asset description/prompt ──
  router.patch("/assets/:id/description", async (req, res) => {
    try {
      const { prompt } = req.body as { prompt?: string };
      if (typeof prompt !== "string") {
        res.status(400).json({ error: "prompt is required" });
        return;
      }
      const asset = repo.getAsset(req.params.id);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      repo.updateAssetDescription(req.params.id, prompt);
      // Re-ingest into RAG with updated description
      if (knowledgeService) {
        const tags = asset.tags
          ? (JSON.parse(String(asset.tags)) as string[])
          : [];
        void knowledgeService
          .ingestAsset({
            id: req.params.id,
            type: asset.type as "image" | "video" | "audio" | "scene",
            filename: String(asset.filename),
            filePath: asset.file_path as string | undefined,
            prompt: prompt || undefined,
            model: asset.model as string | undefined,
            tags,
            source: String(asset.source ?? "generated"),
            durationSeconds: asset.duration_seconds as number | undefined,
            width: asset.width as number | undefined,
            height: asset.height as number | undefined,
            visibility: asset.knowledge_visibility as
              | import("../knowledge/types.js").KnowledgeVisibility
              | undefined,
            category: asset.knowledge_category as
              | import("../knowledge/types.js").KnowledgeCategory
              | undefined,
          })
          .catch((err) => {
            logger.warn(
              `[QueueAPI] RAG re-ingest failed after description update for ${req.params.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
      res.json({ ok: true, prompt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /assets/upload — Upload a file directly to gallery ──
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB decoded limit
  const ALLOWED_UPLOAD_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/wav",
    "audio/mp3",
    "audio/mpeg",
    "audio/ogg",
    "audio/flac",
  ]);

  router.post("/assets/upload", async (req, res) => {
    try {
      const { filename, data_base64, mime_type, tags, projectId } = req.body;

      if (!filename || !data_base64 || !mime_type) {
        res
          .status(400)
          .json({ error: "filename, data_base64, and mime_type are required" });
        return;
      }

      // Validate MIME type against allowlist
      if (!ALLOWED_UPLOAD_MIMES.has(mime_type)) {
        res.status(400).json({
          error: `Unsupported MIME type: ${mime_type}. Allowed: ${[...ALLOWED_UPLOAD_MIMES].join(", ")}`,
        });
        return;
      }

      await ensureGalleryDir();
      const buffer = Buffer.from(data_base64, "base64");

      // Validate decoded file size
      if (buffer.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({
          error: `File too large: ${buffer.length} bytes exceeds ${MAX_UPLOAD_BYTES} byte limit`,
        });
        return;
      }

      const safeName = path.basename(filename);
      const filePath = path.join(
        GALLERY_DIR,
        `upload-${Date.now()}-${safeName}`,
      );
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

      // Ingest uploaded asset into RAG
      if (knowledgeService) {
        void knowledgeService
          .ingestAsset({
            id: assetId,
            type: assetType,
            filename: safeName,
            filePath,
            tags: Array.isArray(tags) ? tags : undefined,
            source: "uploaded",
          })
          .catch((err) => {
            logger.warn(
              `[QueueAPI] RAG ingest failed for uploaded asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

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
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeName}"`,
        );
      }
      res.sendFile(resolved);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // ── GET /assets/:id/file — Serve any gallery asset by ID (supports external paths) ──
  router.get("/assets/:id/file", async (req, res) => {
    try {
      const asset = repo.getAsset(req.params.id);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }

      const filePath = asset.file_path as string;
      // Restrict to paths within the user's home dir to prevent SSRF/path traversal
      const resolved = path.resolve(filePath);
      const homeDir = path.resolve(os.homedir());
      if (!resolved.startsWith(homeDir)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      await fs.access(resolved);
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      const safeName = path.basename(resolved);
      if (req.query.download === "1") {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeName}"`,
        );
      }
      res.sendFile(resolved);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // ── POST /assets/scenes — Save a scene (TimelineEntry JSON) as a gallery asset ──
  router.post("/assets/scenes", async (req, res) => {
    try {
      const { scene, title, draftId } = req.body as {
        scene?: Record<string, unknown>;
        title?: string;
        draftId?: string;
      };
      if (!scene || typeof scene !== "object") {
        res.status(400).json({ error: "scene object is required" });
        return;
      }

      const sceneDir = path.join(
        os.homedir(),
        ".openzigs",
        "gallery",
        "scenes",
      );
      await fs.mkdir(sceneDir, { recursive: true });

      const filename = `scene-${Date.now()}.json`;
      const filePath = path.join(sceneDir, filename);
      await fs.writeFile(filePath, JSON.stringify(scene, null, 2), "utf-8");

      const generationParams: Record<string, unknown> = {};
      if (scene.src && typeof scene.src === "string") {
        generationParams.previewSrc = scene.src;
      }
      if (draftId && typeof draftId === "string") {
        generationParams.draftId = draftId;
      }

      const id = repo.createAsset({
        type: "scene",
        filename,
        filePath,
        mimeType: "application/json",
        fileSizeBytes: Buffer.byteLength(JSON.stringify(scene)),
        source: "director",
        prompt:
          title ||
          (scene.title as string) ||
          (scene.scriptText as string)?.slice(0, 100) ||
          "Saved scene",
        tags: ["scene"],
        ...(Object.keys(generationParams).length > 0
          ? { generationParams }
          : {}),
      });

      // Ingest scene into RAG
      if (knowledgeService) {
        void knowledgeService
          .ingestAsset({
            id,
            type: "scene",
            filename,
            filePath,
            prompt: title || (scene.title as string) || "Saved scene",
            source: "director",
            tags: ["scene"],
          })
          .catch((err) => {
            logger.warn(
              `[QueueAPI] RAG ingest failed for scene ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      res.json({ id, filename, filePath });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Queue API] POST /assets/scenes failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /assets/scenes/:id/data — Load a saved scene's JSON data ──
  router.get("/assets/scenes/:id/data", async (req, res) => {
    try {
      const asset = repo.getAsset(req.params.id);
      if (!asset || asset.type !== "scene") {
        res.status(404).json({ error: "Scene not found" });
        return;
      }

      const filePath = asset.file_path as string;
      const resolved = path.resolve(filePath);
      const homeDir = path.resolve(os.homedir());
      if (!resolved.startsWith(homeDir)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      const content = await fs.readFile(resolved, "utf-8");
      const scene = JSON.parse(content);
      res.json({ scene, asset });
    } catch {
      res.status(404).json({ error: "Scene file not found" });
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
      const { prompt, provider, imageModel, width, height, steps, seed } =
        req.body as {
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

      const { ImageGenService } =
        await import("../video/generators/image-gen-service.js");
      await ensureGalleryDir();
      const userConfig = await ImageGenService.loadUserImageGenConfig();
      const imageService = new ImageGenService({
        outputDir: GALLERY_DIR,
        ...userConfig,
      });
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
      const modelLabel =
        result.provider === "cloud"
          ? "imagen-3"
          : (imageModel ?? "flux-schnell");

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
        generationParams: {
          provider: result.provider,
          seed,
          generationTimeMs: result.generationTimeMs,
        },
        source: "generated",
      });

      logger.info(
        `[QueueAPI] Cloud image generated: ${filename} via ${result.provider} in ${result.generationTimeMs}ms → asset ${assetId}`,
      );

      // Ingest into RAG
      if (knowledgeService) {
        void knowledgeService
          .ingestAsset({
            id: assetId,
            type: "image",
            filename,
            filePath: result.filePath,
            prompt: prompt.trim(),
            model: modelLabel,
            source: "generated",
            width: result.width || undefined,
            height: result.height || undefined,
          })
          .catch((err) => {
            logger.warn(
              `[QueueAPI] RAG ingest failed for cloud image ${assetId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      res.status(201).json({
        assetId,
        provider: result.provider,
        model: modelLabel,
        filename,
      });
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
      if (node !== "image-gen" && node !== "m2-pro") {
        res
          .status(400)
          .json({ error: "Invalid node. Must be 'image-gen' or 'm2-pro'" });
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
  // Body: { targetNode: "image-gen"|"m2-pro"|"local", model?: "flux-schnell" }
  router.post("/nodes/switch", async (req, res) => {
    try {
      const { targetNode, model } = req.body as {
        targetNode?: string;
        model?: string;
      };

      if (
        !targetNode ||
        (targetNode !== "image-gen" &&
          targetNode !== "m2-pro" &&
          targetNode !== "local")
      ) {
        res.status(400).json({
          error: "targetNode must be 'image-gen', 'm2-pro', or 'local'",
        });
        return;
      }

      const result = await queueMaster.switchActiveNode(
        targetNode as TargetNode,
        model,
      );
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
