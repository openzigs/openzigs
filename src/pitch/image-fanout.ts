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
import {
  resolveImageStyle,
  type ImageStyle,
} from "./image-style-prompts.js";
import { refreshFluxQRecommendedDims } from "./fluxq-recommended-dims.js";

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
   * Deck-level image-style preset (sub-issue #998). Per-slide
   * `slide.image_style` overrides this when set; otherwise every enqueue
   * uses this prefix. Undefined = no preset.
   */
  imageStyle?: ImageStyle;
  /**
   * Issue #1007 — when true, slides without an explicit
   * `background_image_prompt` get a fallback prompt derived from the
   * slide's title/heading/quote so every slide has a background image.
   * The API layer sets this for both auto-fan-out (after deck draft) and
   * the manual `generate-all` endpoint. Defaults to false.
   *
   * Templates listed in {@link SKIP_FALLBACK_BG_TEMPLATES} are exempted
   * from this even when the flag is on — those templates are visually
   * better served by inline imagery or the title text itself, and
   * background images on them tend to ghost into the foreground text.
   */
  deriveFallbackBackgrounds?: boolean;
  /** Slide IDs that already have a persisted background asset. */
  existingBackgroundSlideIds?: ReadonlySet<string>;
  /**
   * Optional FluxQ model override threaded into every `enqueueSlideImage`
   * call (e.g. `flux-schnell` for fast / low fidelity, `flux-dev` for
   * higher quality). When omitted, `enqueueSlideImage` falls back to its
   * default `flux-schnell`.
   */
  imageModel?: string;
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
  /** Per-slide override (already resolved); deck-level applied in caller. */
  perSlideStyle?: ImageStyle;
  /** Target render width in pixels (slot-aware default). */
  width: number;
  /** Target render height in pixels (slot-aware default). */
  height: number;
}

/**
 * Templates that should NOT receive an auto-derived fallback background
 * even when `deriveFallbackBackgrounds` is enabled. These templates
 * either have stronger non-background image options (`two_column`,
 * `bullet_list`, `image_caption`) or ARE the visual hero themselves
 * (`title`, `quote`, `qa`) — adding a generated bg over them ghosts the
 * literal title text into the slide pixels and obscures the foreground
 * content.
 *
 * Background fallback DOES still apply for: `section_divider`,
 * `full_bleed`, `closing` (not in this set), and the explicit
 * hand-authored `background_image_prompt` is honoured for every template.
 *
 * Adjust this list rather than editing call sites — every fan-out path
 * funnels through `planImageJobs`.
 */
export const SKIP_FALLBACK_BG_TEMPLATES: ReadonlySet<string> = new Set([
  "title",
  "two_column",
  "bullet_list",
  "image_caption",
  "quote",
  "qa",
]);

/**
 * Slot-aware target dimensions (16:9 unless slot is portrait/square).
 * `clampToFluxQRecommendedDims` may pull these down further if the FluxQ
 * sidecar advertises a smaller cap.
 */
function targetDimsForSlot(
  template: string,
  slot: ImageSlot,
  kind: "image" | "background",
): { width: number; height: number } {
  if (kind === "background") return { width: 1920, height: 1080 };
  if (template === "two_column" && (slot === "left_image" || slot === "right_image")) {
    return { width: 960, height: 1080 };
  }
  if (template === "image_caption") return { width: 1280, height: 720 };
  if (template === "full_bleed") return { width: 1920, height: 1080 };
  // bullet_list inline image — narrower 4:3-ish thumbnail.
  return { width: 1280, height: 960 };
}

/** Pure: scan a deck and return the list of jobs that *would* be enqueued. */
export function planImageJobs(
  slides: SlideForFanout[],
  opts: {
    deriveFallbackBackgrounds?: boolean;
    existingBackgroundSlideIds?: ReadonlySet<string>;
  } = {},
): {
  plan: PlannedJob[];
  skipped: number;
} {
  const plan: PlannedJob[] = [];
  let skipped = 0;

  for (const { id: slideId, slide } of slides) {
    const perSlideStyle = slide.image_style;
    const template = slide.template;
    // 1. Background prompt (any template).
    // Issue #1007 — when `deriveFallbackBackgrounds` is enabled and the
    // AI/user did not emit a background prompt, derive a fallback so
    // every slide gets a background image. Disabled by default to
    // preserve the historical "opt-in only" semantics that existing
    // call sites rely on.
    //
    // Issue (2026-05): templates listed in SKIP_FALLBACK_BG_TEMPLATES
    // are exempted from the *fallback* derivation (they still honour an
    // explicit hand-authored prompt) so we don't ghost titles into bg
    // pixels or fight inline imagery for visual attention.
    let bgPrompt = slide.background_image_prompt?.trim();
    if (
      (!bgPrompt || bgPrompt.length < 3) &&
      opts.deriveFallbackBackgrounds &&
      !SKIP_FALLBACK_BG_TEMPLATES.has(template)
    ) {
      const derived = deriveFallbackBackgroundPrompt(slide);
      if (derived) bgPrompt = derived;
    }
    if (bgPrompt && bgPrompt.length >= 3) {
      if (opts.existingBackgroundSlideIds?.has(slideId)) {
        skipped += 1;
      } else {
      // Background prompts have no URL slot to check — schema doesn't
        // expose a persisted background URL. Callers that can cheaply look
        // up pitch_assets pass existingBackgroundSlideIds so repeated bulk
        // requests do not enqueue unbounded duplicate background jobs.
        const dims = targetDimsForSlot(template, "image", "background");
        plan.push({
          slideId,
          slot: "image",
          kind: "background",
          prompt: bgPrompt,
          width: dims.width,
          height: dims.height,
          ...(perSlideStyle ? { perSlideStyle } : {}),
        });
      }
    }

    // 2. Inline image slots, by template.
    if (slide.template === "bullet_list") {
      const img = slide.content.image;
      if (img && shouldEnqueueImage(img)) {
        const dims = targetDimsForSlot("bullet_list", "image", "image");
        plan.push({
          slideId,
          slot: "image",
          kind: "image",
          prompt: img.prompt,
          width: dims.width,
          height: dims.height,
          ...(perSlideStyle ? { perSlideStyle } : {}),
        });
      } else if (img) {
        skipped += 1;
      }
    } else if (slide.template === "two_column") {
      const left = slide.content.left_image;
      const right = slide.content.right_image;
      if (left && shouldEnqueueImage(left)) {
        const dims = targetDimsForSlot("two_column", "left_image", "image");
        plan.push({
          slideId,
          slot: "left_image",
          kind: "image",
          prompt: left.prompt,
          width: dims.width,
          height: dims.height,
          ...(perSlideStyle ? { perSlideStyle } : {}),
        });
      } else if (left) {
        skipped += 1;
      }
      if (right && shouldEnqueueImage(right)) {
        const dims = targetDimsForSlot("two_column", "right_image", "image");
        plan.push({
          slideId,
          slot: "right_image",
          kind: "image",
          prompt: right.prompt,
          width: dims.width,
          height: dims.height,
          ...(perSlideStyle ? { perSlideStyle } : {}),
        });
      } else if (right) {
        skipped += 1;
      }
    } else if (slide.template === "image_caption") {
      const img = slide.content.image;
      if (shouldEnqueueImage(img)) {
        const dims = targetDimsForSlot("image_caption", "image", "image");
        plan.push({
          slideId,
          slot: "image",
          kind: "image",
          prompt: img.prompt,
          width: dims.width,
          height: dims.height,
          ...(perSlideStyle ? { perSlideStyle } : {}),
        });
      } else {
        skipped += 1;
      }
    } else if (slide.template === "full_bleed") {
      const img = slide.content.image;
      if (shouldEnqueueImage(img)) {
        const dims = targetDimsForSlot("full_bleed", "image", "image");
        plan.push({
          slideId,
          slot: "image",
          kind: "image",
          prompt: img.prompt,
          width: dims.width,
          height: dims.height,
          ...(perSlideStyle ? { perSlideStyle } : {}),
        });
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
 * Negative-style suffix appended to every derived fallback background
 * prompt to discourage FluxQ from baking literal text / typography into
 * the image pixels (which produces the "ghost title" artefact).
 */
const FALLBACK_BG_NEGATIVE_TOKENS =
  ", no text, no typography, no letters, no captions, no words, abstract only";

/** Common stop words filtered out when distilling a slide's text into bg keywords. */
const STOP_WORDS = new Set([
  "a", "an", "and", "or", "but", "the", "of", "in", "on", "at", "to", "for",
  "with", "from", "by", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "we", "us", "our", "you",
  "your", "they", "their", "i", "me", "my", "as", "if", "than", "then",
  "so", "do", "does", "did", "have", "has", "had", "will", "would",
  "could", "should", "can", "may", "might", "must", "shall", "what",
  "when", "where", "why", "how", "who", "which",
]);

/**
 * Derive an abstract, text-free background prompt from a slide's most
 * descriptive text field (title / heading / caption / quote).
 *
 * Returns a string that NEVER contains the literal slide text — only one
 * or two extracted keyword "concepts" — and ALWAYS appends explicit
 * negative-text tokens so FluxQ doesn't ghost the heading text into the
 * image pixels behind the rendered slide.
 *
 * If no usable text is found, falls back to a pure-abstract prompt
 * (instead of returning `undefined` like the prior implementation) so the
 * caller still gets a usable bg.
 *
 * Pure / no dependencies; deterministic for a given slide.
 *
 * Exported for unit testing.
 */
export function deriveFallbackBackgroundPrompt(
  slide: Slide,
): string | undefined {
  const c = slide.content as Record<string, unknown>;
  const candidates: Array<unknown> = [
    c.title,
    c.heading,
    c.subtitle,
    c.caption,
    c.overlay_text,
    c.quote,
  ];
  let source: string | undefined;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length < 3) continue;
    source = trimmed;
    break;
  }

  // Always append the same negative-text tail so FluxQ avoids baking
  // typography into the pixels.
  const ABSTRACT_FALLBACK =
    "Abstract conceptual background, soft gradient, generous negative space, readable behind bold headline text";

  if (!source) {
    return `${ABSTRACT_FALLBACK}${FALLBACK_BG_NEGATIVE_TOKENS}`;
  }

  // Distill at most 2 short content keywords from the source text. We
  // intentionally drop punctuation, numbers, and very short tokens so
  // FluxQ doesn't latch onto them as text-rendering hints.
  const keywords = source
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 2);

  if (keywords.length === 0) {
    return `${ABSTRACT_FALLBACK}${FALLBACK_BG_NEGATIVE_TOKENS}`;
  }

  return `Abstract conceptual background evoking ${keywords.join(" and ")}, soft gradient, generous negative space, readable behind bold headline text${FALLBACK_BG_NEGATIVE_TOKENS}`;
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
  const { plan, skipped } = planImageJobs(opts.slides, {
    deriveFallbackBackgrounds: opts.deriveFallbackBackgrounds === true,
    existingBackgroundSlideIds: opts.existingBackgroundSlideIds,
  });

  // Bug-fix (post-PR-#1017 walkthrough): probe FluxQ's `/health` once
  // before the worker pool starts so every `enqueueSlideImage` call below
  // observes the cached `recommended_width`/`recommended_height` ceiling.
  // The probe is best-effort; failure falls through to FLUXQ_FALLBACK_DIMS
  // so we never block the fan-out on a sidecar hiccup.
  await refreshFluxQRecommendedDims().catch(() => {
    /* swallow — clamp helper falls back to safe defaults */
  });

  let cursor = 0;
  let enqueued = 0;

  const worker = async (): Promise<void> => {
    while (cursor < plan.length) {
      const idx = cursor;
      cursor += 1;
      const job = plan[idx];
      if (!job) return;
      try {
        const effectiveStyle = resolveImageStyle(
          job.perSlideStyle,
          opts.imageStyle,
        );
        const result = enqueueSlideImage({
          deckId: opts.deckId,
          slideId: job.slideId,
          prompt: job.prompt,
          kind: job.kind,
          slot: job.slot,
          width: job.width,
          height: job.height,
          mediaQueueRepo: opts.mediaQueueRepo,
          ...(opts.characterRepo ? { characterRepo: opts.characterRepo } : {}),
          ...(effectiveStyle ? { imageStyle: effectiveStyle } : {}),
          ...(opts.imageModel ? { preferredModel: opts.imageModel } : {}),
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
