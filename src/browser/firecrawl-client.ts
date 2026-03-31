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

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────

export interface ScrapeOptions {
  formats?: ("markdown" | "html")[];
  actions?: ScrapeAction[];
  waitFor?: number;
}

export interface ScrapeAction {
  type: "wait" | "click" | "type" | "screenshot";
  selector?: string;
  text?: string;
  milliseconds?: number;
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

export interface MapResult {
  urls: string[];
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
  /^127\./,                              // loopback
  /^10\./,                               // private class A
  /^172\.(1[6-9]|2\d|3[0-1])\./,        // private class B
  /^192\.168\./,                         // private class C
  /^169\.254\./,                         // link-local
  /^0\./,                               // current network
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
    if (inner === "::1" || inner === "::0" || inner === "0:0:0:0:0:0:0:1" || inner === "0:0:0:0:0:0:0:0") {
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
    const entries = [...this.lastRequestTime.entries()].sort((a, b) => a[1] - b[1]);
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

  constructor(config?: Partial<FirecrawlConfig>, fetchFn?: typeof fetch) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.composeFile = path.join(PROJECT_ROOT, "docker-compose.firecrawl.yml");
    this._fetch = fetchFn ?? globalThis.fetch;
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
   * Polls the async crawl job until completion.
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
            url: ((p.metadata as Record<string, unknown>)?.sourceURL ?? p.url ?? "") as string,
            metadata: p.metadata as Record<string, unknown> | undefined,
            statusCode: p.statusCode as number | undefined,
          })),
          totalPages: syncData.length,
        };
      }
      throw new Error("Firecrawl crawl response missing job ID");
    }

    // Poll for completion
    return this.pollCrawlJob(jobId);
  }

  /**
   * Map a website to discover all URLs without scraping content.
   */
  async map(url: string): Promise<MapResult> {
    this.validateUrl(url);
    await this.ensureRunning();
    await this.rateLimiter.waitForDomain(this.getDomain(url));
    this.resetIdleTimer();

    const resp = await this.request("/v1/map", { url });
    return {
      urls: (resp.links ?? resp.urls ?? []) as string[],
    };
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
      await execFileAsync("docker", [
        "compose", "-f", this.composeFile, "down",
      ], { timeout: 30_000 });
      this.sidecarRunning = false;
      logger.info("[FirecrawlClient] Sidecar stopped");
    } catch (err) {
      logger.warn("[FirecrawlClient] Failed to stop sidecar", { error: String(err) });
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
      throw new Error(`SSRF blocked: URL "${url}" targets an internal/private network address`);
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
      throw new Error("Firecrawl is not enabled. Set firecrawl.enabled to true in config.");
    }

    // Check if already reachable
    if (this.sidecarRunning && await this.isAvailableQuick()) {
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
      logger.warn("[FirecrawlClient] Docker not available — sidecar cannot start");
      return false;
    }

    try {
      logger.info("[FirecrawlClient] Starting Firecrawl sidecar...");
      await execFileAsync("docker", [
        "compose", "-f", this.composeFile, "up", "-d",
      ], { timeout: 120_000 });

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

      logger.error("[FirecrawlClient] Sidecar failed to become healthy after retries");
      return false;
    } catch (err) {
      logger.error("[FirecrawlClient] Failed to start sidecar", { error: String(err) });
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
    if (this.idleTimer && typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      this.idleTimer.unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async request(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resp = await this._fetch(`${this.config.url}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Firecrawl ${endpoint} failed: ${resp.status} ${resp.statusText} — ${text}`);
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  private async pollCrawlJob(jobId: string): Promise<CrawlResult> {
    const maxPolls = 300; // 5 minutes at 1s intervals
    const pollInterval = 1000;

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

      if (status === "completed") {
        const pages = (data.data as Record<string, unknown>[]) ?? [];
        return {
          pages: pages.map((p) => ({
            markdown: p.markdown as string | undefined,
            html: p.html as string | undefined,
            url: ((p.metadata as Record<string, unknown>)?.sourceURL ?? p.url ?? "") as string,
            metadata: p.metadata as Record<string, unknown> | undefined,
            statusCode: p.statusCode as number | undefined,
          })),
          totalPages: pages.length,
          jobId,
        };
      }

      if (status === "failed") {
        throw new Error(`Firecrawl crawl job ${jobId} failed: ${data.error ?? "unknown error"}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Firecrawl crawl job ${jobId} timed out after ${maxPolls} seconds`);
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: FirecrawlClient | null = null;

export function getFirecrawlClient(config?: Partial<FirecrawlConfig>): FirecrawlClient {
  if (!_instance) {
    _instance = new FirecrawlClient(config);
  }
  return _instance;
}

export function resetFirecrawlClient(): void {
  _instance = null;
}
