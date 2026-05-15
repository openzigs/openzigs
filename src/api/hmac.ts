/**
 * Issue #1089 — HMAC-SHA256 + timestamp verification for worker callbacks.
 *
 * Callbacks to `/api/queue/complete` and `/api/queue/progress` from sidecars
 * are signed with `HMAC_SHA256(workerSecret, "{ts}.{rawBody}")`. The header
 * pair is:
 *
 *   X-OpenZigs-Timestamp: <unix-seconds>
 *   X-OpenZigs-Signature: sha256=<hex>
 *
 * Replay protection is a ±300s freshness window. Per-nonce replay rejection
 * is intentionally out of scope (future hardening).
 *
 * Backwards compat: when neither header is present and the legacy escape
 * hatch is enabled, fall back to `Authorization: Bearer <workerSecret>` and
 * emit a deprecation warning.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacVerifyResult {
  ok: boolean;
  reason?:
    | "stale_timestamp"
    | "bad_signature"
    | "missing_headers"
    | "missing_secret";
}

const SIGNATURE_PREFIX = "sha256=";

/**
 * Compute the canonical signature for a payload.
 * Exposed for tests and for the smoke-test script signing helper.
 */
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: Buffer | string,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(rawBody);
  return SIGNATURE_PREFIX + mac.digest("hex");
}

/**
 * Verify HMAC + timestamp on an incoming callback.
 *
 * @param secret  shared workerSecret
 * @param timestamp  value of `X-OpenZigs-Timestamp`
 * @param signature  value of `X-OpenZigs-Signature` (with `sha256=` prefix)
 * @param rawBody  raw request body bytes (NOT a parsed object)
 * @param now  current unix-seconds (override for tests)
 * @param maxSkewSec  freshness window, default 300s
 */
export function verifyHmacCallback({
  secret,
  timestamp,
  signature,
  rawBody,
  now = Math.floor(Date.now() / 1000),
  maxSkewSec = 300,
}: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | string;
  now?: number;
  maxSkewSec?: number;
}): HmacVerifyResult {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "stale_timestamp" };
  if (Math.abs(now - ts) > maxSkewSec) {
    return { ok: false, reason: "stale_timestamp" };
  }

  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: "bad_signature" };
  }

  const expected = computeSignature(secret, timestamp, rawBody);
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/** Lower-cased header names (Express normalizes). */
export const HMAC_HEADER_TIMESTAMP = "x-openzigs-timestamp";
export const HMAC_HEADER_SIGNATURE = "x-openzigs-signature";
export const HMAC_HEADER_NODE = "x-openzigs-node-type";
