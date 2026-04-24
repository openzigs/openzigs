/**
 * v2a (MMAudio) sidecar HTTP client.
 *
 * WS1-A (#925): post-processing helper that takes a generated silent video
 * (file path or base64 bytes) and dispatches it to the v2a sidecar at
 * `V2A_SIDECAR_URL` (default `http://localhost:5012`) for synchronized
 * audio generation. The sidecar persists the job result to its in-memory
 * status store; the orchestrator polls it.
 *
 * This module is intentionally framework-free so it can be unit-tested
 * with `vi.fn()` mocks of `fetch` without spinning up a real Express app.
 */

import { logger } from "../logging/logger.js";

export interface V2aDispatchInput {
  jobId: string;
  /** Absolute path to the generated silent video. */
  videoPath?: string;
  /** Optional base64 mp4 bytes (used when sidecar runs on a different host). */
  videoB64?: string;
  durationSec: number;
  prompt?: string;
  negativePrompt?: string;
  seed?: number;
  callbackUrl?: string;
}

export interface V2aDispatchResult {
  status: "accepted" | "skipped" | "failed";
  jobId: string;
  error?: string;
}

export interface V2aClientOptions {
  /** Base URL of the v2a sidecar. */
  baseUrl?: string;
  /** Bearer token; sent as `Authorization: Bearer <token>` when set. */
  token?: string;
  /** Request timeout in milliseconds. Defaults to 10s for /generate (202). */
  timeoutMs?: number;
  /** Custom fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = process.env.V2A_SIDECAR_URL ?? "http://localhost:5012";

/**
 * Dispatch a v2a job. Returns immediately after the sidecar responds with
 * 202; the actual audio file lands later via callback or polling.
 */
export async function dispatchV2aJob(
  input: V2aDispatchInput,
  options: V2aClientOptions = {},
): Promise<V2aDispatchResult> {
  if (!input.videoPath && !input.videoB64) {
    return {
      status: "skipped",
      jobId: input.jobId,
      error: "Neither videoPath nor videoB64 provided",
    };
  }
  if (input.videoPath && input.videoB64) {
    return {
      status: "skipped",
      jobId: input.jobId,
      error: "Provide exactly one of videoPath or videoB64",
    };
  }
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) {
    return {
      status: "skipped",
      jobId: input.jobId,
      error: `Invalid durationSec: ${input.durationSec}`,
    };
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  const body = {
    job_id: input.jobId,
    video_path: input.videoPath,
    video_b64: input.videoB64,
    duration_sec: input.durationSec,
    prompt: input.prompt,
    negative_prompt: input.negativePrompt,
    seed: input.seed,
    callback_url: input.callbackUrl,
  };

  try {
    const resp = await fetchImpl(`${baseUrl}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "<no body>");
      logger.warn(
        `[v2a] dispatch ${input.jobId} -> ${resp.status} ${resp.statusText}: ${text}`,
      );
      return {
        status: "failed",
        jobId: input.jobId,
        error: `${resp.status} ${resp.statusText}`,
      };
    }
    return { status: "accepted", jobId: input.jobId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[v2a] dispatch ${input.jobId} failed: ${msg}`);
    return { status: "failed", jobId: input.jobId, error: msg };
  }
}

/** Probe the v2a sidecar's `/health` endpoint. */
export async function v2aHealthCheck(
  options: V2aClientOptions = {},
): Promise<{ reachable: boolean; loaded: boolean; error?: string }> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const resp = await fetchImpl(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!resp.ok) {
      return { reachable: false, loaded: false, error: `HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as { status?: string; loaded?: boolean };
    return { reachable: data.status === "ok", loaded: !!data.loaded };
  } catch (err) {
    return {
      reachable: false,
      loaded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
