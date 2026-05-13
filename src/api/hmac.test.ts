import { describe, expect, it } from "vitest";
import {
  computeSignature,
  verifyHmacCallback,
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
  HMAC_HEADER_NODE,
} from "./hmac.js";

describe("computeSignature", () => {
  it("is deterministic for same inputs", () => {
    const sig1 = computeSignature("secret", "1700000000", '{"job_id":"x"}');
    const sig2 = computeSignature("secret", "1700000000", '{"job_id":"x"}');
    expect(sig1).toBe(sig2);
    expect(sig1.startsWith("sha256=")).toBe(true);
    expect(sig1).toHaveLength("sha256=".length + 64);
  });

  it("differs when secret changes", () => {
    const a = computeSignature("s1", "1700000000", "{}");
    const b = computeSignature("s2", "1700000000", "{}");
    expect(a).not.toBe(b);
  });

  it("differs when timestamp changes", () => {
    const a = computeSignature("secret", "1700000000", "{}");
    const b = computeSignature("secret", "1700000001", "{}");
    expect(a).not.toBe(b);
  });

  it("differs when body changes", () => {
    const a = computeSignature("secret", "1700000000", "{}");
    const b = computeSignature("secret", "1700000000", "{ }");
    expect(a).not.toBe(b);
  });

  it("works with Buffer input", () => {
    const stringSig = computeSignature("s", "1", '{"k":1}');
    const bufSig = computeSignature("s", "1", Buffer.from('{"k":1}'));
    expect(stringSig).toBe(bufSig);
  });
});

describe("verifyHmacCallback", () => {
  const secret = "test-secret";
  const body = '{"job_id":"abc","status":"complete"}';
  const ts = "1700000000";
  const sig = computeSignature(secret, ts, body);
  const now = parseInt(ts, 10);

  it("accepts a valid signature within freshness window", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig,
      rawBody: body,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when secret is missing", () => {
    const r = verifyHmacCallback({
      secret: "",
      timestamp: ts,
      signature: sig,
      rawBody: body,
      now,
    });
    expect(r).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("rejects when timestamp header missing", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: undefined,
      signature: sig,
      rawBody: body,
      now,
    });
    expect(r).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects when signature header missing", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: undefined,
      rawBody: body,
      now,
    });
    expect(r).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects non-numeric timestamp", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: "not-a-number",
      signature: sig,
      rawBody: body,
      now,
    });
    expect(r.reason).toBe("stale_timestamp");
  });

  it("rejects stale timestamp (> 300s in past)", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig,
      rawBody: body,
      now: now + 600,
    });
    expect(r.reason).toBe("stale_timestamp");
  });

  it("rejects future timestamp (> 300s in future)", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig,
      rawBody: body,
      now: now - 600,
    });
    expect(r.reason).toBe("stale_timestamp");
  });

  it("accepts timestamp at the edge of the window", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig,
      rawBody: body,
      now: now + 300,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects signature without sha256= prefix", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig.replace(/^sha256=/, ""),
      rawBody: body,
      now,
    });
    expect(r.reason).toBe("bad_signature");
  });

  it("rejects signature with wrong wrong-case prefix", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig.replace(/^sha256=/, "SHA256="),
      rawBody: body,
      now,
    });
    expect(r.reason).toBe("bad_signature");
  });

  it("rejects tampered body byte (single character)", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig,
      rawBody: body.replace("complete", "completx"),
      now,
    });
    expect(r.reason).toBe("bad_signature");
  });

  it("rejects when wrong secret used to sign", () => {
    const wrongSig = computeSignature("wrong-secret", ts, body);
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: wrongSig,
      rawBody: body,
      now,
    });
    expect(r.reason).toBe("bad_signature");
  });

  it("uses timing-safe length check (different-length signatures)", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: "sha256=abc",
      rawBody: body,
      now,
    });
    expect(r.reason).toBe("bad_signature");
  });

  it("supports a custom maxSkewSec", () => {
    const r = verifyHmacCallback({
      secret,
      timestamp: ts,
      signature: sig,
      rawBody: body,
      now: now + 60,
      maxSkewSec: 30,
    });
    expect(r.reason).toBe("stale_timestamp");
  });
});

describe("hmac header constants", () => {
  it("are normalized to lower-case", () => {
    expect(HMAC_HEADER_SIGNATURE).toBe("x-openzigs-signature");
    expect(HMAC_HEADER_TIMESTAMP).toBe("x-openzigs-timestamp");
    expect(HMAC_HEADER_NODE).toBe("x-openzigs-node-type");
  });
});
