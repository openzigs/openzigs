/**
 * Async vLLM client — dual-GPU OpenAI-compatible endpoint (Epic #883 follow-up).
 *
 * Pairs with examples/multi-gpu/vllm-dual-gpu.py. Designed so the agent layer
 * NEVER blocks while a 15s+ FLUX generation or 30s+ vLLM completion is running.
 *
 * Three rules baked in:
 *   1. Streaming is the default. Non-streaming is opt-in.
 *   2. Single-flight per model (vLLM is single-process and PCIe all-reduce
 *      hates concurrent prefills on consumer cards). A queue serialises calls.
 *   3. Backpressure: if the queue exceeds maxQueueDepth, new calls reject
 *      immediately rather than letting Windows page-out to system RAM.
 *
 * NOT yet wired into the openzigs Express server. To integrate:
 *   - Add a `llm.localVllm` block to config/default.json (baseUrl, apiKey, model)
 *   - Mount as a CopilotProvider alternative in src/copilot/
 *   - Surface health via /api/system/gpu (extend src/api/system.ts)
 */

interface VllmClientOptions {
  baseUrl: string;          // e.g. "http://127.0.0.1:8000"
  apiKey?: string;
  model: string;            // model id loaded by the server
  /** Reject new calls when this many are already queued. Default 8. */
  maxQueueDepth?: number;
  /** Per-call timeout in ms. Default 120_000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
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

export class VllmBackpressureError extends Error {
  readonly code = "VLLM_BACKPRESSURE";
}

export class VllmClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly maxQueueDepth: number;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  // Single-flight queue. We hold a tail promise; each call awaits the previous
  // tail before issuing its own fetch. This serialises requests to vLLM
  // without busy-waiting and without a third-party queue lib.
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(opts: VllmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.maxQueueDepth = opts.maxQueueDepth ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  get queueDepth(): number {
    return this.pending;
  }

  /**
   * Non-streaming chat completion. Will not block the event loop while waiting:
   * the await yields to other handlers between queue slots.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.pending >= this.maxQueueDepth) {
      throw new VllmBackpressureError(
        `vLLM queue full (${this.pending}/${this.maxQueueDepth}); rejecting to prevent VRAM->RAM spillover`,
      );
    }
    this.pending += 1;
    const queuedAt = performance.now();

    // Chain onto the tail so calls run one-at-a-time. The cast keeps TS happy
    // about awaiting an `unknown`.
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });

    try {
      await prev.catch(() => {
        /* swallow upstream errors; each call gets its own outcome */
      });
      const dispatchedAt = performance.now();
      const queueWaitMs = dispatchedAt - queuedAt;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      // Forward caller's signal too.
      req.signal?.addEventListener("abort", () => controller.abort(), { once: true });

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
        return {
          text: choice?.message?.content ?? "",
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          finishReason: choice?.finish_reason ?? null,
          totalMs: performance.now() - queuedAt,
          queueWaitMs,
        };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.pending -= 1;
      release();
    }
  }

  /**
   * Streaming completion — yields chunks as they arrive. Same single-flight
   * + backpressure semantics as `complete()`.
   */
  async *stream(req: CompletionRequest): AsyncGenerator<string, CompletionResult> {
    if (this.pending >= this.maxQueueDepth) {
      throw new VllmBackpressureError(
        `vLLM queue full (${this.pending}/${this.maxQueueDepth})`,
      );
    }
    this.pending += 1;
    const queuedAt = performance.now();

    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });

    try {
      await prev.catch(() => undefined);
      const dispatchedAt = performance.now();
      const queueWaitMs = dispatchedAt - queuedAt;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      req.signal?.addEventListener("abort", () => controller.abort(), { once: true });

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
        return {
          text: fullText,
          promptTokens,
          completionTokens,
          finishReason,
          totalMs: performance.now() - queuedAt,
          queueWaitMs,
        };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.pending -= 1;
      release();
    }
  }
}

// ── OpenAI-compatible response shapes (subset) ────────────────

interface VllmChatResponse {
  choices?: Array<{
    message?: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface VllmStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
