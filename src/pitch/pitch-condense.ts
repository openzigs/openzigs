/**
 * Pitch — AI script condensation (map-reduce summarization).
 *
 * The Pitch wizard caps the persisted `source_script` at 50 KB so the LLM
 * draft pass stays cheap and the audit-trail metadata stays bounded.
 * Real-world inputs (specs, user-guide markdown) are routinely 200 KB – 2 MB.
 * This module is the escape valve: it accepts oversize raw text, splits it
 * into ~30 KB chunks on paragraph boundaries, summarizes each chunk via
 * the Copilot LLM with a faithful-summary system prompt, then concatenates
 * the summaries. If the concatenation is still over the target, a single
 * reduce pass is run to fold the section summaries into one coherent
 * script under the cap.
 *
 * Hard rules:
 *   - Inputs already ≤ targetBytes pass through with ZERO LLM calls.
 *   - Inputs > {@link CONDENSE_HARD_CEILING_BYTES} are rejected before
 *     any LLM call (denial-of-wallet defence).
 *   - Each LLM call gets ONE retry on empty/malformed response, mirroring
 *     the per-call retry budget used by `pitch-generator.ts`.
 *   - No streaming — full response collected per call (`accumulateStream`).
 *
 * Lives in its own module so the unit tests can mock the Copilot wrapper
 * with `vi.fn()` returning canned summaries without dragging in the deck
 * generator's prompt builders.
 */
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import { logger } from "../logging/logger.js";
import { accumulateStream } from "./pitch-utils.js";

/** Default condensed-output target. Leaves headroom under the 50 KB
 *  `source_script` cap enforced by `DraftDeckBodySchema`. */
export const DEFAULT_CONDENSE_TARGET_BYTES = 40_000;

/** Hard ceiling on raw input bytes — rejected before any LLM call.
 *  Mirrors the file-picker cap on the wizard. */
export const CONDENSE_HARD_CEILING_BYTES = 2_000_000;

/** Approximate per-chunk size in characters. Chosen so each map call
 *  stays well within model context windows and LLM cost is predictable
 *  (a 459 KB input → ~16 chunks → 16 + 1 reduce LLM calls). */
export const CONDENSE_CHUNK_CHARS = 30_000;

/** Maximum number of map-stage chunks summarised in parallel. Bounded
 *  to avoid hammering the Copilot endpoint and to keep per-session token
 *  burst predictable. 4 keeps a 16-chunk job to ~4 sequential waves. */
export const CONDENSE_MAP_CONCURRENCY = 4;

/** Default model used for condensation. The map/reduce task is faithful
 *  summarisation — `gpt-4o-mini` is 5–10× faster and cheaper than the
 *  wrapper-default `gpt-4.1` while remaining plenty accurate. Callers can
 *  still override via {@link CondenseScriptOpts.model}. */
export const DEFAULT_CONDENSE_MODEL = "gpt-4o-mini";

/** Agent name used on the Copilot wrapper call. */
const CONDENSE_AGENT_NAME = "pitch-condense";

const MAP_SYSTEM_PROMPT =
  "You are condensing a section of a longer document into a faithful, structured summary that will be used to author a presentation. Preserve all proper nouns, numbers, claims, and section structure. Output plain prose / bullet sections. Do NOT add commentary.";

const REDUCE_SYSTEM_PROMPT_PREFIX =
  "You are combining section summaries into a single coherent script that will be used to author a presentation. Preserve all proper nouns, numbers, claims, and section structure. Output plain prose / bullet sections. Do NOT add commentary.";

export interface CondenseScriptOpts {
  /** Target output size in bytes. Defaults to {@link DEFAULT_CONDENSE_TARGET_BYTES}. */
  targetBytes?: number;
  /** Optional injectable clock for deterministic logging in tests. */
  clock?: () => Date;
  /** Optional model override. Falls back to the wrapper default. */
  model?: string;
  /** Optional cached SDK session id, mirroring `pitch-generator.ts`. */
  sessionId?: string;
}

export interface CondenseScriptResult {
  /** Condensed text safe to feed into the existing draft pipeline. */
  condensed: string;
  /** Raw input length in UTF-8 bytes. */
  originalBytes: number;
  /** Output length in UTF-8 bytes. */
  condensedBytes: number;
  /** Number of map-stage LLM calls made. `0` when the input was already
   *  under the target and we passed it through unchanged. */
  chunks: number;
}

/**
 * Condense `rawText` down to ≤ targetBytes via map-reduce LLM summarization.
 *
 * Throws when:
 *   - `rawText` is empty (caller error — the endpoint validates `min(1)`).
 *   - `rawText` exceeds {@link CONDENSE_HARD_CEILING_BYTES} (no LLM call made).
 *   - the LLM returns an empty string twice in a row for a single chunk.
 */
export async function condenseScript(
  rawText: string,
  copilot: CopilotWrapper,
  opts: CondenseScriptOpts = {},
): Promise<CondenseScriptResult> {
  const text = String(rawText ?? "");
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes === 0) {
    throw new Error("pitch-condense: rawText is empty");
  }
  if (originalBytes > CONDENSE_HARD_CEILING_BYTES) {
    throw new Error(
      `pitch-condense: rawText exceeds ${CONDENSE_HARD_CEILING_BYTES.toLocaleString()} byte hard ceiling`,
    );
  }

  const targetBytes = opts.targetBytes ?? DEFAULT_CONDENSE_TARGET_BYTES;

  // Fast path — already small enough, no LLM call.
  if (originalBytes <= targetBytes) {
    return {
      condensed: text,
      originalBytes,
      condensedBytes: originalBytes,
      chunks: 0,
    };
  }

  // ── Map stage (bounded-concurrency parallel) ────────────────────
  const chunks = splitIntoChunks(text, CONDENSE_CHUNK_CHARS);
  logger.info(
    `[pitch-condense] map stage: ${chunks.length} chunks, originalBytes=${originalBytes}, targetBytes=${targetBytes}, concurrency=${CONDENSE_MAP_CONCURRENCY}`,
  );

  // Preserve input order — workers write into `summaries[i]` by index.
  // The reduce step below relies on positional ordering.
  const summaries: Array<string | undefined> = new Array(chunks.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= chunks.length) return;
      const userPrompt = buildMapUserPrompt(chunks[i], i + 1, chunks.length);
      summaries[i] = await callLLMWithRetry(
        copilot,
        userPrompt,
        MAP_SYSTEM_PROMPT,
        opts,
      );
    }
  };
  const poolSize = Math.min(CONDENSE_MAP_CONCURRENCY, chunks.length);
  // If any worker rejects, Promise.all surfaces the first failure and
  // we propagate it — current behaviour is "fail the whole call".
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  let condensed = (summaries as string[]).join("\n\n");
  let condensedBytes = Buffer.byteLength(condensed, "utf8");

  // ── Reduce stage (only if concat is still over target) ───────────
  if (condensedBytes > targetBytes) {
    logger.info(
      `[pitch-condense] reduce stage triggered: concatBytes=${condensedBytes}, targetBytes=${targetBytes}`,
    );
    const targetWords = Math.max(200, Math.floor(targetBytes / 6));
    const reduceSystemPrompt = `${REDUCE_SYSTEM_PROMPT_PREFIX} Hard cap: ${targetWords} words.`;
    const reduceUserPrompt = [
      `Combine these ${summaries.length} section summaries into a single coherent script of at most ${targetWords} words. Preserve all key facts, proper nouns, and numbers.`,
      "",
      condensed,
    ].join("\n");
    condensed = await callLLMWithRetry(
      copilot,
      reduceUserPrompt,
      reduceSystemPrompt,
      opts,
    );
    condensedBytes = Buffer.byteLength(condensed, "utf8");
  }

  return {
    condensed,
    originalBytes,
    condensedBytes,
    chunks: chunks.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────

/**
 * Split `text` into chunks of approximately `maxChars` characters,
 * preferring paragraph (`\n\n`) boundaries, then line (`\n`) boundaries,
 * then a hard cut. Never returns empty chunks.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  if (maxChars <= 0) {
    throw new Error("pitch-condense: maxChars must be > 0");
  }
  if (text.length <= maxChars) return [text];

  const out: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    let cut = window.lastIndexOf("\n\n");
    if (cut < Math.floor(maxChars / 2)) cut = window.lastIndexOf("\n");
    if (cut < Math.floor(maxChars / 2)) cut = maxChars; // hard cut
    const head = remaining.slice(0, cut).trim();
    if (head.length > 0) out.push(head);
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining.trim().length > 0) out.push(remaining.trim());
  return out;
}

function buildMapUserPrompt(
  chunk: string,
  index: number,
  total: number,
): string {
  return [
    `Condense the following section (${index} of ${total}) into a faithful summary suitable for use as presentation source material.`,
    "",
    "<DOCUMENT_SECTION>",
    chunk,
    "</DOCUMENT_SECTION>",
  ].join("\n");
}

async function callLLMWithRetry(
  copilot: CopilotWrapper,
  userPrompt: string,
  systemPrompt: string,
  opts: CondenseScriptOpts,
): Promise<string> {
  // Initial attempt + 1 retry on empty/whitespace response. Same retry
  // budget shape as `pitch-generator.ts`.
  const model = opts.model ?? DEFAULT_CONDENSE_MODEL;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = copilot.chat(userPrompt, {
        tools: [],
        model,
        ...(opts.sessionId ? { conversationId: opts.sessionId } : {}),
        systemMessage: { mode: "replace", content: systemPrompt },
        agent: CONDENSE_AGENT_NAME,
      } as Parameters<CopilotWrapper["chat"]>[1]);
      const raw = await accumulateStream(stream);
      const cleaned = raw.trim();
      if (cleaned.length === 0) {
        throw new Error("pitch-condense: model returned empty output");
      }
      return cleaned;
    } catch (err) {
      lastError = err;
      logger.warn(
        `[pitch-condense] LLM attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("pitch-condense: LLM call failed");
}
