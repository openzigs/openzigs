/**
 * Resolve the active Ollama base URL + auth headers from config + env
 * (#1077-B remote Ollama node).
 *
 * Precedence (highest first):
 *   1. Env vars `OLLAMA_MODE` / `OLLAMA_NETWORK_URL` / `OLLAMA_NETWORK_TOKEN`
 *      — useful for ops + container deployments that don't write
 *      `~/.openzigs/config.json`.
 *   2. The `localLlm.ollama` block in config.
 *   3. Built-in fallback `http://127.0.0.1:11434` (no token).
 *
 * Mode semantics mirror the FluxQ "Network Node" pattern
 * (`imageGen.{mode,networkNodeUrl,networkNodeToken}`):
 *   - `local`   → `localUrl`
 *   - `network` → `networkNodeUrl` + optional `Authorization: Bearer …`
 *
 * SSRF: the resolver itself does NOT validate URLs — callers that wire the
 * URL into outbound fetches against untrusted input must run it through
 * `isAllowedNetworkNodeUrl` (see `src/security/url-validation.ts`). For
 * `local` mode the URL is loopback-by-default which the SSRF guard
 * intentionally rejects, so the guard is only applied in `network` mode.
 */

import type { OllamaNodeConfig } from "../../config/local-llm-schema.js";

export interface ResolvedOllamaTarget {
  /** Base URL without `/v1` suffix (e.g. `http://10.0.0.42:11434`). */
  baseUrl: string;
  /** Active mode after env+config resolution. */
  mode: "local" | "network";
  /** Headers to attach to outbound requests (Authorization etc.). */
  headers: Record<string, string>;
}

const DEFAULT_LOCAL_URL = "http://127.0.0.1:11434";

/**
 * Read the env vars once at call time (not module load) so tests + hot
 * config reloads see fresh values.
 */
function readEnv(env: NodeJS.ProcessEnv): {
  mode?: "local" | "network";
  url?: string;
  token?: string;
} {
  const rawMode = env.OLLAMA_MODE?.trim().toLowerCase();
  const mode =
    rawMode === "local" || rawMode === "network" ? rawMode : undefined;
  const url = env.OLLAMA_NETWORK_URL?.trim() || undefined;
  const token = env.OLLAMA_NETWORK_TOKEN?.trim() || undefined;
  return { mode, url, token };
}

/**
 * Resolve the active Ollama target. Pure function — no I/O. Pass an
 * explicit `env` for tests; defaults to `process.env`.
 */
export function resolveOllamaTarget(
  config: Partial<OllamaNodeConfig> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOllamaTarget {
  const cfg = config ?? {};
  const e = readEnv(env);

  const mode = e.mode ?? cfg.mode ?? "local";

  if (mode === "network") {
    const baseUrl = (e.url ?? cfg.networkNodeUrl ?? "").trim();
    const token = (e.token ?? cfg.networkNodeToken ?? "").trim();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return {
      baseUrl: baseUrl || DEFAULT_LOCAL_URL,
      mode: "network",
      headers,
    };
  }

  return {
    baseUrl: (cfg.localUrl ?? DEFAULT_LOCAL_URL).trim() || DEFAULT_LOCAL_URL,
    mode: "local",
    headers: {},
  };
}
