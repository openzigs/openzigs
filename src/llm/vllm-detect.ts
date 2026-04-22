/**
 * vLLM auto-detection + BYOK auto-registration.
 *
 * Issue #920 (Epic #888). At server boot we probe `/v1/models` on the local
 * vLLM endpoint with a 2s timeout. If reachable AND no BYOK provider is
 * already configured for that base URL, we:
 *   1. Generate a 32-byte API key via `crypto.randomBytes(32).toString("base64url")`.
 *   2. Append a `copilot.provider` block to `~/.openzigs/config.json` with mode 0o600.
 *   3. Mirror the key to `~/.openzigs/vllm-api-key` (mode 0o600) so the sidecar
 *      launcher and the backend agree.
 *
 * Security non-negotiables (OWASP ASVS V6.3.1):
 *   - RNG MUST be `crypto.randomBytes`. `Math.random` is forbidden.
 *   - The API key value is never logged.
 *   - Existing user-defined providers are never silently overwritten.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  chmodSecureFile,
  secureDirOptions,
  secureWriteOptions,
} from "../config/file-permissions.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 2000;

export interface DetectResult {
  available: boolean;
  model?: string;
  error?: string;
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

export interface DetectOptions {
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to AbortSignal.timeout. */
  signal?: AbortSignal;
}

/**
 * Single GET to /v1/models with a hard timeout. Never throws; returns
 * `{ available: false }` on any error.
 */
export async function detectLocalVllm(
  baseUrl: string = DEFAULT_BASE_URL,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  opts: DetectOptions = {},
): Promise<DetectResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  try {
    const resp = await fetchImpl(url, { signal });
    if (!resp.ok) {
      return { available: false, error: `HTTP ${resp.status}` };
    }
    const json = (await resp.json()) as ModelsResponse;
    const model = json.data?.[0]?.id;
    return { available: true, model };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AutoRegisterOptions {
  configPath?: string;
  keyFilePath?: string;
  baseUrl?: string;
  /** When false, the function is a no-op. */
  enabled?: boolean;
  /** Test seam — override the entropy source. */
  randomBytesImpl?: (size: number) => Buffer;
  /** Detection result — pass `await detectLocalVllm()` or a stub. */
  detection?: DetectResult;
  /** Optional logger (info-only). API key is NEVER passed in. */
  logger?: {
    info?: (msg: string, details?: Record<string, unknown>) => void;
    warn?: (msg: string, details?: Record<string, unknown>) => void;
  };
}

export type AutoRegisterStatus =
  | "registered"
  | "already-configured"
  | "skipped-disabled"
  | "skipped-undetected";

export interface AutoRegisterResult {
  status: AutoRegisterStatus;
  /** Number of bytes of entropy used (for tests; not the key itself). */
  keyByteLength?: number;
}

const DEFAULT_CONFIG_PATH = () =>
  process.env.OPENZIGS_CONFIG_PATH ??
  path.join(os.homedir(), ".openzigs", "config.json");

const DEFAULT_KEY_FILE = () =>
  path.join(os.homedir(), ".openzigs", "vllm-api-key");

const DEFAULT_VLLM_BASE_URL = `${DEFAULT_BASE_URL}/v1`;

/**
 * Idempotent auto-register flow. Returns the action taken so callers (server
 * boot) can log a single line without exposing the key.
 */
export async function autoRegisterIfDetected(
  opts: AutoRegisterOptions = {},
): Promise<AutoRegisterResult> {
  if (opts.enabled === false) {
    return { status: "skipped-disabled" };
  }
  const detection = opts.detection ?? (await detectLocalVllm(opts.baseUrl));
  if (!detection.available) {
    return { status: "skipped-undetected" };
  }
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH();
  const keyFilePath = opts.keyFilePath ?? DEFAULT_KEY_FILE();
  const targetBaseUrl =
    (opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, "")}/v1` : null) ??
    DEFAULT_VLLM_BASE_URL;

  const userConfig = await readConfig(configPath);
  const existing = (userConfig.copilot as Record<string, unknown> | undefined)
    ?.provider as Record<string, unknown> | undefined;
  if (existing && typeof existing.baseUrl === "string") {
    if (existing.baseUrl.replace(/\/+$/, "") === targetBaseUrl.replace(/\/+$/, "")) {
      opts.logger?.info?.(
        "vLLM detected; provider already configured — leaving user config unchanged",
        { baseUrl: targetBaseUrl, model: detection.model },
      );
      return { status: "already-configured" };
    }
  }

  // Generate a fresh key — crypto.randomBytes is the only acceptable source.
  const rng = opts.randomBytesImpl ?? randomBytes;
  const keyBuf = rng(32);
  if (keyBuf.length !== 32) {
    throw new Error("randomBytes returned wrong size");
  }
  const apiKey = keyBuf.toString("base64url");

  const copilot = (userConfig.copilot ?? {}) as Record<string, unknown>;
  copilot.provider = {
    type: "openai",
    baseUrl: targetBaseUrl,
    model: detection.model ?? "",
    apiKey,
  };
  userConfig.copilot = copilot;
  await writeConfig(configPath, userConfig);
  await writeKeyFile(keyFilePath, apiKey);

  if (process.platform === "win32") {
    opts.logger?.warn?.(
      "vLLM API key written to a Windows path — file ACLs inherit from your user profile dir; verify only your account has access",
      { keyFilePath },
    );
  }
  opts.logger?.info?.(
    "Auto-registered local vLLM as BYOK provider",
    { baseUrl: targetBaseUrl, model: detection.model },
  );
  return { status: "registered", keyByteLength: 32 };
}

async function readConfig(p: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return {};
    }
    throw err;
  }
}

async function writeConfig(
  p: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(p), secureDirOptions());
  await fs.writeFile(p, JSON.stringify(data, null, 2), secureWriteOptions());
  await chmodSecureFile(p);
}

async function writeKeyFile(p: string, key: string): Promise<void> {
  await fs.mkdir(path.dirname(p), secureDirOptions());
  await fs.writeFile(p, key, secureWriteOptions());
  await chmodSecureFile(p);
}
