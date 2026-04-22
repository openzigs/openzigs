/**
 * Async vLLM client — dual-GPU OpenAI-compatible endpoint.
 *
 * Promoted from `examples/multi-gpu/vllm-client.ts` for Issue #918
 * (Epic #888 — Local LLM serving via vLLM TP=2).
 *
 * Three rules baked in:
 *   1. Streaming is the default. Non-streaming is opt-in.
 *   2. Single-flight per model (vLLM is single-process and PCIe all-reduce
 *      hates concurrent prefills on consumer cards). A queue serialises calls.
 *   3. Backpressure: if the queue exceeds maxQueueDepth, new calls reject
 *      immediately rather than letting Windows page-out to system RAM.
 *
 * Audit logging: each call records token counts, latency, and queue wait under
 * the `tool` audit category, subcategory `llm.vllm`. The API key value is NEVER
 * logged — only the presence/length of an Authorization header.
 */

import type { AuditLogger } from "../logging/audit-logger.js";

interface VllmClientOptions {
  baseUrl: string; // e.g. "http://127.0.0.1:8000"
  apiKey?: string;
  model: string; // model id loaded by the server
  /** Reject new calls when this many are already queued. Default 8. */
  maxQueueDepth?: number;
  /** Per-call timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Optional fetch override (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional audit logger. When set, each call emits a `llm.vllm.*` event. */
  auditLogger?: Pick<AuditLogger, "log">;
  /** Optional clock for deterministic latency tests. Defaults to performance.now. */
  now?: () => number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** AbortSignal forwarded to fetch and the queue. */
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string | null;
  /** End-to-end ms including queue wait. */
  totalMs: number;
  /** ms spent waiting in our local queue (excludes server time). */
  queueWaitMs: number;
}

export interface VllmClientMetrics {
  queueDepth: number;
  totalCompleted: number;
  totalFailed: number;
  totalBackpressure: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
}

export class VllmBackpressureError extends Error {
  readonly code = "VLLM_BACKPRESSURE" as const;
  constructor(message: string) {
    super(message);
    this.name = "VllmBackpressureError";
  }
}

/** Type guard for the backpressure error class. */
export function isBackpressureError(err: unknown): err is VllmBackpressureError {
  return (
    err instanceof VllmBackpressureError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "VLLM_BACKPRESSURE")
  );
}

const ROLLING_WINDOW = 200;

export class VllmClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly maxQueueDepth: number;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private readonly audit?: Pick<AuditLogger, "log">;
  private readonly now: () => number;

  // Single-flight queue. We hold a tail promise; each call awaits the previous
  // tail before issuing its own fetch. This serialises requests to vLLM
  // without busy-waiting and without a third-party queue lib.
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  // Rolling latency window for p50/p99.
  private readonly latencies: number[] = [];
  private completed = 0;
  private failed = 0;
  private backpressure = 0;

  constructor(opts: VllmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.maxQueueDepth = opts.maxQueueDepth ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetch = opts.fetchImpl ?? fetch;
    this.audit = opts.auditLogger;
    this.now = opts.now ?? (() => performance.now());
  }

  get queueDepth(): number {
    return this.pending;
  }

  /** Returns rolling-window metrics for the Admin UI / health checks. */
  getMetrics(): VllmClientMetrics {
    return {
      queueDepth: this.pending,
      totalCompleted: this.completed,
      totalFailed: this.failed,
      totalBackpressure: this.backpressure,
      p50LatencyMs: percentile(this.latencies, 0.5),
      p99LatencyMs: percentile(this.latencies, 0.99),
    };
  }

  /** Reject immediately when the queue is at capacity. Synchronous check
   *  so callers can convert to HTTP 429 without consuming a queue slot. */
  private checkBackpressure(): void {
    if (this.pending >= this.maxQueueDepth) {
      this.backpressure += 1;
      throw new VllmBackpressureError(
        `vLLM queue full (${this.pending}/${this.maxQueueDepth}); rejecting to prevent VRAM->RAM spillover`,
      );
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > ROLLING_WINDOW) {
      this.latencies.shift();
    }
  }

  private auditEvent(
    event: string,
    details: Record<string, unknown>,
    level: "info" | "warn" | "error" = "info",
  ): void {
    if (!this.audit) return;
    try {
      this.audit.log({
        level,
        category: "tool",
        event: `llm.vllm.${event}`,
        details,
      });
    } catch {
      // Audit failures must never break inference.
    }
  }

  /**
   * Non-streaming chat completion. Will not block the event loop while waiting:
   * the await yields to other handlers between queue slots.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.checkBackpressure();
    this.pending += 1;
    const queuedAt = this.now();

    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });

    try {
      await prev.catch(() => undefined);
      const dispatchedAt = this.now();
      const queueWaitMs = dispatchedAt - queuedAt;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      req.signal?.addEventListener("abort", () => controller.abort(), {
        once: true,
      });

      try {
        const body = {
          model: this.model,
          messages: req.messages,
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.7,
          top_p: req.topP ?? 0.95,
          stream: false,
        };
        const resp = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`vLLM ${resp.status}: ${txt.slice(0, 300)}`);
        }
        const json = (await resp.json()) as VllmChatResponse;
        const choice = json.choices?.[0];
        const totalMs = this.now() - queuedAt;
        const result: CompletionResult = {
          text: choice?.message?.content ?? "",
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          finishReason: choice?.finish_reason ?? null,
          totalMs,
          queueWaitMs,
        };
        this.completed += 1;
        this.recordLatency(totalMs);
        this.auditEvent("complete", {
          model: this.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalMs: Math.round(totalMs),
          queueWaitMs: Math.round(queueWaitMs),
          finishReason: result.finishReason,
        });
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.failed += 1;
      this.auditEvent(
        "error",
        { model: this.model, error: errorString(err) },
        "error",
      );
      throw err;
    } finally {
      this.pending -= 1;
      release();
    }
  }

  /**
   * Streaming completion — yields chunks as they arrive. Same single-flight
   * + backpressure semantics as `complete()`.
   */
  async *stream(
    req: CompletionRequest,
  ): AsyncGenerator<string, CompletionResult> {
    this.checkBackpressure();
    this.pending += 1;
    const queuedAt = this.now();

    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });

    try {
      await prev.catch(() => undefined);
      const dispatchedAt = this.now();
      const queueWaitMs = dispatchedAt - queuedAt;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      req.signal?.addEventListener("abort", () => controller.abort(), {
        once: true,
      });

      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: string | null = null;
      let fullText = "";

      try {
        const body = {
          model: this.model,
          messages: req.messages,
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.7,
          top_p: req.topP ?? 0.95,
          stream: true,
          stream_options: { include_usage: true },
        };
        const resp = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(() => "");
          throw new Error(`vLLM ${resp.status}: ${txt.slice(0, 300)}`);
        }

        const decoder = new TextDecoder();
        const reader = resp.body.getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            const evt = JSON.parse(payload) as VllmStreamChunk;
            const chunk = evt.choices?.[0]?.delta?.content;
            if (chunk) {
              fullText += chunk;
              yield chunk;
            }
            if (evt.choices?.[0]?.finish_reason) {
              finishReason = evt.choices[0].finish_reason;
            }
            if (evt.usage) {
              promptTokens = evt.usage.prompt_tokens ?? promptTokens;
              completionTokens = evt.usage.completion_tokens ?? completionTokens;
            }
          }
        }
        const totalMs = this.now() - queuedAt;
        const result: CompletionResult = {
          text: fullText,
          promptTokens,
          completionTokens,
          finishReason,
          totalMs,
          queueWaitMs,
        };
        this.completed += 1;
        this.recordLatency(totalMs);
        this.auditEvent("stream", {
          model: this.model,
          promptTokens,
          completionTokens,
          totalMs: Math.round(totalMs),
          queueWaitMs: Math.round(queueWaitMs),
          finishReason,
        });
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.failed += 1;
      this.auditEvent(
        "error",
        { model: this.model, error: errorString(err) },
        "error",
      );
      throw err;
    } finally {
      this.pending -= 1;
      release();
    }
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round(sorted[idx]);
}

function errorString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── OpenAI-compatible response shapes (subset) ────────────────

interface VllmChatResponse {
  choices?: Array<{
    message?: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface VllmStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
