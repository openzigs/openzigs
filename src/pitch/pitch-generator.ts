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
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
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

  // Initial call — parse + validate; on failure, retry ONCE with the error.
  let lastError: unknown = null;
  let raw = await callOnce(opts, userPrompt, systemPrompt);
  try {
    return assembleDeck(raw, opts);
  } catch (err) {
    lastError = err;
  }

  // Retry pass — embed the validation error so the model can self-correct.
  const retryPrompt = [userPrompt, "", buildRetryHint(lastError)].join("\n");
  raw = await callOnce(opts, retryPrompt, systemPrompt);
  return assembleDeck(raw, opts);
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
  const parsed = parseAndValidate(raw, DeckSchema.partial({
    id: true,
    brand_kit_id: true,
    created_at: true,
    updated_at: true,
    metadata: true,
  }).extend({
    // `slides` is non-optional and is the only field the model is required
    // to get right.
    slides: DeckSchema.shape.slides,
    title: DeckSchema.shape.title,
  }));

  const now = (opts.clock ?? (() => new Date()))().toISOString();
  const tone = opts.options?.tone ?? parsed.metadata?.tone ?? "formal";
  const audience = opts.options?.audience ?? parsed.metadata?.audience;
  const estimatedMinutes =
    opts.options?.estimatedMinutes ?? parsed.metadata?.estimated_minutes;

  const deck: Deck = {
    id: nanoid(),
    title: parsed.title,
    brand_kit_id: opts.brandKit.id,
    aspect_ratio: parsed.aspect_ratio ?? "16:9",
    slides: parsed.slides,
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
