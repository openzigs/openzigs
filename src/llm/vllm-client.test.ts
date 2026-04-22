import { describe, expect, it, vi } from "vitest";
import {
  VllmClient,
  VllmBackpressureError,
  isBackpressureError,
} from "./vllm-client.js";

/**
 * Builds a deterministic mock fetch returning a fixed OpenAI-compatible
 * chat completion. Tracks call timing so single-flight ordering can be
 * asserted.
 */
function makeMockFetch(opts: {
  delayMs?: number;
  text?: string;
  shouldFail?: boolean;
} = {}) {
  const calls: Array<{ start: number; end: number }> = [];
  let now = 0;
  const advance = (ms: number) => {
    now += ms;
  };
  const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
    const start = now;
    advance(opts.delayMs ?? 5);
    const end = now;
    calls.push({ start, end });
    if (opts.shouldFail) {
      throw new Error("network blew up");
    }
    return new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: opts.text ?? "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, now: () => now, advance };
}

describe("VllmClient", () => {
  it("serialises concurrent complete() calls (single-flight)", async () => {
    const { fetchImpl, calls } = makeMockFetch({ delayMs: 10 });
    const client = new VllmClient({
      baseUrl: "http://127.0.0.1:8000",
      model: "test/model",
      fetchImpl,
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.complete({ messages: [{ role: "user", content: "hi" }] }),
      ),
    );

    expect(results).toHaveLength(4);
    expect(calls).toHaveLength(4);
    // Each fetch must start at-or-after the previous fetch ended (no overlap).
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i].start).toBeGreaterThanOrEqual(calls[i - 1].end);
    }
  });

  it("rejects with VllmBackpressureError when queue is full", async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const fetchImpl = (async () => {
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as unknown as typeof fetch;

    const client = new VllmClient({
      baseUrl: "http://127.0.0.1:8000",
      model: "test/model",
      maxQueueDepth: 2,
      fetchImpl,
    });

    // Two in-flight (1st dispatched, 2nd queued behind it).
    const p1 = client.complete({ messages: [{ role: "user", content: "a" }] });
    const p2 = client.complete({ messages: [{ role: "user", content: "b" }] });
    // Yield once so p1's fetch is issued and pending == 2.
    await Promise.resolve();

    // Third call must reject without issuing a fetch (back-pressure).
    await expect(
      client.complete({ messages: [{ role: "user", content: "c" }] }),
    ).rejects.toBeInstanceOf(VllmBackpressureError);

    // Drain so the test doesn't hang. The mock pushes one resolver per fetch
    // call; the second call dispatches its fetch only after the first
    // releases, so we drain in a loop.
    const okResponse = () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    while (resolvers.length === 0) await Promise.resolve();
    resolvers.shift()!(okResponse());
    // Yield enough microtasks so call 2 reaches its fetch.
    for (let i = 0; i < 20 && resolvers.length === 0; i += 1) {
      await Promise.resolve();
    }
    if (resolvers.length > 0) resolvers.shift()!(okResponse());
    await Promise.allSettled([p1, p2]);

    expect(client.getMetrics().totalBackpressure).toBe(1);
  });

  it("isBackpressureError is true for thrown VllmBackpressureError", () => {
    const err = new VllmBackpressureError("full");
    expect(isBackpressureError(err)).toBe(true);
    expect(isBackpressureError(new Error("nope"))).toBe(false);
    expect(isBackpressureError({ code: "VLLM_BACKPRESSURE" })).toBe(true);
  });

  it("forwards AbortSignal to fetch and rejects on abort", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const client = new VllmClient({
      baseUrl: "http://127.0.0.1:8000",
      model: "test/model",
      fetchImpl,
      timeoutMs: 50,
    });

    const controller = new AbortController();
    const promise = client.complete({
      messages: [{ role: "user", content: "x" }],
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeTruthy();
    expect(client.getMetrics().totalFailed).toBe(1);
  });

  it("streams chunks in order and reports usage in the final result", async () => {
    const sse =
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n` +
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n` +
      `data: {"choices":[{"delta":{"content":"!"} ,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n` +
      `data: [DONE]\n`;
    const fetchImpl = (async () => {
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = new VllmClient({
      baseUrl: "http://127.0.0.1:8000",
      model: "test/model",
      fetchImpl,
    });

    const chunks: string[] = [];
    const it = client.stream({ messages: [{ role: "user", content: "hi" }] });
    for await (const chunk of it) chunks.push(chunk);
    expect(chunks).toEqual(["Hel", "lo", "!"]);
  });

  it("getMetrics tracks completed, failed, and backpressure counts", async () => {
    const { fetchImpl } = makeMockFetch();
    const client = new VllmClient({
      baseUrl: "http://127.0.0.1:8000",
      model: "test/model",
      fetchImpl,
    });
    await client.complete({ messages: [{ role: "user", content: "ok" }] });
    const metrics = client.getMetrics();
    expect(metrics.totalCompleted).toBe(1);
    expect(metrics.totalFailed).toBe(0);
    expect(metrics.totalBackpressure).toBe(0);
    expect(metrics.queueDepth).toBe(0);
  });

  it("emits audit events without leaking the API key", async () => {
    const { fetchImpl } = makeMockFetch();
    const log = vi.fn();
    const client = new VllmClient({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "sk-secret-do-not-log",
      model: "test/model",
      fetchImpl,
      auditLogger: { log },
    });
    await client.complete({ messages: [{ role: "user", content: "ok" }] });
    expect(log).toHaveBeenCalled();
    const serialised = JSON.stringify(log.mock.calls);
    expect(serialised).not.toContain("sk-secret-do-not-log");
  });

  it("propagates HTTP errors and increments failure metric", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
      })) as unknown as typeof fetch;
    const client = new VllmClient({
      baseUrl: "http://127.0.0.1:8000",
      model: "test/model",
      fetchImpl,
    });
    await expect(
      client.complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/vLLM 500/);
    expect(client.getMetrics().totalFailed).toBe(1);
  });
});
