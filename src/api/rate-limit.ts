/**
 * Issue #1087 — In-memory token-bucket rate limiter for queue callbacks.
 *
 * Keyed by node type (from `X-OpenZigs-Node-Type` header or request body
 * `node`/`nodeType` field). Falls back to client IP when no node header is
 * present (legacy sidecars).
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
 * Pull a sensible bucket key from a callback request.
 * Order: explicit `X-OpenZigs-Node-Type` header → request body `node` →
 * `req.ip` (legacy fallback).
 */
export function bucketKeyFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
}): string {
  const headerVal = req.headers["x-openzigs-node-type"];
  if (typeof headerVal === "string" && headerVal.length > 0) {
    return `node:${headerVal}`;
  }
  if (req.body && typeof req.body === "object") {
    const node = (req.body as Record<string, unknown>).node;
    if (typeof node === "string" && node.length > 0) return `node:${node}`;
    const nodeType = (req.body as Record<string, unknown>).nodeType;
    if (typeof nodeType === "string" && nodeType.length > 0)
      return `node:${nodeType}`;
  }
  return `ip:${req.ip ?? "unknown"}`;
}
