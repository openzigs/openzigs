/**
 * Latency-based smart router (epic #1053 / issue #1062).
 *
 * Given a prompt, an estimated input-token count, and the current local-LLM
 * configuration state, decides whether the next call should be routed to the
 * local provider or to the cloud provider.
 *
 * Rules (locked product-owner decision 2026-05-08):
 *   - Privacy mode is the hard kill switch — it ALWAYS forces local. If the
 *     local provider is not configured AND privacy mode is on, we surface a
 *     hard error rather than silently falling back to cloud.
 *   - When privacy mode is off, local is configured, and the input estimate
 *     is ≤ `cloudThresholdTokens` → local.
 *   - Otherwise → cloud.
 *
 * Every decision is reported with a machine-readable `reason` string suitable
 * for audit logging. The reasons are stable identifiers — UI can localise.
 */

export type PrivacyMode = "off" | "session" | "global";

export interface SmartRouterInput {
  /** Prompt text. Used only for token estimation when `inputTokens` not given. */
  prompt?: string;
  /** Caller-supplied token estimate. When omitted we estimate as
   *  `Math.ceil((prompt?.length ?? 0) / 4)` — conservative for English text. */
  inputTokens?: number;
  /** Whether a local-copilot provider is configured + reachable. */
  localProviderConfigured: boolean;
  /** Current privacy mode (off / per-session / global). */
  privacyMode: PrivacyMode;
  /**
   * Threshold above which the call must go to cloud, even in non-privacy mode.
   * Default 4096 (planner default).
   */
  cloudThresholdTokens?: number;
  /** Whether the smart router is enabled at all. When false → always cloud. */
  enabled?: boolean;
}

export type RoutingProvider = "local" | "cloud";

export type RoutingReason =
  // Privacy paths
  | "privacy_mode_local"
  | "privacy_mode_no_local_provider"
  // Smart-router paths
  | "router_disabled"
  | "no_local_provider"
  | "below_threshold_local"
  | "above_threshold_cloud";

export interface RoutingDecision {
  provider: RoutingProvider;
  reason: RoutingReason;
  /** The token estimate that was actually used for the decision. */
  estimatedTokens: number;
  /** The threshold consulted (echoed for audit clarity). */
  thresholdTokens: number;
  /** Privacy mode in effect at decision time. */
  privacyMode: PrivacyMode;
}

export const DEFAULT_CLOUD_THRESHOLD_TOKENS = 4096;

/** Conservative tokenisation estimate when caller did not provide one. */
export const estimateInputTokens = (prompt: string): number => {
  if (!prompt) return 0;
  return Math.ceil(prompt.length / 4);
};

/**
 * Routing failure raised when privacy mode forbids cloud usage AND no local
 * provider is configured. Callers MUST surface this to the user — the router
 * will never silently fall back to cloud when privacy mode is on.
 */
export class RouterPrivacyError extends Error {
  readonly code = "ROUTER_PRIVACY_NO_LOCAL_PROVIDER" as const;
  constructor(
    message = "Privacy mode is on but no local LLM provider is configured.",
  ) {
    super(message);
    this.name = "RouterPrivacyError";
  }
}

/**
 * Decide where to route the next call. Pure function — no side effects, safe
 * to call from anywhere. Wire up audit logging at the call site.
 */
export const routeRequest = (input: SmartRouterInput): RoutingDecision => {
  const threshold =
    input.cloudThresholdTokens ?? DEFAULT_CLOUD_THRESHOLD_TOKENS;
  const tokens =
    typeof input.inputTokens === "number" && Number.isFinite(input.inputTokens)
      ? Math.max(0, Math.floor(input.inputTokens))
      : estimateInputTokens(input.prompt ?? "");

  // 1. Privacy mode is the hard kill switch.
  if (input.privacyMode !== "off") {
    if (!input.localProviderConfigured) {
      throw new RouterPrivacyError();
    }
    return {
      provider: "local",
      reason: "privacy_mode_local",
      estimatedTokens: tokens,
      thresholdTokens: threshold,
      privacyMode: input.privacyMode,
    };
  }

  // 2. Router disabled → always cloud.
  if (input.enabled === false) {
    return {
      provider: "cloud",
      reason: "router_disabled",
      estimatedTokens: tokens,
      thresholdTokens: threshold,
      privacyMode: input.privacyMode,
    };
  }

  // 3. No local provider configured → cloud.
  if (!input.localProviderConfigured) {
    return {
      provider: "cloud",
      reason: "no_local_provider",
      estimatedTokens: tokens,
      thresholdTokens: threshold,
      privacyMode: input.privacyMode,
    };
  }

  // 4. Threshold check.
  if (tokens <= threshold) {
    return {
      provider: "local",
      reason: "below_threshold_local",
      estimatedTokens: tokens,
      thresholdTokens: threshold,
      privacyMode: input.privacyMode,
    };
  }

  return {
    provider: "cloud",
    reason: "above_threshold_cloud",
    estimatedTokens: tokens,
    thresholdTokens: threshold,
    privacyMode: input.privacyMode,
  };
};
