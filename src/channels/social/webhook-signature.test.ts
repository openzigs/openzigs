import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "./webhook-signature.js";
import type { WebhookSecretConfig } from "./webhook-signature.js";

// Suppress logger output in tests
vi.mock("../../logging/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("verifyWebhookSignature", () => {
  const secrets: WebhookSecretConfig = {
    twitter: "twitter-test-secret",
    meta: "meta-test-secret",
  };

  // ── Twitter ──

  describe("twitter", () => {
    it("returns true for a valid Twitter signature", () => {
      const body = Buffer.from('{"event":"message"}');
      const expected = createHmac("sha256", "twitter-test-secret").update(body).digest("base64");
      const headers = { "x-twitter-webhooks-signature": `sha256=${expected}` };

      expect(verifyWebhookSignature("twitter", body, headers, secrets)).toBe(true);
    });

    it("returns false for an invalid Twitter signature", () => {
      const body = Buffer.from('{"event":"message"}');
      const headers = { "x-twitter-webhooks-signature": "sha256=INVALIDSIGNATURE" };

      expect(verifyWebhookSignature("twitter", body, headers, secrets)).toBe(false);
    });

    it("returns false when Twitter signature header is missing", () => {
      const body = Buffer.from('{"event":"message"}');
      const headers = {};

      expect(verifyWebhookSignature("twitter", body, headers, secrets)).toBe(false);
    });

    it("returns null when no Twitter secret is configured", () => {
      const body = Buffer.from('{"event":"message"}');
      const headers = { "x-twitter-webhooks-signature": "sha256=whatever" };

      expect(verifyWebhookSignature("twitter", body, headers, {})).toBeNull();
    });
  });

  // ── Meta (Instagram / Facebook) ──

  describe("instagram (Meta)", () => {
    it("returns true for a valid Meta signature", () => {
      const body = Buffer.from('{"entry":[{"changes":[]}]}');
      const expected = createHmac("sha256", "meta-test-secret").update(body).digest("hex");
      const headers = { "x-hub-signature-256": `sha256=${expected}` };

      expect(verifyWebhookSignature("instagram", body, headers, secrets)).toBe(true);
    });

    it("returns false for an invalid Meta signature", () => {
      const body = Buffer.from('{"entry":[]}');
      const headers = { "x-hub-signature-256": "sha256=deadbeef" };

      expect(verifyWebhookSignature("instagram", body, headers, secrets)).toBe(false);
    });

    it("returns false when X-Hub-Signature-256 header is missing", () => {
      const body = Buffer.from('{"entry":[]}');
      const headers = {};

      expect(verifyWebhookSignature("instagram", body, headers, secrets)).toBe(false);
    });

    it("returns null when no Meta secret is configured", () => {
      const body = Buffer.from('{"entry":[]}');
      const headers = { "x-hub-signature-256": "sha256=whatever" };

      expect(verifyWebhookSignature("instagram", body, headers, {})).toBeNull();
    });
  });

  describe("facebook (Meta)", () => {
    it("returns true for a valid Meta signature on facebook platform", () => {
      const body = Buffer.from('{"object":"page"}');
      const expected = createHmac("sha256", "meta-test-secret").update(body).digest("hex");
      const headers = { "x-hub-signature-256": `sha256=${expected}` };

      expect(verifyWebhookSignature("facebook", body, headers, secrets)).toBe(true);
    });

    it("returns false for an invalid signature on facebook platform", () => {
      const body = Buffer.from('{"object":"page"}');
      const headers = { "x-hub-signature-256": "sha256=wrong" };

      expect(verifyWebhookSignature("facebook", body, headers, secrets)).toBe(false);
    });
  });

  // ── Polling-only platforms (no webhook signatures) ──

  describe("polling-only platforms", () => {
    const pollingPlatforms = ["reddit", "youtube", "tiktok", "linkedin"] as const;
    for (const platform of pollingPlatforms) {
      it(`returns null for ${platform} (no webhook signature scheme)`, () => {
        const body = Buffer.from("{}");
        const headers = {};
        expect(verifyWebhookSignature(platform, body, headers, secrets)).toBeNull();
      });
    }
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("rejects a tampered body even with a correctly formatted signature prefix", () => {
      const originalBody = Buffer.from('{"event":"message"}');
      const tamperedBody = Buffer.from('{"event":"malicious"}');
      const sig = createHmac("sha256", "twitter-test-secret").update(originalBody).digest("base64");
      const headers = { "x-twitter-webhooks-signature": `sha256=${sig}` };

      expect(verifyWebhookSignature("twitter", tamperedBody, headers, secrets)).toBe(false);
    });

    it("handles empty body correctly for Twitter", () => {
      const body = Buffer.from("");
      const expected = createHmac("sha256", "twitter-test-secret").update(body).digest("base64");
      const headers = { "x-twitter-webhooks-signature": `sha256=${expected}` };

      expect(verifyWebhookSignature("twitter", body, headers, secrets)).toBe(true);
    });

    it("handles empty body correctly for Meta", () => {
      const body = Buffer.from("");
      const expected = createHmac("sha256", "meta-test-secret").update(body).digest("hex");
      const headers = { "x-hub-signature-256": `sha256=${expected}` };

      expect(verifyWebhookSignature("instagram", body, headers, secrets)).toBe(true);
    });

    it("rejects signature with wrong prefix for Twitter", () => {
      const body = Buffer.from('{"test":true}');
      const digest = createHmac("sha256", "twitter-test-secret").update(body).digest("base64");
      // Wrong prefix — "sha1=" instead of "sha256="
      const headers = { "x-twitter-webhooks-signature": `sha1=${digest}` };

      expect(verifyWebhookSignature("twitter", body, headers, secrets)).toBe(false);
    });

    it("rejects signature with wrong prefix for Meta", () => {
      const body = Buffer.from('{"test":true}');
      const digest = createHmac("sha256", "meta-test-secret").update(body).digest("hex");
      // Wrong prefix
      const headers = { "x-hub-signature-256": `sha1=${digest}` };

      expect(verifyWebhookSignature("instagram", body, headers, secrets)).toBe(false);
    });

    it("rejects when signature header is an array instead of string", () => {
      const body = Buffer.from('{"test":true}');
      const headers = { "x-hub-signature-256": ["sha256=abc", "sha256=def"] };

      expect(verifyWebhookSignature("instagram", body, headers, secrets)).toBe(false);
    });
  });
});
