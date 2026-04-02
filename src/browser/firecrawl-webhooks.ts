/**
 * Firecrawl Webhook Handler
 *
 * Receives completion callbacks from Firecrawl for async crawl and batch scrape jobs.
 * Features:
 * - HMAC-SHA256 signature validation on all incoming payloads
 * - Promise-based pending job registry with timeout cleanup
 * - Express route factory for mounting at /api/webhooks/firecrawl
 * - Rate limiting (100 req/min)
 * - Graceful shutdown: rejects all pending promises on server stop
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { Router, type Request, type Response } from "express";
import { logger } from "../logging/logger.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface WebhookJobResult {
  success: boolean;
  status: string;
  data?: Record<string, unknown>[] | Record<string, unknown>;
  error?: string;
}

interface PendingJob {
  resolve: (result: WebhookJobResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

export interface FirecrawlWebhookConfig {
  /** Shared secret for HMAC-SHA256 signature validation */
  secret: string;
  /** Port used to construct the webhook callback URL */
  port: number;
  /** Whether webhooks are enabled (default: true) */
  enabled: boolean;
  /** Timeout for pending jobs in ms (default: 10 min) */
  jobTimeoutMs?: number;
}

// ── HMAC Validation ──────────────────────────────────────────────────────

/**
 * Validates an HMAC-SHA256 signature against a payload.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateWebhookSignature(
  payload: Buffer | string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const payloadBuf =
    typeof payload === "string" ? Buffer.from(payload) : payload;
  const expected = createHmac("sha256", secret)
    .update(payloadBuf)
    .digest("hex");

  // Both must have the same length for timingSafeEqual
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ── Webhook Handler ──────────────────────────────────────────────────────

export class FirecrawlWebhookHandler extends EventEmitter {
  private pending = new Map<string, PendingJob>();
  private config: FirecrawlWebhookConfig;
  private requestTimes: number[] = [];
  private readonly MAX_REQUESTS_PER_MINUTE = 100;

  constructor(config: FirecrawlWebhookConfig) {
    super();
    this.config = config;
  }

  /** Generate a unique job ID for webhook tracking */
  generateJobId(): string {
    return randomBytes(16).toString("hex");
  }

  /** Get the webhook callback URL for a given job ID */
  getWebhookUrl(jobId: string): string {
    return `http://localhost:${this.config.port}/api/webhooks/firecrawl?jobId=${encodeURIComponent(jobId)}`;
  }

  /** Whether webhooks are enabled and configured */
  get enabled(): boolean {
    return this.config.enabled && !!this.config.secret;
  }

  /** Get the shared secret (for passing to Firecrawl container) */
  get secret(): string {
    return this.config.secret;
  }

  /**
   * Register a pending job. Returns a promise that resolves when the webhook fires
   * or rejects on timeout.
   */
  registerJob(jobId: string): Promise<WebhookJobResult> {
    return new Promise<WebhookJobResult>((resolve, reject) => {
      const timeoutMs = this.config.jobTimeoutMs ?? 600_000; // 10 min
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        reject(
          new Error(
            `Firecrawl webhook job ${jobId} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      // Don't keep the process alive just for job timeouts
      if (timer && typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      this.pending.set(jobId, {
        resolve,
        reject,
        timer,
        createdAt: Date.now(),
      });
    });
  }

  /**
   * Handle an incoming webhook payload. Validates HMAC, looks up pending job,
   * and resolves its promise.
   */
  handleWebhook(
    jobId: string,
    payload: Buffer | string,
    signature: string,
  ): { status: number; message: string } {
    // Rate limiting
    if (!this.checkRateLimit()) {
      return { status: 429, message: "Too many requests" };
    }

    // HMAC validation
    if (!validateWebhookSignature(payload, signature, this.config.secret)) {
      logger.warn("[FirecrawlWebhook] Invalid HMAC signature", { jobId });
      return { status: 401, message: "Invalid signature" };
    }

    // Look up pending job
    const pending = this.pending.get(jobId);
    if (!pending) {
      logger.warn("[FirecrawlWebhook] No pending job found", { jobId });
      return { status: 404, message: "Job not found" };
    }

    // Parse payload
    let result: WebhookJobResult;
    try {
      const payloadStr =
        typeof payload === "string" ? payload : payload.toString("utf-8");
      result = JSON.parse(payloadStr) as WebhookJobResult;
    } catch {
      logger.error("[FirecrawlWebhook] Invalid JSON payload", { jobId });
      return { status: 400, message: "Invalid JSON payload" };
    }

    // Resolve the pending promise
    clearTimeout(pending.timer);
    this.pending.delete(jobId);
    pending.resolve(result);
    this.emit("jobCompleted", { jobId, result });

    return { status: 200, message: "OK" };
  }

  /** Get count of pending jobs */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Reject all pending jobs. Called during graceful shutdown.
   */
  shutdown(): void {
    const error = new Error("Server shutting down — webhook handler closed");
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.removeAllListeners();
  }

  /** Simple sliding-window rate limiter: max 100 requests per 60 seconds */
  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    this.requestTimes = this.requestTimes.filter((t) => now - t < windowMs);
    if (this.requestTimes.length >= this.MAX_REQUESTS_PER_MINUTE) {
      return false;
    }
    this.requestTimes.push(now);
    return true;
  }
}

// ── Express Router ───────────────────────────────────────────────────────

/**
 * Creates an Express router for the Firecrawl webhook endpoint.
 * Must be mounted BEFORE any tunnel middleware to keep it internal-only.
 */
export function createFirecrawlWebhookRouter(
  handler: FirecrawlWebhookHandler,
): Router {
  const router = Router();

  // Use raw body for HMAC verification
  router.post("/", (req: Request, res: Response) => {
    const jobId = req.query.jobId as string | undefined;
    if (!jobId) {
      res.status(400).json({ error: "Missing jobId query parameter" });
      return;
    }

    // Validate webhook origin is localhost using the actual TCP source IP
    // (req.hostname is derived from the Host header and is attacker-controlled)
    const remoteAddr = req.socket.remoteAddress;
    if (
      remoteAddr !== "127.0.0.1" &&
      remoteAddr !== "::1" &&
      remoteAddr !== "::ffff:127.0.0.1"
    ) {
      res
        .status(403)
        .json({ error: "Webhook only accepts localhost requests" });
      return;
    }

    const signature =
      (req.headers["x-webhook-signature"] as string) ??
      (req.headers["x-firecrawl-signature"] as string) ??
      "";

    // Use the raw body buffer captured by the express.json verify callback
    // to ensure HMAC is verified against the exact bytes Firecrawl sent
    const rawBody = (req as unknown as Record<string, Buffer>).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Missing raw body for HMAC verification" });
      return;
    }

    const result = handler.handleWebhook(jobId, rawBody, signature);
    res.status(result.status).json({ message: result.message });
  });

  return router;
}

// ── Secret Generation ────────────────────────────────────────────────────

/** Generate a cryptographically secure random secret for HMAC signing */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
