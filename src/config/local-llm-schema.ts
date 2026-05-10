/**
 * Zod schemas + types for local LLM configuration (epic #1053).
 *
 * Adds three top-level schema fragments without disturbing existing config layout:
 *   - `localLlm` block: provider definition, autodetect flag, vLLM API key, privacy mode.
 *   - `sentinel.localLlmHealth` block: health-check tuning (consumed in #1055).
 *
 * All fields are optional with sensible defaults. Backward-compatible with
 * existing `~/.openzigs/config.json` files that have none of these keys.
 */

import { z } from "zod";

// ── local-copilot provider ────────────────────────────────────────────────

/**
 * BYOK provider type that wraps `@github/copilot-sdk` against a local OpenAI-
 * compatible endpoint (Ollama, vLLM, llama.cpp, etc.) with `COPILOT_OFFLINE=true`.
 */
export const localCopilotProviderSchema = z.object({
  type: z.literal("local-copilot"),
  /** Base URL including `/v1` suffix, e.g. `http://127.0.0.1:11434/v1`. */
  endpoint: z.string().url(),
  /** Model id served by the endpoint, e.g. `gemma4:26b`. */
  model: z.string().min(1),
  /** Optional bearer token / API key (vLLM auto-generates one). */
  apiKey: z.string().optional(),
  /** Per-request timeout in ms. Default 120s. */
  timeoutMs: z.number().int().min(1000).max(600_000).optional().default(120_000),
});

export type LocalCopilotProviderConfig = z.infer<
  typeof localCopilotProviderSchema
>;

// ── privacy mode ──────────────────────────────────────────────────────────

/**
 * Global lockdown flag: when true, no session may route to a non-local provider,
 * regardless of per-session toggle. Per-session privacy mode is tracked at the
 * session layer, not in config.
 */
export const privacyModeSchema = z.object({
  globalLockdown: z.boolean().optional().default(false),
});

export type PrivacyModeConfig = z.infer<typeof privacyModeSchema>;

// ── localLlm top-level block ─────────────────────────────────────────────

// ── smart router (#1062) ────────────────────────────────────────────────

/**
 * Latency-based smart router config. When enabled and a local provider is
 * configured, requests with an estimated input <= `cloudThresholdTokens` go
 * to the local provider; everything else goes to cloud. Privacy mode always
 * overrides this.
 */
export const smartRouterSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    /** Default 4096 tokens — planner's locked decision (2026-05-08). */
    cloudThresholdTokens: z.number().int().min(0).max(1_000_000).optional().default(4096),
  })
  .optional()
  .default({ enabled: true, cloudThresholdTokens: 4096 });

export type SmartRouterConfig = z.infer<typeof smartRouterSchema>;

// ── cost meter (#1059) ──────────────────────────────────────────────────

/**
 * Per-session cost meter config. Controls whether the meter fetches the live
 * pricing table from GitHub docs at startup, and where the cache lives.
 */
export const costMeterSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    /** Try to fetch the live pricing table on startup. Falls back to cache → bundled on failure. */
    fetchLivePricing: z.boolean().optional().default(true),
    /** Override the upstream pricing URL (rarely needed; here for tests + air-gapped mirrors). */
    pricingUrl: z.string().url().optional(),
  })
  .optional()
  .default({ enabled: true, fetchLivePricing: true });

export type CostMeterConfig = z.infer<typeof costMeterSchema>;

export const localLlmSchema = z
  .object({
    /** Probe `/v1/models` on Ollama (11434) and vLLM (8000) at startup. */
    autodetect: z.boolean().optional().default(true),
    /** Active local-copilot provider (null when not configured). */
    provider: localCopilotProviderSchema.nullable().optional().default(null),
    /**
     * Auto-generated vLLM API key, persisted by the server on first launch.
     * Surfaced once in admin UI on creation; masked thereafter. Rotation
     * regenerates the value via `/api/admin/local-llm/vllm-key/rotate`.
     */
    vllmApiKey: z.string().optional(),
    privacyMode: privacyModeSchema.optional().default({ globalLockdown: false }),
    /** Latency-based smart router (#1062). */
    smartRouter: smartRouterSchema,
    /** Per-session cost meter (#1059). */
    costMeter: costMeterSchema,
  })
  .optional()
  .default({
    autodetect: true,
    provider: null,
    privacyMode: { globalLockdown: false },
    smartRouter: { enabled: true, cloudThresholdTokens: 4096 },
    costMeter: { enabled: true, fetchLivePricing: true },
  });

export type LocalLlmConfig = z.infer<typeof localLlmSchema>;

// ── sentinel.localLlmHealth ──────────────────────────────────────────────

/**
 * Sentinel rule tuning for `local-llm-health`. Defaults match planner spec
 * (3 fails over 60s → failover; 5 successes → failback).
 */
export const localLlmHealthSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    intervalMs: z.number().int().min(1000).optional().default(30_000),
    failoverThreshold: z.number().int().min(1).optional().default(3),
    failoverWindowMs: z.number().int().min(1000).optional().default(60_000),
    failbackSuccesses: z.number().int().min(1).optional().default(5),
    /** Probe timeout in ms. */
    probeTimeoutMs: z.number().int().min(100).optional().default(2000),
  })
  .optional()
  .default({
    enabled: true,
    intervalMs: 30_000,
    failoverThreshold: 3,
    failoverWindowMs: 60_000,
    failbackSuccesses: 5,
    probeTimeoutMs: 2000,
  });

export type LocalLlmHealthConfig = z.infer<typeof localLlmHealthSchema>;
