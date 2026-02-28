import type { Request, Response, NextFunction } from "express";
import type { WebhookManager } from "./webhook-manager.js";

/**
 * Express middleware that authenticates inbound webhook requests.
 *
 * Authentication methods (checked in order):
 * 1. Bearer token in `Authorization` header → API key lookup
 * 2. `X-Webhook-Signature` header → HMAC signature verification (requires `X-Webhook-Id`)
 *
 * On success, attaches the webhook config to `req.webhook`.
 * On failure, returns 401/403 with JSON error.
 */
export const webhookAuth = (webhookManager: WebhookManager) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    // ── Bearer token auth ──
    if (authHeader?.startsWith("Bearer ")) {
      const apiKey = authHeader.slice(7);
      const webhook = webhookManager.authenticateByApiKey(apiKey);
      if (!webhook) {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }
      if (!webhook.enabled) {
        res.status(403).json({ error: "Webhook is disabled" });
        return;
      }

      // IP allowlist check
      if (webhook.allowedIps.length > 0) {
        const sourceIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip ?? "";
        if (!webhook.allowedIps.includes(sourceIp)) {
          res.status(403).json({ error: "IP not allowed" });
          return;
        }
      }

      // Rate limit check
      if (!webhookManager.checkRateLimit(webhook.id)) {
        res.status(429).json({ error: "Rate limit exceeded" });
        return;
      }

      (req as unknown as Record<string, unknown>).webhook = webhook;
      next();
      return;
    }

    // ── Signature auth ──
    const signature = req.headers["x-webhook-signature"] as string | undefined;
    const webhookId = req.headers["x-webhook-id"] as string | undefined;

    if (signature && webhookId) {
      const rawBody = (req as unknown as Record<string, unknown>).rawBody;
      const body = Buffer.isBuffer(rawBody)
        ? rawBody.toString("utf8")
        : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      const valid = webhookManager.verifySignature(webhookId, body, signature);
      if (!valid) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      const webhook = webhookManager.get(webhookId);
      if (!webhook) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      if (!webhook.enabled) {
        res.status(403).json({ error: "Webhook is disabled" });
        return;
      }

      if (!webhookManager.checkRateLimit(webhook.id)) {
        res.status(429).json({ error: "Rate limit exceeded" });
        return;
      }

      (req as unknown as Record<string, unknown>).webhook = webhook;
      next();
      return;
    }

    res.status(401).json({ error: "Missing authentication. Provide a Bearer token or X-Webhook-Signature + X-Webhook-Id headers." });
  };
};
