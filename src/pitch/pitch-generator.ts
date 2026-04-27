/**
 * Pitch — single-shot AI deck generator + per-slide regenerate primitive.
 *
 * Sub-issue #954 (Epic #951 / Studio Pitch). Mirrors the LLM→JSON pipeline
 * at `src/api/director.ts:880-898`:
 *
 *   stream chat → accumulate → strip ```json fences → JSON.parse →
 *   `DeckSchema.parse` (Zod). On failure: ONE retry with the validation
 *   error embedded in the user prompt. Second failure throws.
 *
 * Pure functions — no DB writes, no Socket.IO emits. The caller persists
 * via `pitchRepo.insertDeck()` / `pitchRepo.updateSlide()`.
 *
 * `regenerateSlide` is the single-slide variant used by the per-slide
 * regenerate task (#957). Both helpers accept a `clock?` for deterministic
 * timestamps in tests.
 */
import { nanoid } from "nanoid";
import { z } from "zod";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import { logger } from "../logging/logger.js";
import {
  DeckSchema,
  SlideSchema,
  type BrandKit,
  type Deck,
  type DeckTone,
  type Slide,
} from "./pitch-schema.js";
import {
  buildDraftSystemPrompt,
  buildRegenerateSystemPrompt,
} from "./pitch-prompts.js";
import {
  MAX_USER_SCRIPT_BYTES,
  accumulateStream,
  buildRetryHint,
  parseAndValidate,
  wrapUserScript,
} from "./pitch-utils.js";

const PITCH_AGENT_NAME = "pitch-writer";
const DEFAULT_TARGET_SLIDE_COUNT = 12;

/**
 * Hard ceiling on slides per deck. Mirrors `DeckSchema.slides.max(80)` and
 * is used as a defence-in-depth check before re-validating the model output
 * \u2014 if the model returns 200 slides, we truncate to 80 instead of feeding
 * the schema parser an oversized array.
 */
export const MAX_SLIDES_PER_DECK = 80;

export interface GenerateDeckOpts {
  /** User-supplied script text. Must be ≤50 KB (enforced before the LLM call). */
  script: string;
  /** Brand kit baked into the prompt for visual + tone guidance. */
  brandKit: BrandKit;
  /** Optional generation knobs (audience, tone, target length). */
  options?: {
    audience?: string;
    tone?: DeckTone;
    estimatedMinutes?: number;
    targetSlideCount?: number;
  };
  /** Copilot wrapper instance — mocked in tests. */
  copilot: CopilotWrapper;
  /** Optional cached SDK session id. */
  sessionId?: string;
  /** Model override. Falls back to wrapper default. */
  model?: string;
  /** Injectable clock (UTC) for deterministic created_at/updated_at in tests. */
  clock?: () => Date;
}

export interface RegenerateSlideOpts {
  /** Existing deck — used for previous/next slide context. */
  deck: Deck;
  /** Slide to regenerate (must be a member of `deck.slides` by reference or by content). */
  slide: Slide;
  /** Optional revision hint from the user ("make it punchier"). */
  hint?: string;
  /** Copilot wrapper instance — mocked in tests. */
  copilot: CopilotWrapper;
  /** Optional cached SDK session id. */
  sessionId?: string;
  /** Model override. Falls back to wrapper default. */
  model?: string;
}

/**
 * Generate a complete deck draft from a user script in one LLM call.
 *
 * Returns a fully-validated `Deck` ready to persist. Throws if:
 *   - the script exceeds {@link MAX_USER_SCRIPT_BYTES} (fast-fail before LLM)
 *   - the model produces invalid JSON twice in a row (initial + 1 retry)
 *   - the model produces JSON that fails `DeckSchema.parse` twice in a row
 */
export async function generateDeck(opts: GenerateDeckOpts): Promise<Deck> {
  // Fast-fail BEFORE we burn tokens on an oversized script.
  if (Buffer.byteLength(opts.script ?? "", "utf8") > MAX_USER_SCRIPT_BYTES) {
    throw new Error(
      `pitch: script exceeds ${MAX_USER_SCRIPT_BYTES.toLocaleString()} byte cap`,
    );
  }

  const tone: DeckTone = opts.options?.tone ?? "formal";
  const targetSlideCount =
    opts.options?.targetSlideCount ?? DEFAULT_TARGET_SLIDE_COUNT;
  const systemPrompt = buildDraftSystemPrompt(opts.brandKit, {
    targetSlideCount,
    audience: opts.options?.audience,
    tone,
  });

  const userPrompt = [
    "Convert the following user script into a deck that matches the OpenZigs DeckSchema. Output ONLY the JSON object.",
    "",
    wrapUserScript(opts.script ?? ""),
  ].join("\n");

  // Initial call \u2014 parse + validate; on failure OR slide-count mismatch
  // (when the caller asked for a specific count), retry ONCE with a
  // targeted hint. The retry budget is shared across both failure modes.
  let lastError: unknown = null;
  let lastDeck: Deck | null = null;
  let raw = await callOnce(opts, userPrompt, systemPrompt);
  try {
    const deck = assembleDeck(raw, opts);
    if (
      opts.options?.targetSlideCount === undefined ||
      deck.slides.length === targetSlideCount
    ) {
      return deck;
    }
    // Wrong slide count \u2014 fall through to retry with explicit count
    // instruction. Preserve the partial deck so a second failure can
    // still hand back something usable instead of throwing.
    lastDeck = deck;
  } catch (err) {
    lastError = err;
  }

  // Retry pass \u2014 either embed the validation error so the model can
  // self-correct, OR explicitly call out the slide-count miss.
  const retryReason =
    lastError !== null
      ? buildRetryHint(lastError)
      : `You returned ${lastDeck?.slides.length ?? "?"} slides, but I asked for exactly ${targetSlideCount}. Return EXACTLY ${targetSlideCount} slides \u2014 no more, no fewer.`;
  const retryPrompt = [userPrompt, "", retryReason].join("\n");
  raw = await callOnce(opts, retryPrompt, systemPrompt);
  try {
    const deck = assembleDeck(raw, opts);
    if (
      opts.options?.targetSlideCount !== undefined &&
      deck.slides.length !== targetSlideCount
    ) {
      logger.warn(
        `[pitch-generator] retry produced ${deck.slides.length} slides, target was ${targetSlideCount}; returning anyway`,
      );
    }
    return deck;
  } catch (err) {
    // Second attempt failed validation. If the FIRST attempt produced a
    // valid (but wrong-count) deck, hand that back rather than 500ing the
    // user \u2014 a deck with the wrong slide count is still usable.
    if (lastDeck) {
      logger.warn(
        `[pitch-generator] retry failed (${err instanceof Error ? err.message : String(err)}); returning first-pass deck with ${lastDeck.slides.length}/${targetSlideCount} slides`,
      );
      return lastDeck;
    }
    throw err;
  }
}

/**
 * Regenerate a single slide given the deck context. Returns a validated
 * `Slide`. Same retry policy as `generateDeck` (1 retry, then throw).
 *
 * The caller is responsible for persisting via `pitchRepo.updateSlide()`.
 */
export async function regenerateSlide(opts: RegenerateSlideOpts): Promise<Slide> {
  const systemPrompt = buildRegenerateSystemPrompt(
    opts.deck,
    opts.slide,
    opts.hint,
  );
  const userPrompt =
    "Emit the regenerated slide as a single JSON object conforming to the OpenZigs SlideSchema. No code fences, no commentary.";

  let lastError: unknown = null;
  let raw = await callOnceForSlide(opts, userPrompt, systemPrompt);
  try {
    return parseAndValidate(raw, SlideSchema);
  } catch (err) {
    lastError = err;
  }

  const retryPrompt = [userPrompt, "", buildRetryHint(lastError)].join("\n");
  raw = await callOnceForSlide(opts, retryPrompt, systemPrompt);
  return parseAndValidate(raw, SlideSchema);
}

// ─────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────

async function callOnce(
  opts: GenerateDeckOpts,
  userPrompt: string,
  systemPrompt: string,
): Promise<string> {
  const stream = opts.copilot.chat(userPrompt, {
    tools: [],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.sessionId ? { conversationId: opts.sessionId } : {}),
    systemMessage: { mode: "replace", content: systemPrompt },
    agent: PITCH_AGENT_NAME,
  } as Parameters<CopilotWrapper["chat"]>[1]);
  return accumulateStream(stream);
}

async function callOnceForSlide(
  opts: RegenerateSlideOpts,
  userPrompt: string,
  systemPrompt: string,
): Promise<string> {
  const stream = opts.copilot.chat(userPrompt, {
    tools: [],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.sessionId ? { conversationId: opts.sessionId } : {}),
    systemMessage: { mode: "replace", content: systemPrompt },
    agent: PITCH_AGENT_NAME,
  } as Parameters<CopilotWrapper["chat"]>[1]);
  return accumulateStream(stream);
}

/**
 * Assemble a validated `Deck` from the raw LLM payload, filling in the
 * server-side fields the model isn't allowed to author (id, timestamps,
 * brand_kit_id, source_script). The model owns title + slides + tone +
 * audience + estimated_minutes; everything else is overridden here so the
 * model can't poison the audit trail.
 */
function assembleDeck(raw: string, opts: GenerateDeckOpts): Deck {
  // Stage 1 — accept whatever shape the model emits and pick the slides
  // out, validating each one strictly. Everything else falls back to the
  // server-controlled defaults below.
  //
  // Note: `slides` is validated with a relaxed `min(1)` cap here (no upper
  // bound) so we can truncate down to MAX_SLIDES_PER_DECK as a defence-in-
  // depth step rather than throwing the whole draft away. The final
  // `DeckSchema.parse()` below re-applies the strict `max(80)` limit.
  const parsed = parseAndValidate(raw, DeckSchema.partial({
    id: true,
    brand_kit_id: true,
    created_at: true,
    updated_at: true,
    metadata: true,
  }).extend({
    slides: z.array(SlideSchema).min(1),
    title: DeckSchema.shape.title,
  }));

  const now = (opts.clock ?? (() => new Date()))().toISOString();
  const tone = opts.options?.tone ?? parsed.metadata?.tone ?? "formal";
  const audience = opts.options?.audience ?? parsed.metadata?.audience;
  const estimatedMinutes =
    opts.options?.estimatedMinutes ?? parsed.metadata?.estimated_minutes;

  // Defence-in-depth (#977): truncate to {@link MAX_SLIDES_PER_DECK} BEFORE
  // we hand the array to `DeckSchema.parse()`. The schema also enforces the
  // cap (and would reject the parse), but truncating here means a model that
  // ignores the prompt's "hard cap 80" instruction still produces a usable
  // deck instead of a 500.
  const slides =
    parsed.slides.length > MAX_SLIDES_PER_DECK
      ? parsed.slides.slice(0, MAX_SLIDES_PER_DECK)
      : parsed.slides;

  const deck: Deck = {
    id: nanoid(),
    title: parsed.title,
    brand_kit_id: opts.brandKit.id,
    aspect_ratio: parsed.aspect_ratio ?? "16:9",
    slides,
    metadata: {
      source_script: opts.script ?? "",
      source_summary: parsed.metadata?.source_summary,
      audience,
      tone,
      estimated_minutes: estimatedMinutes,
    },
    created_at: now,
    updated_at: now,
  };

  // Final validation — guarantees we hand back a fully-typed Deck.
  return DeckSchema.parse(deck);
}
