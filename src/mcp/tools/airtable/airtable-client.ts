/**
 * Airtable REST API Client with per-base rate limiting.
 *
 * Rate limit: ≤5 requests/sec per base (Airtable enforces this).
 * Auth: Personal access token from Secret Vault.
 * Errors: 401, 403, 404, 422, 429 with exponential backoff.
 */

import type {
  AirtableBasesResponse,
  AirtableTablesResponse,
  AirtableRecordsResponse,
  AirtableListRecordsParams,
  AirtableRecordWrite,
  AirtableRecordUpdate,
  AirtableDeleteRecordsResponse,
  AirtableClientConfig,
} from "./types.js";

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const AIRTABLE_META_BASE = "https://api.airtable.com/v0/meta";

const DEFAULT_MAX_RPS = 5;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// ── Per-base rate limiter ────────────────────────────────────────────────

interface QueueEntry {
  resolve: (value: void) => void;
}

export class RateLimiter {
  private queues = new Map<string, QueueEntry[]>();
  private timestamps = new Map<string, number[]>();
  private maxRps: number;
  private processing = new Set<string>();

  constructor(maxRps: number = DEFAULT_MAX_RPS) {
    this.maxRps = maxRps;
  }

  async acquire(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const queue = this.queues.get(key) ?? [];
      queue.push({ resolve });
      this.queues.set(key, queue);
      this.processQueue(key);
    });
  }

  private processQueue(key: string): void {
    if (this.processing.has(key)) return;
    this.processing.add(key);

    const drain = () => {
      const queue = this.queues.get(key);
      if (!queue || queue.length === 0) {
        this.processing.delete(key);
        return;
      }

      const now = Date.now();
      const timestamps = this.timestamps.get(key) ?? [];

      // Remove timestamps older than 1 second
      const windowStart = now - 1000;
      const recent = timestamps.filter((t) => t > windowStart);
      this.timestamps.set(key, recent);

      if (recent.length < this.maxRps) {
        const entry = queue.shift()!;
        recent.push(now);
        this.timestamps.set(key, recent);
        entry.resolve();
        // Process next immediately
        if (queue.length > 0) {
          drain();
        } else {
          this.processing.delete(key);
        }
      } else {
        // Wait until the oldest timestamp expires
        const waitMs = recent[0] + 1000 - now + 10; // +10ms buffer
        setTimeout(() => drain(), waitMs);
      }
    };

    drain();
  }

  /** Visible for testing. */
  getQueueSize(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }
}

// ── Client ───────────────────────────────────────────────────────────────

export class AirtableClient {
  private apiKey: string;
  private rateLimiter: RateLimiter;

  constructor(config: AirtableClientConfig) {
    if (!config.apiKey) {
      throw new Error("Airtable API key is required");
    }
    this.apiKey = config.apiKey;
    this.rateLimiter = new RateLimiter(
      config.maxRequestsPerSecond ?? DEFAULT_MAX_RPS,
    );
  }

  // ── Bases ──

  async listBases(offset?: string): Promise<AirtableBasesResponse> {
    const params = new URLSearchParams();
    if (offset) params.set("offset", offset);
    const qs = params.toString();
    return this.request<AirtableBasesResponse>(
      `${AIRTABLE_META_BASE}/bases${qs ? `?${qs}` : ""}`,
      "meta",
    );
  }

  // ── Tables ──

  async listTables(baseId: string): Promise<AirtableTablesResponse> {
    this.validateBaseId(baseId);
    return this.request<AirtableTablesResponse>(
      `${AIRTABLE_META_BASE}/bases/${encodeURIComponent(baseId)}/tables`,
      baseId,
    );
  }

  // ── Records ──

  async listRecords(
    baseId: string,
    tableIdOrName: string,
    params?: AirtableListRecordsParams,
  ): Promise<AirtableRecordsResponse> {
    this.validateBaseId(baseId);
    const qs = this.buildRecordQueryString(params);
    return this.request<AirtableRecordsResponse>(
      `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}${qs ? `?${qs}` : ""}`,
      baseId,
    );
  }

  async createRecords(
    baseId: string,
    tableIdOrName: string,
    records: AirtableRecordWrite[],
    typecast = false,
  ): Promise<AirtableRecordsResponse> {
    this.validateBaseId(baseId);
    if (records.length > 10) {
      throw new Error("Airtable batch limit: max 10 records per request");
    }
    return this.request<AirtableRecordsResponse>(
      `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`,
      baseId,
      {
        method: "POST",
        body: JSON.stringify({
          records: records.map((r) => ({ fields: r.fields })),
          typecast,
        }),
      },
    );
  }

  async updateRecords(
    baseId: string,
    tableIdOrName: string,
    records: AirtableRecordUpdate[],
    typecast = false,
  ): Promise<AirtableRecordsResponse> {
    this.validateBaseId(baseId);
    if (records.length > 10) {
      throw new Error("Airtable batch limit: max 10 records per request");
    }
    return this.request<AirtableRecordsResponse>(
      `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`,
      baseId,
      {
        method: "PATCH",
        body: JSON.stringify({
          records: records.map((r) => ({ id: r.id, fields: r.fields })),
          typecast,
        }),
      },
    );
  }

  async deleteRecords(
    baseId: string,
    tableIdOrName: string,
    recordIds: string[],
  ): Promise<AirtableDeleteRecordsResponse> {
    this.validateBaseId(baseId);
    if (recordIds.length > 10) {
      throw new Error("Airtable batch limit: max 10 records per request");
    }
    const params = recordIds
      .map((id) => `records[]=${encodeURIComponent(id)}`)
      .join("&");
    return this.request<AirtableDeleteRecordsResponse>(
      `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}?${params}`,
      baseId,
      { method: "DELETE" },
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private validateBaseId(baseId: string): void {
    if (!/^app[a-zA-Z0-9]{10,}$/.test(baseId)) {
      throw new Error(
        `Invalid Airtable base ID: "${baseId}". Expected format: appXXXXXXXXXXXXXX`,
      );
    }
  }

  private buildRecordQueryString(params?: AirtableListRecordsParams): string {
    if (!params) return "";
    const qs = new URLSearchParams();
    if (params.fields) {
      for (const f of params.fields) qs.append("fields[]", f);
    }
    if (params.filterByFormula)
      qs.set("filterByFormula", params.filterByFormula);
    if (params.maxRecords) qs.set("maxRecords", String(params.maxRecords));
    if (params.pageSize) qs.set("pageSize", String(params.pageSize));
    if (params.view) qs.set("view", params.view);
    if (params.offset) qs.set("offset", params.offset);
    if (params.sort) {
      params.sort.forEach((s, i) => {
        qs.set(`sort[${i}][field]`, s.field);
        if (s.direction) qs.set(`sort[${i}][direction]`, s.direction);
      });
    }
    return qs.toString();
  }

  private async request<T>(
    url: string,
    rateLimitKey: string,
    init?: RequestInit,
  ): Promise<T> {
    await this.rateLimiter.acquire(rateLimitKey);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }

      const response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const status = response.status;
      const body = await response.text();

      // Retryable: 429 (rate limit) and 5xx
      if (status === 429 || status >= 500) {
        lastError = new Error(`Airtable API error ${status}: ${body}`);
        continue;
      }

      // Non-retryable errors
      if (status === 401) {
        throw new Error(
          "Airtable authentication failed (401). Check your API key.",
        );
      }
      if (status === 403) {
        throw new Error(`Airtable access denied (403): ${body}`);
      }
      if (status === 404) {
        throw new Error(`Airtable resource not found (404): ${body}`);
      }
      if (status === 422) {
        throw new Error(`Airtable validation error (422): ${body}`);
      }

      throw new Error(`Airtable API error ${status}: ${body}`);
    }

    throw lastError ?? new Error("Airtable request failed after retries");
  }
}
