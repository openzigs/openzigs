/**
 * Shared types for real-time crawl progress streaming (#841).
 *
 * Used by:
 *  - FirecrawlWebhookHandler (emitter)
 *  - server.ts (Socket.IO bridge)
 *  - UI CrawlProgressPanel (consumer)
 */

// ── Per-crawl stats tracked in the webhook handler ──────────────────────

export interface CrawlPageError {
  url: string;
  statusCode?: number;
  message?: string;
}

export interface CrawlStats {
  jobId: string;
  siteUrl: string;
  pagesScraped: number;
  estimatedTotal: number;
  errorCount: number;
  lastUrl: string;
  startedAt: string; // ISO-8601
  completedAt: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Socket.IO room id (clientId) to scope progress events to a single browser tab. */
  clientId?: string;
  /** Recent per-page errors (capped at 50, oldest dropped). */
  errors: CrawlPageError[];
}

// ── Socket.IO event payloads ────────────────────────────────────────────

export interface CrawlStartedEvent {
  jobId: string;
  siteUrl: string;
  estimatedTotal: number;
  startedAt: string;
  clientId?: string;
}

export interface CrawlProgressEvent {
  jobId: string;
  siteUrl: string;
  pagesScraped: number;
  estimatedTotal: number;
  errorCount: number;
  lastUrl: string;
  elapsedMs: number;
  clientId?: string;
  /** Most recent error, if any. Useful for surfacing live error info. */
  lastError?: CrawlPageError;
}

export interface CrawlCompletedEvent {
  jobId: string;
  siteUrl: string;
  pagesScraped: number;
  errorCount: number;
  elapsedMs: number;
  status: "completed" | "failed" | "cancelled";
  clientId?: string;
  errors?: CrawlPageError[];
}

// ── Event name constants ────────────────────────────────────────────────

export const CRAWL_EVENTS = {
  STARTED: "crawl:started",
  PROGRESS: "crawl:progress",
  COMPLETED: "crawl:completed",
} as const;
