/**
 * Endpoint autodetect for local LLM providers (issue #1058).
 *
 * Probes Ollama (default 11434) and vLLM (default 8000) for an OpenAI-compatible
 * `/v1/models` endpoint. Used at server startup to populate the admin UI with
 * a recommended `local-copilot` provider config — never auto-writes config.
 *
 * Mac validation (issue #1075): vLLM has no Apple Silicon build, so the probe
 * is short-circuited on `darwin` to fail-fast (≤2 s) with a structured reason
 * instead of waiting for a TCP timeout.
 */

import { logger } from "../../logging/logger.js";

export type DetectedEndpoint = {
  /** Base URL including `/v1` suffix, ready for `local-copilot` provider config. */
  endpoint: string;
  /** Models exposed by the endpoint (best-effort: parsed from `/v1/models`). */
  models: string[];
  /** Recommended default model for this endpoint (gemma4 family). */
  recommendedModel: string;
};

export type AutodetectResult = {
  ollama: DetectedEndpoint | null;
  vllm: DetectedEndpoint | null;
  /**
   * Per-target reason when a probe was skipped because the host platform
   * cannot run that backend (e.g. vLLM on Apple Silicon). Absent when every
   * probe was attempted normally.
   */
  unsupported?: {
    vllm?: string;
    ollama?: string;
  };
};

export type AutodetectOptions = {
  /** Override fetch implementation (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Probe timeout in ms. Default 1000. */
  timeoutMs?: number;
  /** Override Ollama base URL (without `/v1`). Default `http://127.0.0.1:11434`. */
  ollamaBaseUrl?: string;
  /** Override vLLM base URL (without `/v1`). Default `http://127.0.0.1:8000`. */
  vllmBaseUrl?: string;
  /** Override `process.platform` (default `process.platform`). Used to gate
   *  Apple Silicon vLLM short-circuit in tests. */
  platform?: NodeJS.Platform;
};

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_VLLM_URL = "http://127.0.0.1:8000";

const OLLAMA_RECOMMENDED = "gemma4:26b";
const VLLM_RECOMMENDED = "google/gemma-4-26b-it";

/**
 * Probe a single OpenAI-compatible endpoint. Returns null on any failure
 * (timeout, refused connection, non-200, malformed JSON) — no logs on miss
 * to keep startup quiet on machines without a local LLM.
 */
async function probeEndpoint(
  baseUrl: string,
  recommendedModel: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DetectedEndpoint | null> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const url = `${trimmed}/v1/models`;
  try {
    const resp = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(json.data)
      ? json.data
          .map((m) => (typeof m?.id === "string" ? m.id : null))
          .filter((id): id is string => !!id)
      : [];
    return {
      endpoint: `${trimmed}/v1`,
      models,
      recommendedModel,
    };
  } catch {
    return null;
  }
}

/**
 * Probe both Ollama and vLLM in parallel. Quiet on miss; info-log on hit.
 * Never throws — returns `{ ollama: null, vllm: null }` if both unreachable.
 */
export const VLLM_UNSUPPORTED_DARWIN_REASON =
  "vLLM is not supported on Apple Silicon — use Ollama + MLX instead.";

export async function autodetectEndpoints(
  options: AutodetectOptions = {},
): Promise<AutodetectResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1000;
  const ollamaBaseUrl = options.ollamaBaseUrl ?? DEFAULT_OLLAMA_URL;
  const vllmBaseUrl = options.vllmBaseUrl ?? DEFAULT_VLLM_URL;
  const platform = options.platform ?? process.platform;
  const vllmUnsupported = platform === "darwin";

  const [ollama, vllm] = await Promise.all([
    probeEndpoint(ollamaBaseUrl, OLLAMA_RECOMMENDED, fetchImpl, timeoutMs),
    vllmUnsupported
      ? Promise.resolve(null)
      : probeEndpoint(vllmBaseUrl, VLLM_RECOMMENDED, fetchImpl, timeoutMs),
  ]);

  if (ollama) {
    logger.info(
      `Local LLM autodetect: Ollama at ${ollama.endpoint} (${ollama.models.length} models)`,
    );
  }
  if (vllm) {
    logger.info(
      `Local LLM autodetect: vLLM at ${vllm.endpoint} (${vllm.models.length} models)`,
    );
  }

  const result: AutodetectResult = { ollama, vllm };
  if (vllmUnsupported) {
    result.unsupported = { vllm: VLLM_UNSUPPORTED_DARWIN_REASON };
  }
  return result;
}
