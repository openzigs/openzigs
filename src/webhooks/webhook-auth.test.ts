import { describe, it, expect, vi, beforeEach } from "vitest";
import { webhookAuth } from "./webhook-auth.js";
import type { Request, Response } from "express";
import type { WebhookConfig } from "./webhook-manager.js";

function makeWebhook(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: "wh_1",
    name: "Test Webhook",
    action: "prompt",
    actionPayload: {},
    secret: "secret123",
    apiKeyHash: "hash",
    enabled: true,
    allowedIps: [],
    rateLimit: 60,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTriggeredAt: null,
    triggerCount: 0,
    ...overrides,
  };
}

function makeManager(overrides: Record<string, unknown> = {}) {
  return {
    authenticateByApiKey: vi.fn(),
    verifySignature: vi.fn(),
    checkRateLimit: vi.fn().mockReturnValue(true),
    get: vi.fn(),
    ...overrides,
  } as any;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: {},
    ip: "127.0.0.1",
    body: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res: any = {
    _status: 0,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
  };
  return res;
}

describe("webhookAuth middleware", () => {
  // ── Bearer token auth ──

  describe("Bearer token auth", () => {
    it("authenticates with valid API key", () => {
      const webhook = makeWebhook();
      const manager = makeManager({ authenticateByApiKey: vi.fn().mockReturnValue(webhook) });
      const middleware = webhookAuth(manager);
      const req = makeReq({ headers: { authorization: "Bearer whk_valid_key" } });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as any).webhook).toBe(webhook);
    });

    it("returns 401 for invalid API key", () => {
      const manager = makeManager({ authenticateByApiKey: vi.fn().mockReturnValue(undefined) });
      const middleware = webhookAuth(manager);
      const req = makeReq({ headers: { authorization: "Bearer bad_key" } });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: "Invalid API key" });
    });

    it("returns 403 for disabled webhook", () => {
      const webhook = makeWebhook({ enabled: false });
      const manager = makeManager({ authenticateByApiKey: vi.fn().mockReturnValue(webhook) });
      const middleware = webhookAuth(manager);
      const req = makeReq({ headers: { authorization: "Bearer whk_key" } });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._json).toEqual({ error: "Webhook is disabled" });
    });

    it("returns 403 when IP is not in allowlist", () => {
      const webhook = makeWebhook({ allowedIps: ["10.0.0.1"] });
      const manager = makeManager({ authenticateByApiKey: vi.fn().mockReturnValue(webhook) });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: { authorization: "Bearer whk_key" },
        ip: "192.168.1.1",
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._json).toEqual({ error: "IP not allowed" });
    });

    it("allows request when IP is in allowlist", () => {
      const webhook = makeWebhook({ allowedIps: ["10.0.0.1"] });
      const manager = makeManager({ authenticateByApiKey: vi.fn().mockReturnValue(webhook) });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: { authorization: "Bearer whk_key" },
        ip: "10.0.0.1",
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("uses x-forwarded-for header for IP check", () => {
      const webhook = makeWebhook({ allowedIps: ["203.0.113.5"] });
      const manager = makeManager({ authenticateByApiKey: vi.fn().mockReturnValue(webhook) });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          authorization: "Bearer whk_key",
          "x-forwarded-for": "203.0.113.5, 10.0.0.1",
        },
        ip: "10.0.0.1",
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("returns 429 when rate limit is exceeded", () => {
      const webhook = makeWebhook();
      const manager = makeManager({
        authenticateByApiKey: vi.fn().mockReturnValue(webhook),
        checkRateLimit: vi.fn().mockReturnValue(false),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({ headers: { authorization: "Bearer whk_key" } });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(429);
      expect(res._json).toEqual({ error: "Rate limit exceeded" });
    });

    it("skips IP check when allowlist is empty", () => {
      const webhook = makeWebhook({ allowedIps: [] });
      const manager = makeManager({ authenticateByApiKey: vi.fn().mockReturnValue(webhook) });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: { authorization: "Bearer whk_key" },
        ip: "any.ip.address",
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // ── Signature auth ──

  describe("Signature auth", () => {
    it("authenticates with valid signature", () => {
      const webhook = makeWebhook();
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue(webhook),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=abc",
          "x-webhook-id": "wh_1",
        },
        body: { event: "test" },
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as any).webhook).toBe(webhook);
    });

    it("returns 401 for invalid signature", () => {
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(false),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=bad",
          "x-webhook-id": "wh_1",
        },
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: "Invalid signature" });
    });

    it("returns 404 when webhook ID not found", () => {
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue(undefined),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=valid",
          "x-webhook-id": "wh_missing",
        },
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
    });

    it("returns 403 when webhook is disabled (signature auth)", () => {
      const webhook = makeWebhook({ enabled: false });
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue(webhook),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=valid",
          "x-webhook-id": "wh_1",
        },
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it("returns 429 when rate limited (signature auth)", () => {
      const webhook = makeWebhook();
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue(webhook),
        checkRateLimit: vi.fn().mockReturnValue(false),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=valid",
          "x-webhook-id": "wh_1",
        },
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(429);
    });

    it("uses rawBody buffer when available", () => {
      const webhook = makeWebhook();
      const rawBody = Buffer.from('{"event":"push"}');
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue(webhook),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=valid",
          "x-webhook-id": "wh_1",
        },
        rawBody,
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(manager.verifySignature).toHaveBeenCalledWith(
        "wh_1",
        '{"event":"push"}',
        "sha256=valid",
      );
      expect(next).toHaveBeenCalled();
    });

    it("uses string body when rawBody is not a buffer", () => {
      const webhook = makeWebhook();
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue(webhook),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=valid",
          "x-webhook-id": "wh_1",
        },
        body: "raw string body",
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(manager.verifySignature).toHaveBeenCalledWith(
        "wh_1",
        "raw string body",
        "sha256=valid",
      );
    });

    it("JSON-stringifies object body when no rawBody", () => {
      const webhook = makeWebhook();
      const manager = makeManager({
        verifySignature: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue(webhook),
      });
      const middleware = webhookAuth(manager);
      const req = makeReq({
        headers: {
          "x-webhook-signature": "sha256=valid",
          "x-webhook-id": "wh_1",
        },
        body: { event: "push" },
      });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(manager.verifySignature).toHaveBeenCalledWith(
        "wh_1",
        '{"event":"push"}',
        "sha256=valid",
      );
    });
  });

  // ── No auth ──

  describe("no authentication", () => {
    it("returns 401 when no auth headers are present", () => {
      const manager = makeManager();
      const middleware = webhookAuth(manager);
      const req = makeReq();
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect((res._json as any).error).toContain("Missing authentication");
    });

    it("returns 401 when only x-webhook-signature is present (no id)", () => {
      const manager = makeManager();
      const middleware = webhookAuth(manager);
      const req = makeReq({ headers: { "x-webhook-signature": "sha256=abc" } });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it("returns 401 when only x-webhook-id is present (no signature)", () => {
      const manager = makeManager();
      const middleware = webhookAuth(manager);
      const req = makeReq({ headers: { "x-webhook-id": "wh_1" } });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });
  });
});
