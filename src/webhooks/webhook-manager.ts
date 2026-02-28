import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";

/* ── Types ── */

export type WebhookConfig = {
  id: string;
  name: string;
  /** The target prompt or goal to execute when triggered. */
  action: "prompt" | "goal";
  actionPayload: Record<string, unknown>;
  /** HMAC secret for verifying inbound webhook signatures. Hex-encoded. */
  secret: string;
  /** Hashed API key for authentication (SHA-256). */
  apiKeyHash: string;
  enabled: boolean;
  /** Optional allowlist of source IPs (CIDR or single IPs). Empty = allow all. */
  allowedIps: string[];
  /** Max requests per minute per webhook. 0 = unlimited. */
  rateLimit: number;
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt: string | null;
  triggerCount: number;
};

export type CreateWebhookInput = {
  name: string;
  action: "prompt" | "goal";
  actionPayload: Record<string, unknown>;
  allowedIps?: string[];
  rateLimit?: number;
};

export type WebhookEvent = {
  webhookId: string;
  payload: Record<string, unknown>;
  sourceIp: string;
  timestamp: Date;
};

/**
 * In-memory webhook manager with JSON file persistence.
 *
 * Production note: For real enterprise deployments, replace this with
 * a proper database (SQLite, Postgres) — the in-memory approach keeps
 * things simple for the initial MVP.
 */
export class WebhookManager {
  private webhooks = new Map<string, WebhookConfig>();
  private rateCounts = new Map<string, { count: number; windowStart: number }>();

  /** Create a new webhook and return it with the plaintext API key (shown once). */
  create(input: CreateWebhookInput): { webhook: WebhookConfig; apiKey: string } {
    const id = nanoid(12);
    const apiKey = `whk_${randomBytes(24).toString("hex")}`;
    const apiKeyHash = this.hashKey(apiKey);
    const secret = randomBytes(32).toString("hex");

    const webhook: WebhookConfig = {
      id,
      name: input.name,
      action: input.action,
      actionPayload: input.actionPayload,
      secret,
      apiKeyHash,
      enabled: true,
      allowedIps: input.allowedIps ?? [],
      rateLimit: input.rateLimit ?? 60,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastTriggeredAt: null,
      triggerCount: 0,
    };

    this.webhooks.set(id, webhook);
    return { webhook, apiKey };
  }

  /** List all webhooks (secrets are included — filter for external display). */
  list(): WebhookConfig[] {
    return [...this.webhooks.values()];
  }

  /** Get a single webhook by ID. */
  get(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  /** Toggle enabled state. */
  toggle(id: string, enabled: boolean): WebhookConfig | undefined {
    const wh = this.webhooks.get(id);
    if (!wh) return undefined;
    wh.enabled = enabled;
    wh.updatedAt = new Date().toISOString();
    return wh;
  }

  /** Delete a webhook. */
  delete(id: string): boolean {
    return this.webhooks.delete(id);
  }

  /** Rotate the API key — returns new plaintext key. */
  rotateKey(id: string): { apiKey: string } | undefined {
    const wh = this.webhooks.get(id);
    if (!wh) return undefined;
    const apiKey = `whk_${randomBytes(24).toString("hex")}`;
    wh.apiKeyHash = this.hashKey(apiKey);
    wh.updatedAt = new Date().toISOString();
    return { apiKey };
  }

  /* ── Authentication ── */

  /** Authenticate a request by API key (Bearer token). Returns the webhook or undefined. */
  authenticateByApiKey(apiKey: string): WebhookConfig | undefined {
    const hash = this.hashKey(apiKey);
    for (const wh of this.webhooks.values()) {
      if (this.safeCompare(hash, wh.apiKeyHash)) {
        return wh;
      }
    }
    return undefined;
  }

  /** Verify an HMAC-SHA256 signature. */
  verifySignature(webhookId: string, body: string, signature: string): boolean {
    const wh = this.webhooks.get(webhookId);
    if (!wh) return false;

    const expected = createHmac("sha256", wh.secret)
      .update(body)
      .digest("hex");

    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  /* ── Rate Limiting ── */

  /** Check (and consume) a rate-limit slot. Returns true if allowed. */
  checkRateLimit(webhookId: string): boolean {
    const wh = this.webhooks.get(webhookId);
    if (!wh || wh.rateLimit === 0) return true;

    const now = Date.now();
    const entry = this.rateCounts.get(webhookId);
    if (!entry || now - entry.windowStart > 60_000) {
      this.rateCounts.set(webhookId, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= wh.rateLimit) return false;
    entry.count += 1;
    return true;
  }

  /** Record a successful trigger. */
  recordTrigger(webhookId: string): void {
    const wh = this.webhooks.get(webhookId);
    if (!wh) return;
    wh.triggerCount += 1;
    wh.lastTriggeredAt = new Date().toISOString();
    wh.updatedAt = new Date().toISOString();
  }

  /* ── Helpers ── */

  private hashKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  private safeCompare(a: string, b: string): boolean {
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }
}
