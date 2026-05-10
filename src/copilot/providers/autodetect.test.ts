import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  autodetectEndpoints,
  VLLM_UNSUPPORTED_DARWIN_REASON,
} from "./autodetect.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockResponse = (
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
) =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response;

describe("autodetectEndpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns Ollama endpoint with parsed models when /v1/models responds 200", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("11434")) {
        return mockResponse({
          data: [{ id: "gemma4:26b" }, { id: "llama3.1:8b" }],
        });
      }
      throw new Error("connection refused");
    });
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
    });
    expect(result.ollama).toEqual({
      endpoint: "http://127.0.0.1:11434/v1",
      models: ["gemma4:26b", "llama3.1:8b"],
      recommendedModel: "gemma4:26b",
    });
    expect(result.vllm).toBeNull();
  });

  it("returns vLLM endpoint when only vLLM is up", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("8000")) {
        return mockResponse({ data: [{ id: "google/gemma-4-26b-it" }] });
      }
      throw new Error("ECONNREFUSED");
    });
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
    });
    expect(result.vllm).toEqual({
      endpoint: "http://127.0.0.1:8000/v1",
      models: ["google/gemma-4-26b-it"],
      recommendedModel: "google/gemma-4-26b-it",
    });
    expect(result.ollama).toBeNull();
  });

  it("returns { ollama: null, vllm: null } when neither endpoint responds", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
    });
    expect(result).toEqual({ ollama: null, vllm: null });
  });

  it("treats non-2xx responses as misses", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({}, { ok: false, status: 404 }),
    );
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
    });
    expect(result.ollama).toBeNull();
    expect(result.vllm).toBeNull();
  });

  it("times out cleanly on slow endpoints", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      // Simulate AbortSignal.timeout firing
      const signal = (init as RequestInit | undefined)?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }
        setTimeout(() => reject(new Error("never")), 5000);
      });
    });
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
      timeoutMs: 50,
    });
    expect(result.ollama).toBeNull();
    expect(result.vllm).toBeNull();
  });

  it("handles malformed JSON response gracefully", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("malformed");
          },
        }) as unknown as Response,
    );
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
    });
    expect(result.ollama).toBeNull();
    expect(result.vllm).toBeNull();
  });

  it("handles missing data array in response", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({}));
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
    });
    expect(result.ollama).not.toBeNull();
    expect(result.ollama?.models).toEqual([]);
  });

  it("strips trailing slashes from base URL before appending /v1", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ data: [] }));
    await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
      ollamaBaseUrl: "http://127.0.0.1:11434///",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/models",
      expect.any(Object),
    );
  });

  it("filters non-string ids in models response", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ data: [{ id: "good" }, { id: 42 }, { foo: "bar" }] }),
    );
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "linux",
    });
    expect(result.ollama?.models).toEqual(["good"]);
  });

  it("on darwin, skips vLLM probe entirely and reports it unsupported", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("11434")) {
        return mockResponse({ data: [{ id: "gemma4:26b" }] });
      }
      throw new Error("vLLM should not be probed on darwin");
    });
    const start = Date.now();
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "darwin",
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result.ollama).not.toBeNull();
    expect(result.vllm).toBeNull();
    expect(result.unsupported?.vllm).toBe(VLLM_UNSUPPORTED_DARWIN_REASON);
    const vllmCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("8000"),
    );
    expect(vllmCalls).toHaveLength(0);
  });

  it("on darwin with no Ollama, returns ollama:null + vllm:null + unsupported.vllm", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await autodetectEndpoints({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: "darwin",
    });
    expect(result.ollama).toBeNull();
    expect(result.vllm).toBeNull();
    expect(result.unsupported?.vllm).toBe(VLLM_UNSUPPORTED_DARWIN_REASON);
  });
});
