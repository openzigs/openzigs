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
  it("prefers X-OpenZigs-Node-Type header", () => {
    const k = bucketKeyFromRequest({
      headers: { "x-openzigs-node-type": "image-gen" },
      body: { node: "video-gen" },
      ip: "1.2.3.4",
    });
    expect(k).toBe("node:image-gen");
  });

  it("falls back to body.node when header missing", () => {
    const k = bucketKeyFromRequest({
      headers: {},
      body: { node: "video-gen" },
      ip: "1.2.3.4",
    });
    expect(k).toBe("node:video-gen");
  });

  it("falls back to body.nodeType when body.node missing", () => {
    const k = bucketKeyFromRequest({
      headers: {},
      body: { nodeType: "music-gen" },
      ip: "1.2.3.4",
    });
    expect(k).toBe("node:music-gen");
  });

  it("falls back to req.ip when no node info available", () => {
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

  it("ignores empty header value", () => {
    const k = bucketKeyFromRequest({
      headers: { "x-openzigs-node-type": "" },
      body: { node: "music-gen" },
      ip: "1.2.3.4",
    });
    expect(k).toBe("node:music-gen");
  });

  it("ignores non-string body fields", () => {
    const k = bucketKeyFromRequest({
      headers: {},
      body: { node: 42, nodeType: ["x"] },
      ip: "1.2.3.4",
    });
    expect(k).toBe("ip:1.2.3.4");
  });
});
