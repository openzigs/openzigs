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
 * SSRF: prefer `resolveAndAssertOllamaTarget` for any code path that wires
 * the resolved URL into an outbound `fetch`. The plain `resolveOllamaTarget`
 * does NOT validate URLs and is reserved for read-only inspection (status
 * panels, logging) where no network call is made against the result.
 */

import type { OllamaNodeConfig } from "../../config/local-llm-schema.js";
import { isAllowedNetworkNodeUrl } from "../../security/url-validation.js";

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

/**
 * SSRF reasons surfaced by `resolveAndAssertOllamaTarget`.
 */
export type OllamaTargetRejectionReason =
  | "invalid_url"
  | "blocked_host"
  | "missing_url"
  | "local_url_not_loopback";

/**
 * Typed error thrown when the resolved Ollama target fails the SSRF guard.
 * Callers (HTTP handlers) should map this to a 400/422 with `error: msg`.
 */
export class OllamaTargetError extends Error {
  readonly reason: OllamaTargetRejectionReason;
  constructor(reason: OllamaTargetRejectionReason, message: string) {
    super(message);
    this.name = "OllamaTargetError";
    this.reason = reason;
  }
}

/**
 * Resolve the target AND assert the SSRF guard. Use this everywhere the
 * resolved URL is passed to an outbound `fetch` — the three known sinks
 * are `PUT /local-llm/ollama/config` (post-merge), `POST /local-llm/ollama/
 * test-connection`, and the wizard `autodetectHandler`.
 *
 * - `network` mode: rejects loopback, link-local (incl. cloud metadata),
 *   IPv6 link-local/ULA. Permits RFC1918 LAN + public hostnames.
 * - `local` mode: rejects anything that isn't `127.0.0.1` / `localhost`
 *   / `[::1]` / `0.0.0.0` so a misconfigured `localUrl` can't be used to
 *   reach a LAN host through the "local" code path.
 */
export function resolveAndAssertOllamaTarget(
  config: Partial<OllamaNodeConfig> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOllamaTarget {
  const target = resolveOllamaTarget(config, env);
  let parsed: URL;
  try {
    parsed = new URL(target.baseUrl);
  } catch {
    throw new OllamaTargetError(
      "invalid_url",
      `Resolved Ollama URL is not a valid URL: ${target.baseUrl}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OllamaTargetError(
      "invalid_url",
      `Resolved Ollama URL must be http(s): ${target.baseUrl}`,
    );
  }
  if (target.mode === "network") {
    // `resolveOllamaTarget` falls back to the local default when network mode
    // is selected with a blank URL — for the assert variant that's a config
    // error, not an SSRF allow.
    const networkUrl = (
      env.OLLAMA_NETWORK_URL?.trim() ||
      config?.networkNodeUrl?.trim() ||
      ""
    ).trim();
    if (!networkUrl) {
      throw new OllamaTargetError(
        "missing_url",
        "Network mode is selected but no networkNodeUrl is configured",
      );
    }
    if (!isAllowedNetworkNodeUrl(target.baseUrl)) {
      throw new OllamaTargetError(
        "blocked_host",
        "URL points to a blocked internal/loopback host",
      );
    }
  } else {
    const host = parsed.hostname.toLowerCase();
    const allowedLocal = new Set([
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "[::1]",
    ]);
    if (!allowedLocal.has(host)) {
      throw new OllamaTargetError(
        "local_url_not_loopback",
        `Local-mode Ollama URL must point at loopback (got ${host})`,
      );
    }
  }
  return target;
}
