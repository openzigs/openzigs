/**
 * Issue #1087 — In-memory token-bucket rate limiter for queue callbacks.
 *
 * Keyed by client IP (server-derived; Express `trust proxy` is set so
 * `req.ip` reflects the real peer when behind a tunnel/proxy). Caller-
 * supplied identifiers like `X-OpenZigs-Node-Type` or body fields are
 * intentionally NOT used — an attacker could otherwise rotate the bucket
 * key per request to bypass the limit and grow the in-memory bucket map
 * unboundedly.
 *
 * Resets on process restart — acceptable for v1; per-issue acceptance.
 */

export interface RateLimitConfig {
  /** Sustained rate per minute. */
  perMinute: number;
  /** Burst capacity (max tokens). */
  burst: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** When `allowed` is false, seconds until the next request is permitted. */
  retryAfterSec?: number;
  /** Tokens remaining after this take. */
  remaining: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiter {
  consume(key: string, now?: number): RateLimitVerdict;
  /** Reset all buckets — used by tests. */
  reset(): void;
}

export function createTokenBucketLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const ratePerMs = config.perMinute / 60_000;
  const capacity = config.burst;

  return {
    consume(key: string, now: number = Date.now()): RateLimitVerdict {
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, lastRefillMs: now };
        buckets.set(key, b);
      }
      const elapsed = now - b.lastRefillMs;
      if (elapsed > 0) {
        b.tokens = Math.min(capacity, b.tokens + elapsed * ratePerMs);
        b.lastRefillMs = now;
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, remaining: Math.floor(b.tokens) };
      }
      const deficit = 1 - b.tokens;
      const retryAfterSec = Math.max(1, Math.ceil(deficit / ratePerMs / 1000));
      return { allowed: false, retryAfterSec, remaining: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * Derive a rate-limit bucket key from a callback request.
 *
 * SECURITY: Only `req.ip` is used. Caller-supplied headers and body fields
 * MUST NOT influence the bucket key — otherwise an attacker can rotate
 * the key per request to (a) bypass the per-bucket limit and
 * (b) grow the bucket map without bound.
 */
export function bucketKeyFromRequest(req: {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
}): string {
  return `ip:${req.ip ?? "unknown"}`;
}
