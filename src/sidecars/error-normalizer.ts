/**
 * Sidecar error normalizer (Epic #1115 / sub-issue #1160).
 *
 * All Python sidecars (v2a, lipsync, music, image-gen, image-processing,
 * worker, music-studio, audio) can return errors in half a dozen incompatible
 * shapes — plain strings, FastAPI `{detail: ...}`, nested `{error:{...}}`,
 * double-escaped JSON, Python tracebacks, or empty bodies. This module exists
 * so every TS proxy normalizes those into one consistent `{ userMessage, code,
 * hint?, raw }` shape suitable for toasts and structured logs.
 *
 * Contract:
 *   - Never throws. Pure function. Safe to call on any string body.
 *   - `userMessage` is always a non-empty, human-readable string.
 *   - `code` is populated when the sidecar uses the new envelope (#1115).
 *   - `hint` is populated when the sidecar suggests a remediation.
 *   - `raw` is the original body string, unchanged (for audit logs).
 *
 * Stack traces and raw exception class+location are stripped from
 * `userMessage` — only the last meaningful line survives. Full raw bodies
 * stay available via `raw` for server-side logging only.
 */

export type NormalizedSidecarError = {
  userMessage: string;
  code?: string;
  hint?: string;
  raw: string;
  status?: number;
};

const MAX_DEPTH = 6;
const MAX_USER_MESSAGE_LENGTH = 500;

/** Attempt JSON.parse; return `undefined` on any failure. */
function tryParseJson(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== '"') {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Extract the most informative error string from an arbitrary JSON value.
 * Walks common keys (`error`, `detail`, `message`, `exception`, `Exception`)
 * recursively, and recurses into strings that themselves look like JSON.
 */
function extractFromValue(value: unknown, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (value == null) return undefined;

  if (typeof value === "string") {
    // A string may itself be JSON (double-escaped sidecar responses).
    const inner = tryParseJson(value);
    if (inner !== undefined) {
      const fromInner = extractFromValue(inner, depth + 1);
      if (fromInner) return fromInner;
    }
    const cleaned = value.trim();
    return cleaned || undefined;
  }

  if (Array.isArray(value)) {
    // FastAPI validation errors: [{loc, msg, type}, ...]
    if (value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
      const parts: string[] = [];
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const msg = typeof rec.msg === "string" ? rec.msg : undefined;
        const loc = Array.isArray(rec.loc)
          ? rec.loc.filter((p) => p != null).join(".")
          : undefined;
        if (msg && loc) parts.push(`${loc}: ${msg}`);
        else if (msg) parts.push(msg);
      }
      if (parts.length > 0) return parts.join("; ");
    }
    for (const item of value) {
      const found = extractFromValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = [
      "message",
      "error",
      "detail",
      "exception",
      "Exception",
      "msg",
      "reason",
    ] as const;
    for (const key of keys) {
      if (key in rec) {
        const found = extractFromValue(rec[key], depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  return undefined;
}

/**
 * Scrub absolute filesystem paths and env-var-shaped tokens from a string
 * before it crosses the trust boundary back to the client. Mirrors the
 * `redactPaths` helper in `src/app.ts` and adds env-var assignment redaction
 * for cases like `KeyError: 'OPENAI_API_KEY'` or `OPENAI_API_KEY=sk-xxxxx`.
 *
 * The full original text is still preserved in `NormalizedSidecarError.raw`
 * for server-side audit logs — this only sanitizes the user-facing message.
 */
function scrubSensitive(input: string): string {
  return (
    input
      // POSIX home directories: /Users/<name>/... or /home/<name>/...
      .replace(/\/Users\/[^/\s'"]+/g, "~")
      .replace(/\/home\/[^/\s'"]+/g, "~")
      // Windows user profile paths: C:\Users\<name>\...
      .replace(/[A-Za-z]:\\Users\\[^\\/\s'"]+/g, "~")
      // Bare Windows drive-letter absolute paths: C:\foo\bar → <path>
      .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
      // Env-var-shaped assignments: OPENAI_API_KEY=sk-xxx → OPENAI_API_KEY=***
      .replace(/\b([A-Z][A-Z0-9_]{3,})=\S+/g, "$1=***")
  );
}

/**
 * Strip Python traceback noise. If the input is a multi-line traceback,
 * return only the final `ExceptionType: message` line. Then scrub any
 * absolute paths or env-var-shaped tokens so secrets never leak in the
 * user-facing message.
 */
function stripTraceback(input: string): string {
  let core = input;
  if (input.includes("Traceback (most recent call last)")) {
    const lines = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // Last non-empty line that looks like `Type: message` or just text.
    const last = lines[lines.length - 1] ?? input;
    // Drop bare exception class name with no message.
    if (/^[A-Z][A-Za-z0-9_.]*Error$/.test(last)) {
      core = last;
    } else {
      // `ExceptionType: actual message` → keep only the message portion.
      const colon = last.indexOf(": ");
      if (
        colon > 0 &&
        /^[A-Z][A-Za-z0-9_.]*(?:Error|Exception|Warning)$/.test(
          last.slice(0, colon),
        )
      ) {
        core = last.slice(colon + 2);
      } else {
        core = last;
      }
    }
  }
  return scrubSensitive(core);
}

function truncate(s: string): string {
  if (s.length <= MAX_USER_MESSAGE_LENGTH) return s;
  return `${s.slice(0, MAX_USER_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Normalize a raw sidecar error body into a structured envelope.
 *
 * @param rawBody  Body string from `await response.text()`. Pass `""` if unknown.
 * @param status   Optional HTTP status code for fallback messaging.
 */
export function normalizeSidecarError(
  rawBody: string,
  status?: number,
): NormalizedSidecarError {
  const raw = typeof rawBody === "string" ? rawBody : String(rawBody ?? "");
  const trimmed = raw.trim();

  if (!trimmed || trimmed === "null") {
    return {
      userMessage:
        status != null
          ? `Sidecar returned HTTP ${status} with no body.`
          : "Sidecar returned an empty error response.",
      raw,
      status,
    };
  }

  const parsed = tryParseJson(trimmed);

  if (parsed !== undefined) {
    let code: string | undefined;
    let hint: string | undefined;

    // Pull standardized envelope fields first if present.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const errVal = rec.error;
      if (errVal && typeof errVal === "object" && !Array.isArray(errVal)) {
        const errRec = errVal as Record<string, unknown>;
        if (typeof errRec.code === "string") code = errRec.code;
        if (typeof errRec.hint === "string") hint = errRec.hint;
      }
    }

    const extracted = extractFromValue(parsed, 0);
    if (extracted) {
      return {
        userMessage: truncate(stripTraceback(extracted)),
        code,
        hint,
        raw,
        status,
      };
    }
    // Valid JSON but no recognized error field — don't dump the blob at the user.
    return {
      userMessage:
        status != null
          ? `Sidecar returned HTTP ${status} (no error message in response).`
          : "Sidecar returned an error response with no message.",
      raw,
      status,
    };
  }

  // Looks like HTML (e.g. nginx 502 page) — don't dump markup at the user.
  if (/^\s*</.test(trimmed) || /<html/i.test(trimmed)) {
    return {
      userMessage:
        status != null
          ? `Sidecar returned HTTP ${status} (non-JSON response).`
          : "Sidecar returned a non-JSON response.",
      raw,
      status,
    };
  }

  return {
    userMessage: truncate(stripTraceback(trimmed)),
    raw,
    status,
  };
}

/**
 * Error subclass thrown by proxy helpers that need to bubble a normalized
 * sidecar error up the Express middleware chain. Holds the original status
 * code and the normalized envelope so route handlers can render either form.
 */
export class SidecarProxyError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly hint?: string;
  readonly raw: string;

  constructor(envelope: NormalizedSidecarError, defaultStatus = 502) {
    super(envelope.userMessage);
    this.name = "SidecarProxyError";
    this.status = envelope.status ?? defaultStatus;
    this.code = envelope.code;
    this.hint = envelope.hint;
    this.raw = envelope.raw;
  }

  toJSON() {
    return {
      error: this.message,
      ...(this.code ? { code: this.code } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

/**
 * Convenience: fetch a sidecar URL and, on non-2xx, throw a
 * `SidecarProxyError` with the normalized body. On success, returns the
 * `Response` unchanged so callers can read it however they need.
 */
export async function sidecarFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, init);
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  throw new SidecarProxyError(normalizeSidecarError(body, response.status));
}
