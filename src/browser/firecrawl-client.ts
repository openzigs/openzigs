/**
 * Firecrawl Client — HTTP client + on-demand Docker sidecar lifecycle.
 *
 * Features:
 * - Auto-starts Firecrawl Docker containers on first use
 * - Auto-stops after configurable idle timeout (default 10 min)
 * - SSRF URL validation (blocks internal network addresses)
 * - Per-domain rate limiting (max 1 req/sec per domain)
 * - Graceful degradation when Docker unavailable
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { logger } from "../logging/logger.js";
import { PROJECT_ROOT } from "../project-root.js";
import type {
  FirecrawlWebhookHandler,
  WebhookJobResult,
} from "./firecrawl-webhooks.js";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────

export interface ScrapeOptions {
  formats?: ("markdown" | "html")[];
  actions?: ScrapeAction[];
  waitFor?: number;
}

export interface ScrapeAction {
  type:
    | "wait"
    | "click"
    | "write"
    | "press"
    | "scroll"
    | "screenshot"
    | "scrape"
    | "executeJavascript"
    | "pdf";
  selector?: string;
  text?: string;
  key?: string;
  milliseconds?: number;
  direction?: "up" | "down";
  fullPage?: boolean;
  script?: string;
  all?: boolean;
}

export interface ScrapeResult {
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
  url?: string;
}

export interface CrawlOptions {
  limit?: number;
  maxDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
  scrapeOptions?: ScrapeOptions;
}

export interface CrawlPage {
  markdown?: string;
  html?: string;
  url: string;
  metadata?: Record<string, unknown>;
  statusCode?: number;
}

export interface CrawlResult {
  pages: CrawlPage[];
  totalPages: number;
  jobId?: string;
}

export interface MapOptions {
  search?: string;
  limit?: number;
  ignoreSitemap?: boolean;
}

export interface MapResult {
  urls: string[];
}

export interface BatchScrapeOptions {
  formats?: ("markdown" | "html")[];
  actions?: ScrapeAction[];
  waitFor?: number;
}

export interface BatchScrapeResult {
  results: ScrapeResult[];
  totalUrls: number;
  jobId?: string;
}

export interface SearchOptions {
  limit?: number;
  lang?: string;
  country?: string;
  scrapeOptions?: ScrapeOptions;
}

export interface SearchResult {
  title: string;
  url: string;
  markdown: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface FirecrawlConfig {
  enabled: boolean;
  url: string;
  idleTimeoutMs: number;
}

const DEFAULT_CONFIG: FirecrawlConfig = {
  enabled: false,
  url: "http://localhost:3002",
  idleTimeoutMs: 600_000, // 10 minutes
};

// ── SSRF Protection ──────────────────────────────────────────────────────

const BLOCKED_IPV4_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // private class A
  /^172\.(1[6-9]|2\d|3[0-1])\./, // private class B
  /^192\.168\./, // private class C
  /^169\.254\./, // link-local
  /^0\./, // current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "[::1]",
  "[::0]",
  "[::]",
  "[0000::1]",
  "::1",
  "::0",
  "::",
  "0000::1",
]);

/**
 * Validates that a URL does not target an internal/private network address.
 * @returns true if the URL is blocked (SSRF attempt), false if safe.
 */
export function isBlockedUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true; // malformed = blocked
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;

  // IPv6 loopback variants
  if (hostname.startsWith("[")) {
    const inner = hostname.slice(1, -1);
    // Normalize and check for ::1 forms
    if (
      inner === "::1" ||
      inner === "::0" ||
      inner === "0:0:0:0:0:0:0:1" ||
      inner === "0:0:0:0:0:0:0:0"
    ) {
      return true;
    }
    // IPv4-mapped IPv6
    if (inner.startsWith("::ffff:")) {
      const ipv4 = inner.slice(7);
      return BLOCKED_IPV4_PATTERNS.some((p) => p.test(ipv4));
    }
    return false;
  }

  // IPv4 patterns
  if (BLOCKED_IPV4_PATTERNS.some((p) => p.test(hostname))) return true;

  // Block file: protocol
  if (parsed.protocol === "file:") return true;

  return false;
}

// ── Rate Limiter ─────────────────────────────────────────────────────────

class DomainRateLimiter {
  private lastRequestTime = new Map<string, number>();
  private minIntervalMs: number;
  private maxEntries: number;

  constructor(minIntervalMs = 1000, maxEntries = 1000) {
    this.minIntervalMs = minIntervalMs;
    this.maxEntries = maxEntries;
  }

  async waitForDomain(domain: string): Promise<void> {
    const now = Date.now();
    const lastTime = this.lastRequestTime.get(domain) ?? 0;
    const elapsed = now - lastTime;

    if (elapsed < this.minIntervalMs) {
      const delay = this.minIntervalMs - elapsed;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.lastRequestTime.set(domain, Date.now());
    this.evictIfNeeded();
  }

  /** Evict oldest half of entries when map exceeds maxEntries */
  private evictIfNeeded(): void {
    if (this.lastRequestTime.size <= this.maxEntries) return;
    const entries = [...this.lastRequestTime.entries()].sort(
      (a, b) => a[1] - b[1],
    );
    const toRemove = Math.floor(entries.length / 2);
    for (let i = 0; i < toRemove; i++) {
      this.lastRequestTime.delete(entries[i][0]);
    }
  }

  /** For testing: clear rate limit state */
  clear(): void {
    this.lastRequestTime.clear();
  }

  /** For testing: current map size */
  get size(): number {
    return this.lastRequestTime.size;
  }
}

// ── Firecrawl Client ─────────────────────────────────────────────────────

export class FirecrawlClient {
  private config: FirecrawlConfig;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private sidecarRunning = false;
  private startingPromise: Promise<boolean> | null = null;
  private rateLimiter = new DomainRateLimiter();
  private composeFile: string;
  private _fetch: typeof fetch;
  private _webhookHandler: FirecrawlWebhookHandler | null = null;

  constructor(config?: Partial<FirecrawlConfig>, fetchFn?: typeof fetch) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.composeFile = path.join(PROJECT_ROOT, "docker-compose.firecrawl.yml");
    this._fetch = fetchFn ?? globalThis.fetch;
  }

  /** Set a webhook handler for async job notifications (crawl, batch scrape) */
  setWebhookHandler(handler: FirecrawlWebhookHandler | null): void {
    this._webhookHandler = handler;
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Scrape a single URL and return its content.
   */
  async scrape(url: string, options?: ScrapeOptions): Promise<ScrapeResult> {
    this.validateUrl(url);
    await this.ensureRunning();
    await this.rateLimiter.waitForDomain(this.getDomain(url));
    this.resetIdleTimer();

    const body: Record<string, unknown> = {
      url,
      formats: options?.formats ?? ["markdown"],
    };
    if (options?.actions) body.actions = options.actions;
    if (options?.waitFor) body.waitFor = options.waitFor;

    const resp = await this.request("/v1/scrape", body);
    const data = resp.data as Record<string, unknown> | undefined;
    const metadata = data?.metadata as Record<string, unknown> | undefined;
    return {
      markdown: data?.markdown as string | undefined,
      html: data?.html as string | undefined,
      metadata,
      url: (metadata?.sourceURL as string | undefined) ?? url,
    };
  }

  /**
   * Crawl a website recursively and return all pages.
   * Uses webhook callbacks when available, falls back to polling.
   */
  async crawl(url: string, options?: CrawlOptions): Promise<CrawlResult> {
    this.validateUrl(url);
    await this.ensureRunning();
    await this.rateLimiter.waitForDomain(this.getDomain(url));
    this.resetIdleTimer();

    const body: Record<string, unknown> = { url };
    if (options?.limit) body.limit = options.limit;
    if (options?.maxDepth) body.maxDepth = options.maxDepth;
    if (options?.includePaths) body.includePaths = options.includePaths;
    if (options?.excludePaths) body.excludePaths = options.excludePaths;
    if (options?.scrapeOptions) body.scrapeOptions = options.scrapeOptions;

    // Attach webhook URL if handler is available
    let webhookJobId: string | undefined;
    let webhookPromise: Promise<WebhookJobResult> | undefined;
    if (this._webhookHandler?.enabled) {
      webhookJobId = this._webhookHandler.generateJobId();
      body.webhook = this._webhookHandler.getWebhookUrl(webhookJobId);
      webhookPromise = this._webhookHandler.registerJob(webhookJobId);
    }

    const startResp = await this.request("/v1/crawl", body);
    const jobId = (startResp.id ?? startResp.jobId) as string | undefined;

    if (!jobId) {
      // Synchronous response (some Firecrawl versions return data directly)
      const syncData = startResp.data as Record<string, unknown>[] | undefined;
      if (syncData && Array.isArray(syncData)) {
        return {
          pages: syncData.map((p) => ({
            markdown: p.markdown as string | undefined,
            html: p.html as string | undefined,
            url: ((p.metadata as Record<string, unknown>)?.sourceURL ??
              p.url ??
              "") as string,
            metadata: p.metadata as Record<string, unknown> | undefined,
            statusCode: p.statusCode as number | undefined,
          })),
          totalPages: syncData.length,
        };
      }
      throw new Error("Firecrawl crawl response missing job ID");
    }

    // Always register for UI progress tracking regardless of webhook vs polling
    if (this._webhookHandler) {
      this._webhookHandler.registerCrawl(
        webhookJobId ?? jobId,
        url,
        options?.limit ?? 0,
      );
    }

    // Try webhook-based completion first, fall back to polling
    if (webhookPromise) {
      try {
        const webhookResult = await webhookPromise;
        if (this._webhookHandler) {
          this._webhookHandler.completeCrawl(
            webhookJobId ?? jobId,
            webhookResult.success ? "completed" : "failed",
          );
        }
        return this.parseCrawlResult(webhookResult, jobId);
      } catch (err) {
        logger.warn(
          "[FirecrawlClient] Webhook delivery failed, falling back to polling",
          {
            jobId,
            error: String(err),
          },
        );
      }
    }

    return this.pollCrawlJob(jobId, url, options?.limit);
  }

  /**
   * Map a website to discover all URLs without scraping content.
   */
  async map(url: string, options?: MapOptions): Promise<MapResult> {
    this.validateUrl(url);
    await this.ensureRunning();
    await this.rateLimiter.waitForDomain(this.getDomain(url));
    this.resetIdleTimer();

    const body: Record<string, unknown> = { url };
    if (options?.search) body.search = options.search;
    if (options?.limit) body.limit = options.limit;
    if (options?.ignoreSitemap !== undefined)
      body.ignoreSitemap = options.ignoreSitemap;

    const resp = await this.request("/v1/map", body);
    return {
      urls: (resp.links ?? resp.urls ?? []) as string[],
    };
  }

  /**
   * Batch scrape multiple URLs concurrently.
   * Uses webhook callbacks when available, falls back to polling.
   */
  async batchScrape(
    urls: string[],
    options?: BatchScrapeOptions,
  ): Promise<BatchScrapeResult> {
    for (const u of urls) this.validateUrl(u);
    if (urls.length === 0) return { results: [], totalUrls: 0 };
    await this.ensureRunning();
    await this.rateLimiter.waitForDomain(this.getDomain(urls[0]));
    this.resetIdleTimer();

    const body: Record<string, unknown> = {
      urls,
      formats: options?.formats ?? ["markdown"],
    };
    if (options?.actions) body.actions = options.actions;
    if (options?.waitFor) body.waitFor = options.waitFor;

    // Attach webhook URL if handler is available
    let webhookJobId: string | undefined;
    let webhookPromise: Promise<WebhookJobResult> | undefined;
    if (this._webhookHandler?.enabled) {
      webhookJobId = this._webhookHandler.generateJobId();
      body.webhook = this._webhookHandler.getWebhookUrl(webhookJobId);
      webhookPromise = this._webhookHandler.registerJob(webhookJobId);
    }

    const startResp = await this.request("/v1/batch/scrape", body);
    const jobId = (startResp.id ?? startResp.jobId) as string | undefined;

    if (!jobId) {
      // Synchronous response
      const syncData = startResp.data as Record<string, unknown>[] | undefined;
      if (syncData && Array.isArray(syncData)) {
        return {
          results: syncData.map((d) => ({
            markdown: d.markdown as string | undefined,
            html: d.html as string | undefined,
            metadata: d.metadata as Record<string, unknown> | undefined,
            url: ((d.metadata as Record<string, unknown>)?.sourceURL ??
              d.url ??
              "") as string,
          })),
          totalUrls: syncData.length,
        };
      }
      throw new Error("Firecrawl batch scrape response missing job ID");
    }

    // Try webhook-based completion first, fall back to polling
    if (webhookPromise) {
      try {
        const webhookResult = await webhookPromise;
        return this.parseBatchResult(webhookResult, jobId);
      } catch (err) {
        logger.warn(
          "[FirecrawlClient] Webhook delivery failed for batch, falling back to polling",
          {
            jobId,
            error: String(err),
          },
        );
      }
    }

    return this.pollBatchJob(jobId);
  }

  /**
   * Search the web via Firecrawl's /v2/search endpoint (DuckDuckGo fallback).
   * Returns search results with optional scraped markdown content.
   */
  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    if (!query || query.trim().length === 0) {
      throw new Error("Search query must not be empty");
    }
    await this.ensureRunning();
    this.resetIdleTimer();

    const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);
    const body: Record<string, unknown> = { query, limit };
    if (options?.lang) body.lang = options.lang;
    if (options?.country) body.country = options.country;
    if (options?.scrapeOptions) body.scrapeOptions = options.scrapeOptions;

    const resp = await this.request("/v2/search", body);
    const rawResults = (resp.data ?? []) as Record<string, unknown>[];

    return rawResults
      .filter((r) => {
        const url = (r.url ?? "") as string;
        return url.length > 0 && !isBlockedUrl(url);
      })
      .map((r) => ({
        title: (r.title ?? "") as string,
        url: (r.url ?? "") as string,
        markdown: (r.markdown ?? "") as string,
        description: (r.description ?? undefined) as string | undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
      }));
  }

  /**
   * Check if Firecrawl sidecar is reachable.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) return false;
    try {
      const resp = await this._fetch(`${this.config.url}/`, {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Stop the Firecrawl sidecar.
   */
  async shutdown(): Promise<void> {
    this.clearIdleTimer();
    if (!this.sidecarRunning) return;

    try {
      await execFileAsync(
        "docker",
        ["compose", "-f", this.composeFile, "down"],
        { timeout: 30_000 },
      );
      this.sidecarRunning = false;
      logger.info("[FirecrawlClient] Sidecar stopped");
    } catch (err) {
      logger.warn("[FirecrawlClient] Failed to stop sidecar", {
        error: String(err),
      });
    }
  }

  /** Get current config (for testing) */
  getConfig(): Readonly<FirecrawlConfig> {
    return { ...this.config };
  }

  /** Clear rate limiter state (for testing) */
  clearRateLimiter(): void {
    this.rateLimiter.clear();
  }

  /** Mark sidecar as running (for testing — skips Docker startup) */
  _setRunning(running: boolean): void {
    this.sidecarRunning = running;
  }

  // ── Internal ───────────────────────────────────────────

  private validateUrl(url: string): void {
    if (isBlockedUrl(url)) {
      throw new Error(
        `SSRF blocked: URL "${url}" targets an internal/private network address`,
      );
    }
  }

  private getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "unknown";
    }
  }

  private async ensureRunning(): Promise<void> {
    if (!this.config.enabled) {
      throw new Error(
        "Firecrawl is not enabled. Set firecrawl.enabled to true in config.",
      );
    }

    // Check if already reachable (including externally-started instances)
    if (await this.isAvailableQuick()) {
      this.sidecarRunning = true;
      this.resetIdleTimer();
      return;
    }

    // Deduplicate concurrent startup attempts
    if (this.startingPromise) {
      const ok = await this.startingPromise;
      if (!ok) throw new Error("Firecrawl sidecar failed to start");
      return;
    }

    this.startingPromise = this.startSidecar();
    try {
      const ok = await this.startingPromise;
      if (!ok) throw new Error("Firecrawl sidecar failed to start");
    } finally {
      this.startingPromise = null;
    }
  }

  private async isAvailableQuick(): Promise<boolean> {
    try {
      const resp = await this._fetch(`${this.config.url}/`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async startSidecar(): Promise<boolean> {
    try {
      // Check if docker is available
      await execFileAsync("docker", ["info"], { timeout: 10_000 });
    } catch {
      logger.warn(
        "[FirecrawlClient] Docker not available — sidecar cannot start",
      );
      return false;
    }

    try {
      logger.info("[FirecrawlClient] Starting Firecrawl sidecar...");
      await execFileAsync(
        "docker",
        ["compose", "-f", this.composeFile, "up", "-d"],
        { timeout: 120_000 },
      );

      // Wait for health check with retries
      const maxRetries = 15;
      for (let i = 0; i < maxRetries; i++) {
        if (await this.isAvailableQuick()) {
          this.sidecarRunning = true;
          logger.info("[FirecrawlClient] Sidecar is healthy");
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      logger.error(
        "[FirecrawlClient] Sidecar failed to become healthy after retries",
      );
      return false;
    } catch (err) {
      logger.error("[FirecrawlClient] Failed to start sidecar", {
        error: String(err),
      });
      return false;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logger.info("[FirecrawlClient] Idle timeout reached — stopping sidecar");
      void this.shutdown();
    }, this.config.idleTimeoutMs);
    // Prevent idle timer from keeping the process alive
    if (
      this.idleTimer &&
      typeof this.idleTimer === "object" &&
      "unref" in this.idleTimer
    ) {
      this.idleTimer.unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async request(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resp = await this._fetch(`${this.config.url}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `Firecrawl ${endpoint} failed: ${resp.status} ${resp.statusText} — ${text}`,
      );
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  /** Parse a webhook result into a CrawlResult */
  private parseCrawlResult(
    webhookResult: WebhookJobResult,
    jobId: string,
  ): CrawlResult {
    if (!webhookResult.success) {
      throw new Error(
        `Firecrawl crawl job ${jobId} failed via webhook: ${webhookResult.error ?? "unknown error"}`,
      );
    }
    const pages = (
      Array.isArray(webhookResult.data) ? webhookResult.data : []
    ) as Record<string, unknown>[];
    return {
      pages: pages.map((p) => ({
        markdown: p.markdown as string | undefined,
        html: p.html as string | undefined,
        url: ((p.metadata as Record<string, unknown>)?.sourceURL ??
          p.url ??
          "") as string,
        metadata: p.metadata as Record<string, unknown> | undefined,
        statusCode: p.statusCode as number | undefined,
      })),
      totalPages: pages.length,
      jobId,
    };
  }

  /** Parse a webhook result into a BatchScrapeResult */
  private parseBatchResult(
    webhookResult: WebhookJobResult,
    jobId: string,
  ): BatchScrapeResult {
    if (!webhookResult.success) {
      throw new Error(
        `Firecrawl batch job ${jobId} failed via webhook: ${webhookResult.error ?? "unknown error"}`,
      );
    }
    const results = (
      Array.isArray(webhookResult.data) ? webhookResult.data : []
    ) as Record<string, unknown>[];
    return {
      results: results.map((d) => ({
        markdown: d.markdown as string | undefined,
        html: d.html as string | undefined,
        metadata: d.metadata as Record<string, unknown> | undefined,
        url: ((d.metadata as Record<string, unknown>)?.sourceURL ??
          d.url ??
          "") as string,
      })),
      totalUrls: results.length,
      jobId,
    };
  }

  private async pollCrawlJob(
    jobId: string,
    siteUrl?: string,
    estimatedTotal?: number,
  ): Promise<CrawlResult> {
    const maxPolls = 300; // 5 minutes at 1s intervals
    const pollInterval = 1000;

    // crawl:started was already emitted by crawl() — just log the poll start
    logger.info("[FirecrawlClient] Polling crawl job", {
      jobId,
      siteUrl,
      estimatedTotal,
    });

    let lastLogged = 0;

    for (let i = 0; i < maxPolls; i++) {
      this.resetIdleTimer();

      const resp = await this._fetch(`${this.config.url}/v1/crawl/${jobId}`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        throw new Error(`Firecrawl poll failed: ${resp.status}`);
      }

      const data = (await resp.json()) as Record<string, unknown>;
      const status = data.status as string;
      const completed = (data.completed ?? 0) as number;
      const total = (data.total ?? estimatedTotal ?? 0) as number;

      // Emit progress events so CrawlProgressPanel stays updated
      if (this._webhookHandler && completed > lastLogged) {
        const stats = this._webhookHandler.getCrawlStats(jobId);
        if (stats) {
          stats.pagesScraped = completed;
          stats.estimatedTotal = total || stats.estimatedTotal;
          stats.lastUrl = `${completed}/${total} pages`;
        }
        // Emit directly to avoid handleCrawlPageEvent's auto-increment
        this._webhookHandler.emit("crawl:progress", {
          jobId,
          siteUrl: siteUrl ?? "",
          pagesScraped: completed,
          estimatedTotal: total,
          errorCount: 0,
          lastUrl: `${completed}/${total} pages`,
          elapsedMs: i * pollInterval,
        });
        lastLogged = completed;
      }

      // Log progress every 10 polls (~10s)
      if (i > 0 && i % 10 === 0) {
        logger.info("[FirecrawlClient] Crawl poll progress", {
          jobId,
          status,
          completed,
          total,
          elapsed: `${i}s`,
        });
      }

      if (status === "completed") {
        const pages = (data.data as Record<string, unknown>[]) ?? [];
        logger.info("[FirecrawlClient] Crawl completed via polling", {
          jobId,
          pages: pages.length,
        });
        if (this._webhookHandler) {
          this._webhookHandler.completeCrawl(jobId, "completed");
        }
        return {
          pages: pages.map((p) => ({
            markdown: p.markdown as string | undefined,
            html: p.html as string | undefined,
            url: ((p.metadata as Record<string, unknown>)?.sourceURL ??
              p.url ??
              "") as string,
            metadata: p.metadata as Record<string, unknown> | undefined,
            statusCode: p.statusCode as number | undefined,
          })),
          totalPages: pages.length,
          jobId,
        };
      }

      if (status === "failed") {
        if (this._webhookHandler) {
          this._webhookHandler.completeCrawl(jobId, "failed");
        }
        throw new Error(
          `Firecrawl crawl job ${jobId} failed: ${data.error ?? "unknown error"}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    if (this._webhookHandler) {
      this._webhookHandler.completeCrawl(jobId, "failed");
    }
    throw new Error(
      `Firecrawl crawl job ${jobId} timed out after ${maxPolls} seconds`,
    );
  }

  private async pollBatchJob(jobId: string): Promise<BatchScrapeResult> {
    const maxPolls = 300;
    const pollInterval = 1000;

    for (let i = 0; i < maxPolls; i++) {
      this.resetIdleTimer();

      const resp = await this._fetch(
        `${this.config.url}/v1/batch/scrape/${jobId}`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!resp.ok) {
        throw new Error(`Firecrawl batch poll failed: ${resp.status}`);
      }

      const data = (await resp.json()) as Record<string, unknown>;
      const status = data.status as string;

      if (status === "completed") {
        const results = (data.data as Record<string, unknown>[]) ?? [];
        return {
          results: results.map((d) => ({
            markdown: d.markdown as string | undefined,
            html: d.html as string | undefined,
            metadata: d.metadata as Record<string, unknown> | undefined,
            url: ((d.metadata as Record<string, unknown>)?.sourceURL ??
              d.url ??
              "") as string,
          })),
          totalUrls: results.length,
          jobId,
        };
      }

      if (status === "failed") {
        throw new Error(
          `Firecrawl batch job ${jobId} failed: ${data.error ?? "unknown error"}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `Firecrawl batch job ${jobId} timed out after ${maxPolls} seconds`,
    );
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: FirecrawlClient | null = null;

export function getFirecrawlClient(
  config?: Partial<FirecrawlConfig>,
): FirecrawlClient {
  if (!_instance) {
    _instance = new FirecrawlClient(config);
  }
  return _instance;
}

export function resetFirecrawlClient(): void {
  _instance = null;
}
