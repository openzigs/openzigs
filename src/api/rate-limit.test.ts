import { describe, expect, it } from "vitest";
import {
  createTokenBucketLimiter,
  bucketKeyFromRequest,
} from "./rate-limit.js";

describe("createTokenBucketLimiter", () => {
  it("allows requests under the limit", () => {
    const lim = createTokenBucketLimiter({ perMinute: 60, burst: 10 });
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) {
      const v = lim.consume("k", t0);
      expect(v.allowed).toBe(true);
    }
  });

  it("blocks the 11th request in a burst", () => {
    const lim = createTokenBucketLimiter({ perMinute: 60, burst: 10 });
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) lim.consume("k", t0);
    const v = lim.consume("k", t0);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("refills tokens after time passes", () => {
    const lim = createTokenBucketLimiter({ perMinute: 60, burst: 10 });
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) lim.consume("k", t0);
    expect(lim.consume("k", t0).allowed).toBe(false);
    // After 2 seconds at 60/min = 1/sec → 2 tokens refill
    const v = lim.consume("k", t0 + 2_000);
    expect(v.allowed).toBe(true);
  });

  it("isolates buckets per key", () => {
    const lim = createTokenBucketLimiter({ perMinute: 60, burst: 2 });
    const t0 = 1_000_000;
    expect(lim.consume("a", t0).allowed).toBe(true);
    expect(lim.consume("a", t0).allowed).toBe(true);
    expect(lim.consume("a", t0).allowed).toBe(false);
    // Different key has its own bucket
    expect(lim.consume("b", t0).allowed).toBe(true);
  });

  it("never exceeds burst capacity even after long idle", () => {
    const lim = createTokenBucketLimiter({ perMinute: 60, burst: 5 });
    const t0 = 1_000_000;
    // Consume one to create the bucket
    lim.consume("k", t0);
    // Idle for an hour
    const t1 = t0 + 3_600_000;
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (lim.consume("k", t1).allowed) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it("reset clears all buckets", () => {
    const lim = createTokenBucketLimiter({ perMinute: 60, burst: 1 });
    const t0 = 1_000_000;
    expect(lim.consume("k", t0).allowed).toBe(true);
    expect(lim.consume("k", t0).allowed).toBe(false);
    lim.reset();
    expect(lim.consume("k", t0).allowed).toBe(true);
  });

  it("retryAfterSec is at least 1", () => {
    const lim = createTokenBucketLimiter({ perMinute: 6000, burst: 1 });
    const t0 = 1_000_000;
    lim.consume("k", t0);
    const v = lim.consume("k", t0);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});

describe("bucketKeyFromRequest", () => {
  it("keys on req.ip", () => {
    const k = bucketKeyFromRequest({
      headers: {},
      body: {},
      ip: "1.2.3.4",
    });
    expect(k).toBe("ip:1.2.3.4");
  });

  it("uses ip:unknown when no ip", () => {
    const k = bucketKeyFromRequest({ headers: {}, body: {} });
    expect(k).toBe("ip:unknown");
  });

  // Regression: bucket key MUST NOT be influenced by caller-controlled
  // input. Otherwise an attacker rotates X-OpenZigs-Node-Type / body.node
  // per request to bypass the per-bucket limit and grow the bucket map.
  it("ignores caller-supplied X-OpenZigs-Node-Type header", () => {
    const k1 = bucketKeyFromRequest({
      headers: { "x-openzigs-node-type": "image-gen" },
      body: {},
      ip: "1.2.3.4",
    });
    const k2 = bucketKeyFromRequest({
      headers: { "x-openzigs-node-type": "video-gen" },
      body: {},
      ip: "1.2.3.4",
    });
    expect(k1).toBe("ip:1.2.3.4");
    expect(k2).toBe("ip:1.2.3.4");
    expect(k1).toBe(k2);
  });

  it("ignores caller-supplied body.node / body.nodeType fields", () => {
    const k1 = bucketKeyFromRequest({
      headers: {},
      body: { node: "music-gen" },
      ip: "1.2.3.4",
    });
    const k2 = bucketKeyFromRequest({
      headers: {},
      body: { nodeType: "rvc" },
      ip: "1.2.3.4",
    });
    expect(k1).toBe("ip:1.2.3.4");
    expect(k2).toBe("ip:1.2.3.4");
  });

  it("malicious header rotation cannot exhaust an honest bucket", () => {
    // Same source IP, attacker rotates the header per request — bucket
    // must NOT rotate, so the limiter still throttles them.
    const limiter = (() => {
      // small inline limiter to keep this test self-contained
      const buckets = new Map<string, number>();
      return {
        consume(key: string): boolean {
          const remaining = buckets.get(key) ?? 2;
          if (remaining <= 0) return false;
          buckets.set(key, remaining - 1);
          return true;
        },
      };
    })();
    const requests = ["a", "b", "c", "d"].map((nodeType) => ({
      headers: { "x-openzigs-node-type": nodeType },
      body: {},
      ip: "9.9.9.9",
    }));
    const verdicts = requests.map((r) =>
      limiter.consume(bucketKeyFromRequest(r)),
    );
    expect(verdicts).toEqual([true, true, false, false]);
  });
});
