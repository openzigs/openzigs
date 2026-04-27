/**
 * Pitch — fan-out helper that walks a deck and enqueues one flux image
 * job per slide image-slot that has a non-empty prompt and no URL yet.
 *
 * Sub-issue #995 (Phase 1, Epic #990). Reused by:
 *   - the `/decks/draft` handler (auto-fan-out on deck create)
 *   - the `/decks/:deckId/images/generate-all` handler (#991 idempotent
 *     bulk button)
 *
 * Concurrency is capped via a tiny in-house semaphore — no new dep. The
 * helper is *fire-and-forget* from the caller's perspective: it returns a
 * `Promise<{ enqueued, skipped, total }>` after the FIRST createJob call
 * for every slot has resolved, NOT after the flux jobs themselves finish.
 * Flux completion is observed via Socket.IO events from
 * `pitch-image-service`'s completion listener — the UI subscribes there.
 *
 * Slots scanned (in declaration order so output is deterministic):
 *   - `Common.background_image_prompt`     (every template)
 *   - `bullet_list.content.image`          (optional)
 *   - `two_column.content.left_image`      (optional)
 *   - `two_column.content.right_image`     (optional)
 *   - `image_caption.content.image`        (required by schema)
 *   - `full_bleed.content.image`           (required by schema)
 *
 * A slot is enqueued when:
 *   1. The prompt is a non-empty string (≥3 chars, matches schema)
 *   2. The corresponding URL is missing/null/empty
 *
 * Slides whose prompt+url are both already populated are counted as
 * `skipped`. This makes the bulk button safe to click repeatedly.
 */
import type { CharacterRepository } from "../characters/character-repository.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type { Slide, SlideImage } from "./pitch-schema.js";
import { enqueueSlideImage, type ImageSlot } from "./pitch-image-service.js";

/** A persisted slide carries both the SlideRecord identity and the Slide payload. */
export interface SlideForFanout {
  id: string;
  slide: Slide;
}

export interface FanOutImageGenerationOpts {
  deckId: string;
  slides: SlideForFanout[];
  mediaQueueRepo: MediaQueueRepository;
  characterRepo?: CharacterRepository;
  /** Per-deck cap on simultaneous in-flight createJob calls. Defaults to 4. */
  concurrency?: number;
  /**
   * Optional hook invoked synchronously after each successful enqueue.
   * Used by the API layer to emit `pitch:image:queued` and audit log.
   */
  onEnqueued?: (info: {
    slideId: string;
    slot: ImageSlot | "background";
    jobId: string;
    assetId: string;
  }) => void;
  /**
   * Optional hook invoked when an enqueue throws. Used by the API layer
   * to audit-log the failure. The fan-out itself swallows the error so
   * one bad slot does not abort the whole batch.
   */
  onEnqueueError?: (info: {
    slideId: string;
    slot: ImageSlot | "background";
    error: string;
  }) => void;
}

export interface FanOutImageGenerationResult {
  enqueued: number;
  skipped: number;
  total: number;
}

/** Internal — one unit of work the fan-out plans before kicking off jobs. */
interface PlannedJob {
  slideId: string;
  slot: ImageSlot;
  kind: "image" | "background";
  prompt: string;
}

/** Pure: scan a deck and return the list of jobs that *would* be enqueued. */
export function planImageJobs(slides: SlideForFanout[]): {
  plan: PlannedJob[];
  skipped: number;
} {
  const plan: PlannedJob[] = [];
  let skipped = 0;

  for (const { id: slideId, slide } of slides) {
    // 1. Background prompt (any template).
    const bgPrompt = slide.background_image_prompt?.trim();
    if (bgPrompt && bgPrompt.length >= 3) {
      // Background prompts have no URL slot to check — schema doesn't
      // expose a persisted background URL. We always enqueue, since the
      // existence of an asset in `pitch_assets` (kind=background) is what
      // the renderer joins on, and the bulk button cannot cheaply learn
      // about that here. Idempotency for background is therefore
      // best-effort; flux jobs are cheap and the worst case is a duplicate.
      plan.push({
        slideId,
        slot: "image",
        kind: "background",
        prompt: bgPrompt,
      });
    }

    // 2. Inline image slots, by template.
    if (slide.template === "bullet_list") {
      const img = slide.content.image;
      if (img && shouldEnqueueImage(img)) {
        plan.push({ slideId, slot: "image", kind: "image", prompt: img.prompt });
      } else if (img) {
        skipped += 1;
      }
    } else if (slide.template === "two_column") {
      const left = slide.content.left_image;
      const right = slide.content.right_image;
      if (left && shouldEnqueueImage(left)) {
        plan.push({ slideId, slot: "left_image", kind: "image", prompt: left.prompt });
      } else if (left) {
        skipped += 1;
      }
      if (right && shouldEnqueueImage(right)) {
        plan.push({
          slideId,
          slot: "right_image",
          kind: "image",
          prompt: right.prompt,
        });
      } else if (right) {
        skipped += 1;
      }
    } else if (slide.template === "image_caption") {
      const img = slide.content.image;
      if (shouldEnqueueImage(img)) {
        plan.push({ slideId, slot: "image", kind: "image", prompt: img.prompt });
      } else {
        skipped += 1;
      }
    } else if (slide.template === "full_bleed") {
      const img = slide.content.image;
      if (shouldEnqueueImage(img)) {
        plan.push({ slideId, slot: "image", kind: "image", prompt: img.prompt });
      } else {
        skipped += 1;
      }
    }
  }

  return { plan, skipped };
}

function shouldEnqueueImage(img: SlideImage): boolean {
  if (typeof img.prompt !== "string") return false;
  if (img.prompt.trim().length < 3) return false;
  // Already populated — do not regenerate.
  if (typeof img.url === "string" && img.url.trim().length > 0) return false;
  return true;
}

/**
 * Walk the deck and enqueue one flux job per planned slot, capped at
 * `concurrency` in-flight calls at a time. Resolves with counts; never
 * rejects (per-slot errors are reported via `onEnqueueError`).
 */
export async function fanOutImageGeneration(
  opts: FanOutImageGenerationOpts,
): Promise<FanOutImageGenerationResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const { plan, skipped } = planImageJobs(opts.slides);

  let cursor = 0;
  let enqueued = 0;

  const worker = async (): Promise<void> => {
    while (cursor < plan.length) {
      const idx = cursor;
      cursor += 1;
      const job = plan[idx];
      if (!job) return;
      try {
        const result = enqueueSlideImage({
          deckId: opts.deckId,
          slideId: job.slideId,
          prompt: job.prompt,
          kind: job.kind,
          slot: job.slot,
          mediaQueueRepo: opts.mediaQueueRepo,
          ...(opts.characterRepo ? { characterRepo: opts.characterRepo } : {}),
        });
        enqueued += 1;
        opts.onEnqueued?.({
          slideId: job.slideId,
          slot: job.kind === "background" ? "background" : job.slot,
          jobId: result.jobId,
          assetId: result.assetId,
        });
      } catch (err) {
        opts.onEnqueueError?.({
          slideId: job.slideId,
          slot: job.kind === "background" ? "background" : job.slot,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, plan.length) }, () =>
    worker(),
  );
  await Promise.all(workers);

  return {
    enqueued,
    skipped,
    total: enqueued + skipped,
  };
}
