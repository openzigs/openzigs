/**
 * Pitch — small parsing / wrapping helpers shared by the AI generator and
 * the per-slide regenerate task.
 *
 * Sub-issue #954 (Epic #951). Lives in its own module so:
 *   - `pitch-generator.ts` and `pitch-regenerate.ts` share the same JSON
 *     coercion / fence-stripping behaviour (no copy-paste drift)
 *   - the helpers can be unit-tested in isolation without touching the
 *     copilot wrapper or the SQLite repo.
 */
import type { ZodTypeAny, z } from "zod";

/** Maximum allowed user-script length (kept in sync with `DeckSchema.metadata.source_script`). */
export const MAX_USER_SCRIPT_BYTES = 50_000;

/** Markers that delimit user-supplied content inside a system prompt. */
export const USER_SCRIPT_START = "<<<USER_SCRIPT_START>>>";
export const USER_SCRIPT_END = "<<<USER_SCRIPT_END>>>";

/**
 * Strip ```json fences (or bare ``` fences) and trim whitespace.
 * Tolerates leading prose, multiple fences, and a missing closing fence.
 */
export function stripCodeFences(raw: string): string {
  if (!raw) return "";
  let out = raw.trim();
  // Common case: a single fenced block — extract its body.
  const fence = out.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    return fence[1].trim();
  }
  // Edge case: the model emits a leading ```json with no closer.
  out = out.replace(/^```(?:json|JSON)?\s*/i, "").replace(/```\s*$/i, "");
  return out.trim();
}

/**
 * Wrap a user script in delimiter markers for inclusion as DATA in the LLM
 * prompt. Strips any pre-existing markers so a malicious user can't smuggle
 * a fake "USER_SCRIPT_END" → injection-instruction → "USER_SCRIPT_START"
 * sandwich into the prompt.
 *
 * Throws when the post-strip script exceeds {@link MAX_USER_SCRIPT_BYTES}.
 */
export function wrapUserScript(script: string): string {
  const cleaned = String(script ?? "")
    // Defence: remove any user-planted delimiter sequences.
    .split(USER_SCRIPT_START).join("")
    .split(USER_SCRIPT_END).join("");
  if (Buffer.byteLength(cleaned, "utf8") > MAX_USER_SCRIPT_BYTES) {
    throw new Error(
      `pitch: user script exceeds ${MAX_USER_SCRIPT_BYTES.toLocaleString()} byte cap`,
    );
  }
  return `${USER_SCRIPT_START}\n${cleaned}\n${USER_SCRIPT_END}`;
}

/** Drain an async iterator of string chunks into a single string. */
export async function accumulateStream(
  stream: AsyncIterable<string>,
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

/**
 * Try to JSON.parse the (possibly fenced) `raw` payload and validate it
 * against `schema`. Throws a descriptive Error on failure — callers handle
 * the retry policy themselves.
 */
export function parseAndValidate<S extends ZodTypeAny>(
  raw: string,
  schema: S,
): z.infer<S> {
  const cleaned = stripCodeFences(raw);
  if (!cleaned) {
    throw new Error("pitch: model returned empty output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pitch: model output is not valid JSON: ${msg}`);
  }
  return schema.parse(parsed) as z.infer<S>;
}

/**
 * Build a "you failed validation, try again" suffix for the retry prompt.
 * Truncates the raw error so we don't echo a 5 KB Zod issue list back into
 * the LLM context.
 */
export function buildRetryHint(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const trimmed = msg.length > 800 ? `${msg.slice(0, 800)}…` : msg;
  return [
    "Your previous output failed schema validation:",
    trimmed,
    "Output ONLY valid JSON conforming to the schema. Do NOT include any prose, markdown, or code fences.",
  ].join("\n");
}
