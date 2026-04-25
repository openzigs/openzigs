/**
 * Pitch — FluxQ image enqueue + asset persistence.
 *
 * Sub-issue #958 (Epic #951). Two surfaces:
 *
 *   1. {@link enqueueSlideImage} — enqueue an FluxQ txt2img job for a
 *      slide's inline image OR background. ALWAYS calls
 *      `injectCharacterLora` before submitting so trigger words in the
 *      prompt resolve to the right LoRA adapter (Epic #868 contract).
 *
 *   2. {@link registerImageCompletionListener} — subscribe to the
 *      QueueMaster `job:complete` event. When a job we previously enqueued
 *      finishes successfully, copy the result file into
 *      `~/.openzigs/pitch/assets/{deckId}/{assetId}.{ext}`, persist a
 *      `pitch_assets` row, and (for inline images) patch the slide's
 *      content slot with the new URL.
 *
 * The bookkeeping that connects "this jobId was a Pitch image" lives in a
 * module-scope `Map` because the MediaJob payload schema doesn't carry
 * arbitrary metadata. The map is intentionally in-process: jobs in flight
 * across server restarts will not auto-complete (acceptable for Phase 2;
 * Phase 3 can promote this to a SQLite table if needed).
 */
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { CharacterRepository } from "../characters/character-repository.js";
import type { AuditLogger } from "../logging/audit-logger.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type { QueueMaster } from "../queue/queue-master.js";
import type { MediaJob, MediaJobPayload } from "../queue/types.js";
import type { PitchRepository } from "./pitch-repository.js";
import type { Slide, SlideAsset } from "./pitch-schema.js";
import { injectCharacterLora } from "../api/inject-character-lora.js";

/** Slots inside a slide's `content` object that can hold a `SlideImage`. */
export type ImageSlot = "image" | "left_image" | "right_image";

/** What kind of pitch asset is being generated. */
export type PitchImageKind = "image" | "background";

export interface EnqueueSlideImageOpts {
  deckId: string;
  slideId: string;
  prompt: string;
  /** Whether this is an inline image or a slide background. */
  kind: PitchImageKind;
  /** Inline-image slot to patch when complete (kind === "image" only). Defaults to `"image"`. */
  slot?: ImageSlot;
  /** Width — defaults to 1920 for inline, 1920 for background (16:9). */
  width?: number;
  /** Height — defaults to 1080 for inline, 1080 for background (16:9). */
  height?: number;
  /** FluxQ model — defaults to "flux-schnell". */
  preferredModel?: string;
  /** Optional generation seed for reproducibility. */
  seed?: number;
  mediaQueueRepo: MediaQueueRepository;
  characterRepo?: CharacterRepository;
  /** Project ID for queue grouping (falls back to `pitch:{deckId}`). */
  projectId?: string;
}

export interface EnqueueSlideImageResult {
  jobId: string;
  assetId: string;
  /** The mutated payload that was submitted (post-LoRA injection). */
  payload: MediaJobPayload;
}

/** In-flight tracking record. */
interface PitchJobBinding {
  deckId: string;
  slideId: string;
  assetId: string;
  kind: PitchImageKind;
  slot: ImageSlot;
  prompt: string;
}

/**
 * Module-scope map from MediaJob.id → Pitch job context. Populated by
 * {@link enqueueSlideImage} and consumed by the completion listener.
 */
const pendingPitchJobs = new Map<string, PitchJobBinding>();

/** Test/teardown hook — clears pending bindings between specs. */
export function _resetPendingPitchJobsForTest(): void {
  pendingPitchJobs.clear();
}

/** Inspect a binding by jobId (used by tests). */
export function _peekPitchJobBindingForTest(jobId: string): PitchJobBinding | undefined {
  return pendingPitchJobs.get(jobId);
}

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_MODEL = "flux-schnell";

/**
 * Enqueue a single image-generation job tied to a Pitch slide.
 *
 * Order of operations is significant:
 *   1. Build the txt2img payload with the user/LLM prompt.
 *   2. Call `injectCharacterLora` so trigger words → LoRA adapters.
 *   3. Call `mediaQueueRepo.createJob({ type: "txt2img", payload, model })`.
 *   4. Track jobId → { deckId, slideId, assetId } in the pending map.
 *
 * Step 2 MUST run before step 3; otherwise the LoRA inference base-model
 * override (set by `injectCharacterLora`) is lost.
 */
export function enqueueSlideImage(opts: EnqueueSlideImageOpts): EnqueueSlideImageResult {
  if (!opts.prompt || opts.prompt.trim().length === 0) {
    throw new Error("enqueueSlideImage: prompt is required");
  }
  const slot: ImageSlot = opts.slot ?? "image";
  const assetId = randomUUID();

  const payload: MediaJobPayload = {
    prompt: opts.prompt,
    width: opts.width ?? DEFAULT_WIDTH,
    height: opts.height ?? DEFAULT_HEIGHT,
  };
  if (opts.seed !== undefined) {
    payload.seed = opts.seed;
  }

  // Step 2 — LoRA injection BEFORE createJob.
  injectCharacterLora(payload, opts.characterRepo);

  // Step 3 — submit the job.
  const job = opts.mediaQueueRepo.createJob({
    type: "txt2img",
    payload,
    model: opts.preferredModel ?? DEFAULT_MODEL,
    projectId: opts.projectId ?? `pitch:${opts.deckId}`,
  });

  // Step 4 — remember the binding so the completion listener can persist.
  pendingPitchJobs.set(job.id, {
    deckId: opts.deckId,
    slideId: opts.slideId,
    assetId,
    kind: opts.kind,
    slot,
    prompt: opts.prompt,
  });

  return { jobId: job.id, assetId, payload };
}

// ── Completion listener ────────────────────────────────────────────────

export interface RegisterImageCompletionOpts {
  queueMaster: Pick<QueueMaster, "on" | "off">;
  pitchRepo: PitchRepository;
  /** Optional logger — failures are written here at category `system`. */
  auditLogger?: Pick<AuditLogger, "log">;
  /** Override clock for deterministic timestamps. */
  clock?: () => Date;
  /** Override the assets root (defaults to `~/.openzigs/pitch/assets`). */
  baseDir?: string;
}

export interface ImageCompletionRegistration {
  /** Detach the listener. */
  dispose(): void;
  /**
   * Wait for all in-flight `job:complete` handlers to finish. Test-only
   * helper; production code should not depend on this draining.
   */
  flush(): Promise<void>;
}

/**
 * Subscribe to `queueMaster.on("job:complete")`. Only jobs that were
 * registered via {@link enqueueSlideImage} are processed; foreign jobs are
 * silently ignored. Returns a `dispose()` for teardown.
 */
export function registerImageCompletionListener(
  opts: RegisterImageCompletionOpts,
): ImageCompletionRegistration {
  const inFlight = new Set<Promise<void>>();

  const handler = (job: MediaJob): void => {
    const p = handleJobComplete(job, opts).finally(() => {
      inFlight.delete(p);
    });
    inFlight.add(p);
  };

  opts.queueMaster.on("job:complete", handler);
  return {
    dispose: () => {
      opts.queueMaster.off("job:complete", handler);
    },
    flush: async () => {
      // Drain in waves: handlers may queue further work synchronously.
      while (inFlight.size > 0) {
        await Promise.allSettled(Array.from(inFlight));
      }
    },
  };
}

async function handleJobComplete(
  job: MediaJob,
  opts: RegisterImageCompletionOpts,
): Promise<void> {
  const binding = pendingPitchJobs.get(job.id);
  if (!binding) return; // Not one of ours.
  pendingPitchJobs.delete(job.id);

  if (job.status !== "complete" || !job.resultUrl) {
    await safeAudit(opts.auditLogger, {
      event: "pitch.image.job_did_not_succeed",
      deckId: binding.deckId,
      slideId: binding.slideId,
      jobId: job.id,
      status: job.status,
    });
    return;
  }

  try {
    await persistCompletedAsset(job, binding, opts);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await safeAudit(opts.auditLogger, {
      event: "pitch.image.persist_failed",
      deckId: binding.deckId,
      slideId: binding.slideId,
      jobId: job.id,
      error,
    });
    // Listener must NOT throw — that would crash the EventEmitter loop.
  }
}

async function persistCompletedAsset(
  job: MediaJob,
  binding: PitchJobBinding,
  opts: RegisterImageCompletionOpts,
): Promise<void> {
  const baseDir = opts.baseDir ?? join(homedir(), ".openzigs", "pitch", "assets");
  const sourcePath = resolveSourcePath(job.resultUrl as string);
  const ext = (extname(sourcePath) || ".png").toLowerCase();
  const targetDir = join(baseDir, binding.deckId);
  const targetPath = join(targetDir, `${binding.assetId}${ext}`);

  await mkdir(targetDir, { recursive: true });
  await copyFile(sourcePath, targetPath);

  // Read intrinsic dimensions — fall back to the requested size if sharp
  // can't decode (corrupt image).
  let width = (job.payload.width as number | undefined) ?? DEFAULT_WIDTH;
  let height = (job.payload.height as number | undefined) ?? DEFAULT_HEIGHT;
  try {
    const meta = await sharp(targetPath).metadata();
    if (typeof meta.width === "number" && meta.width > 0) width = meta.width;
    if (typeof meta.height === "number" && meta.height > 0) height = meta.height;
  } catch {
    // keep fallbacks
  }

  const mime = mimeFromExt(ext);
  const clock = opts.clock ?? (() => new Date());

  const assetRecord: SlideAsset = {
    id: binding.assetId,
    deck_id: binding.deckId,
    slide_id: binding.slideId,
    kind: binding.kind === "background" ? "background" : "image",
    source: "fluxq",
    prompt: binding.prompt,
    local_path: targetPath,
    mime,
    width,
    height,
    created_at: clock().toISOString(),
  };

  try {
    opts.pitchRepo.insertAsset(assetRecord);
  } catch (err) {
    // If the insert fails (e.g. FK violation: deck got deleted mid-flight),
    // remove the orphaned file we just copied so disk doesn't leak.
    await rm(targetPath, { force: true }).catch(() => {});
    // Best-effort: drop the deck dir if we just created it and it's empty.
    try {
      const s = await stat(targetDir);
      if (s.isDirectory()) {
        const remaining = await import("node:fs/promises").then((m) => m.readdir(targetDir));
        if (remaining.length === 0) {
          await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // ignore
    }
    throw err;
  }

  // Inline image — patch the slide content's image slot URL. Skipped for
  // backgrounds (which are tracked purely via the asset row).
  if (binding.kind === "image") {
    patchSlideImageSlot(opts.pitchRepo, binding, targetPath, opts.auditLogger);
  }
}

function patchSlideImageSlot(
  pitchRepo: PitchRepository,
  binding: PitchJobBinding,
  targetPath: string,
  auditLogger?: Pick<AuditLogger, "log">,
): void {
  const slideRecord = pitchRepo.getSlide(binding.slideId);
  if (!slideRecord) return; // Slide deleted between enqueue and completion.

  const fileUrl = pathToFileURL(targetPath).toString();
  const content = slideRecord.slide.content as Record<string, unknown>;
  const slotValue = content[binding.slot];

  if (!slotValue || typeof slotValue !== "object") {
    // The current template doesn't carry this slot. Asset row is still
    // persisted; renderer can look it up by slide_id.
    void safeAudit(auditLogger, {
      event: "pitch.image.slot_absent",
      deckId: binding.deckId,
      slideId: binding.slideId,
      slot: binding.slot,
      template: slideRecord.slide.template,
    });
    return;
  }

  const updatedSlot: Record<string, unknown> = {
    ...(slotValue as Record<string, unknown>),
    url: fileUrl,
  };
  // Ensure required SlideImage fields are populated even if the slot was
  // a partially-built stub.
  const existingPrompt = updatedSlot.prompt;
  if (typeof existingPrompt !== "string" || existingPrompt.length < 3) {
    updatedSlot.prompt = binding.prompt;
  }
  if (typeof updatedSlot.alt !== "string") {
    updatedSlot.alt = "";
  }

  const newContent = { ...content, [binding.slot]: updatedSlot };
  const newSlide = { ...slideRecord.slide, content: newContent } as Slide;

  try {
    pitchRepo.updateSlide(binding.slideId, { slide: newSlide });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    void safeAudit(auditLogger, {
      event: "pitch.image.slide_update_failed",
      deckId: binding.deckId,
      slideId: binding.slideId,
      slot: binding.slot,
      error,
    });
    // Asset row is still good; only the inline link is missing.
  }
}

function resolveSourcePath(resultUrl: string): string {
  if (resultUrl.startsWith("file://")) {
    return new URL(resultUrl).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  }
  return resultUrl;
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

async function safeAudit(
  auditLogger: Pick<AuditLogger, "log"> | undefined,
  details: Record<string, unknown> & { event: string },
): Promise<void> {
  if (!auditLogger) return;
  try {
    await auditLogger.log({
      level: "warn",
      category: "system",
      event: details.event,
      details,
    });
  } catch {
    // Never throw out of the listener.
  }
}

