import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  FirecrawlWebhookHandler,
  validateWebhookSignature,
  generateWebhookSecret,
  createFirecrawlWebhookRouter,
} from "./firecrawl-webhooks.js";

// ── Helper ───────────────────────────────────────────────────────────────

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// ── validateWebhookSignature ─────────────────────────────────────────────

describe("validateWebhookSignature", () => {
  const secret = "test-secret-key";

  it("returns true for valid signature", () => {
    const payload = '{"status":"completed"}';
    const sig = sign(payload, secret);
    expect(validateWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("returns true for Buffer payload", () => {
    const payload = Buffer.from('{"status":"completed"}');
    const sig = sign(payload.toString(), secret);
    expect(validateWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for wrong signature", () => {
    const payload = '{"status":"completed"}';
    expect(
      validateWebhookSignature(payload, "wrong-signature-here", secret),
    ).toBe(false);
  });

  it("returns false for tampered payload", () => {
    const original = '{"status":"completed"}';
    const sig = sign(original, secret);
    const tampered = '{"status":"failed"}';
    expect(validateWebhookSignature(tampered, sig, secret)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(validateWebhookSignature("body", "", secret)).toBe(false);
  });

  it("returns false for empty secret", () => {
    expect(validateWebhookSignature("body", "sig", "")).toBe(false);
  });

  it("returns false for different length signature", () => {
    expect(validateWebhookSignature("body", "short", secret)).toBe(false);
  });
});

// ── generateWebhookSecret ────────────────────────────────────────────────

describe("generateWebhookSecret", () => {
  it("returns a 64-character hex string", () => {
    const secret = generateWebhookSecret();
    expect(secret).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
  });

  it("generates unique secrets", () => {
    const s1 = generateWebhookSecret();
    const s2 = generateWebhookSecret();
    expect(s1).not.toBe(s2);
  });
});

// ── FirecrawlWebhookHandler ──────────────────────────────────────────────

describe("FirecrawlWebhookHandler", () => {
  const secret = "test-hmac-secret";
  let handler: FirecrawlWebhookHandler;

  beforeEach(() => {
    handler = new FirecrawlWebhookHandler({
      secret,
      port: 3000,
      enabled: true,
      jobTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    handler.shutdown();
  });

  describe("basic properties", () => {
    it("reports enabled when secret and enabled are set", () => {
      expect(handler.enabled).toBe(true);
    });

    it("reports disabled when enabled is false", () => {
      const h = new FirecrawlWebhookHandler({
        secret,
        port: 3000,
        enabled: false,
      });
      expect(h.enabled).toBe(false);
      h.shutdown();
    });

    it("reports disabled when secret is empty", () => {
      const h = new FirecrawlWebhookHandler({
        secret: "",
        port: 3000,
        enabled: true,
      });
      expect(h.enabled).toBe(false);
      h.shutdown();
    });

    it("exposes the secret", () => {
      expect(handler.secret).toBe(secret);
    });

    it("generates unique job IDs", () => {
      const id1 = handler.generateJobId();
      const id2 = handler.generateJobId();
      expect(id1).not.toBe(id2);
      expect(id1).toHaveLength(32);
    });

    it("constructs correct webhook URL", () => {
      const url = handler.getWebhookUrl("abc123");
      expect(url).toBe(
        "http://localhost:3000/api/webhooks/firecrawl?jobId=abc123",
      );
    });
  });

  describe("registerJob + handleWebhook", () => {
    it("resolves pending promise on valid webhook", async () => {
      const jobId = handler.generateJobId();
      const promise = handler.registerJob(jobId);

      expect(handler.pendingCount).toBe(1);

      const payload = JSON.stringify({
        success: true,
        status: "completed",
        data: [{ markdown: "# Page 1", url: "https://example.com" }],
      });
      const sig = sign(payload, secret);

      const result = handler.handleWebhook(jobId, payload, sig);
      expect(result.status).toBe(200);

      const jobResult = await promise;
      expect(jobResult.success).toBe(true);
      expect(jobResult.status).toBe("completed");
      expect(handler.pendingCount).toBe(0);
    });

    it("rejects on invalid HMAC signature", () => {
      const jobId = handler.generateJobId();
      handler.registerJob(jobId).catch(() => {}); // prevent unhandled rejection

      const payload = JSON.stringify({ success: true, status: "completed" });
      const result = handler.handleWebhook(jobId, payload, "bad-signature");
      expect(result.status).toBe(401);
      expect(result.message).toContain("Invalid signature");
      expect(handler.pendingCount).toBe(1);
    });

    it("returns 404 for unknown job ID", () => {
      const payload = JSON.stringify({ success: true, status: "completed" });
      const sig = sign(payload, secret);
      const result = handler.handleWebhook("nonexistent", payload, sig);
      expect(result.status).toBe(404);
    });

    it("returns 400 for invalid JSON payload", () => {
      const jobId = handler.generateJobId();
      handler.registerJob(jobId).catch(() => {}); // prevent unhandled rejection

      const payload = "not-json-{{{";
      const sig = sign(payload, secret);
      const result = handler.handleWebhook(jobId, payload, sig);
      expect(result.status).toBe(400);
      expect(result.message).toContain("Invalid JSON");
    });

    it("emits jobCompleted event", async () => {
      const jobId = handler.generateJobId();
      const promise = handler.registerJob(jobId);
      const eventSpy = vi.fn();
      handler.on("jobCompleted", eventSpy);

      const payload = JSON.stringify({
        success: true,
        status: "completed",
        data: [],
      });
      const sig = sign(payload, secret);

      handler.handleWebhook(jobId, payload, sig);
      await promise;

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ jobId }));
    });
  });

  describe("timeout", () => {
    it("rejects pending promise after timeout", async () => {
      const h = new FirecrawlWebhookHandler({
        secret,
        port: 3000,
        enabled: true,
        jobTimeoutMs: 50,
      });

      const jobId = h.generateJobId();
      const promise = h.registerJob(jobId);

      await expect(promise).rejects.toThrow("timed out");
      expect(h.pendingCount).toBe(0);
      h.shutdown();
    });
  });

  describe("shutdown", () => {
    it("rejects all pending promises", async () => {
      const jobId1 = handler.generateJobId();
      const jobId2 = handler.generateJobId();
      const promise1 = handler.registerJob(jobId1);
      const promise2 = handler.registerJob(jobId2);

      expect(handler.pendingCount).toBe(2);

      handler.shutdown();

      await expect(promise1).rejects.toThrow("shutting down");
      await expect(promise2).rejects.toThrow("shutting down");
      expect(handler.pendingCount).toBe(0);
    });
  });

  describe("rate limiting", () => {
    it("allows requests within limit", () => {
      const jobId = handler.generateJobId();
      handler.registerJob(jobId).catch(() => {});

      const payload = JSON.stringify({
        success: true,
        status: "completed",
      });
      const sig = sign(payload, secret);

      const result = handler.handleWebhook(jobId, payload, sig);
      expect(result.status).toBe(200);
    });

    it("blocks requests exceeding rate limit", () => {
      // Exhaust rate limit by creating and resolving 100 jobs
      for (let i = 0; i < 100; i++) {
        const jid = handler.generateJobId();
        handler.registerJob(jid).catch(() => {});
        const p = JSON.stringify({ success: true, status: "completed" });
        const s = sign(p, secret);
        handler.handleWebhook(jid, p, s);
      }

      // 101st should be rate limited
      const jid = handler.generateJobId();
      handler.registerJob(jid).catch(() => {});
      const p = JSON.stringify({ success: true, status: "completed" });
      const s = sign(p, secret);
      const result = handler.handleWebhook(jid, p, s);
      expect(result.status).toBe(429);
    });
  });

  describe("Buffer payload", () => {
    it("handles Buffer payload correctly", async () => {
      const jobId = handler.generateJobId();
      const promise = handler.registerJob(jobId);

      const payloadStr = JSON.stringify({
        success: true,
        status: "completed",
      });
      const payloadBuf = Buffer.from(payloadStr);
      const sig = sign(payloadStr, secret);

      const result = handler.handleWebhook(jobId, payloadBuf, sig);
      expect(result.status).toBe(200);

      const jobResult = await promise;
      expect(jobResult.success).toBe(true);
    });
  });
});

// ── Express Router ───────────────────────────────────────────────────────

describe("createFirecrawlWebhookRouter", () => {
  it("returns an Express router", () => {
    const handler = new FirecrawlWebhookHandler({
      secret: "test",
      port: 3000,
      enabled: true,
    });
    const router = createFirecrawlWebhookRouter(handler);
    expect(router).toBeDefined();
    expect(typeof router).toBe("function");
    handler.shutdown();
  });
});
