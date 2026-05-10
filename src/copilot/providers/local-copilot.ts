/**
 * Local-Copilot provider helpers (epic #1053 / #1054).
 *
 * Pure helpers that build a `local-copilot` ProviderConfig from a validated
 * `LocalCopilotProviderConfig` (Zod-checked elsewhere) and apply it to a
 * CopilotWrapperService. Kept tiny on purpose: the heavy lifting (env var
 * flipping, SDK shape mapping, session invalidation) lives in
 * `copilot-wrapper.ts` so this module stays trivially testable.
 */

import type { LocalCopilotProviderConfig } from "../../config/local-llm-schema.js";
import type { ProviderConfig } from "../copilot-wrapper.js";
import { logger } from "../../logging/logger.js";
import type { AuditLogger } from "../../logging/audit-logger.js";

export type ApplyLocalCopilotDeps = {
  /** A wrapper-shaped object — typed loosely so tests can pass a fake. */
  wrapper: { setProvider(provider: ProviderConfig | undefined): void };
  config: LocalCopilotProviderConfig;
  auditLogger?: AuditLogger;
};

/** Build the wrapper-internal ProviderConfig shape from validated config. */
export function buildLocalCopilotProvider(
  config: LocalCopilotProviderConfig,
): Extract<ProviderConfig, { type: "local-copilot" }> {
  return {
    type: "local-copilot",
    endpoint: config.endpoint,
    model: config.model,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  };
}

/**
 * Apply a local-copilot provider to the wrapper and emit an audit log.
 * The wrapper is responsible for setting COPILOT_OFFLINE=true.
 */
export async function applyLocalCopilotProvider(
  deps: ApplyLocalCopilotDeps,
): Promise<void> {
  const provider = buildLocalCopilotProvider(deps.config);
  deps.wrapper.setProvider(provider);
  logger.info("Local-Copilot provider activated", {
    endpoint: provider.endpoint,
    model: provider.model,
  });
  if (deps.auditLogger) {
    await deps.auditLogger.log({
      level: "info",
      category: "session",
      event: "provider.registered",
      details: {
        type: provider.type,
        endpoint: provider.endpoint,
        model: provider.model,
      },
    });
  }
}

/** Clear the active provider (and the COPILOT_OFFLINE env flag). */
export function clearLocalCopilotProvider(deps: {
  wrapper: { setProvider(provider: ProviderConfig | undefined): void };
}): void {
  deps.wrapper.setProvider(undefined);
}
