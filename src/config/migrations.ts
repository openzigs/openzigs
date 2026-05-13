/**
 * Issue #1090 — Auto-migrate `allowLan` for existing RFC1918 node URLs.
 *
 * After upgrade, any node namespace (`imageGen`, `videoGen`, `musicGen`,
 * `musicStudio`, `lipSync`, `audioSidecar`, `sadTalker`) that already has a
 * `networkNodeUrl` pointing at a private LAN address gets `allowLan: true`
 * auto-set so the new SSRF guard does not break working setups.
 *
 * Pure function on the user's raw config object — caller decides whether to
 * write it back to disk and emit log messages.
 */

import { isLikelyLanUrl } from "../queue/url-validator.js";

/** Top-level config keys that hold node-worker config. */
export const NODE_NAMESPACES = [
  "imageGen",
  "videoGen",
  "musicGen",
  "musicStudio",
  "lipSync",
  "audioSidecar",
  "sadTalker",
] as const;

export interface MigrationResult {
  /** Updated user config (a new object — does not mutate the input). */
  userConfig: Record<string, unknown>;
  /** Namespaces where allowLan was newly auto-enabled. */
  migratedNamespaces: string[];
}

/**
 * Apply the RFC1918 → `allowLan: true` migration.
 *
 * Idempotent: namespaces that already have an explicit `allowLan` value are
 * left untouched, regardless of their URL.
 */
export function migrateAllowLan(
  userConfig: Record<string, unknown> | null | undefined,
): MigrationResult {
  const next: Record<string, unknown> = userConfig ? { ...userConfig } : {};
  const migrated: string[] = [];

  for (const ns of NODE_NAMESPACES) {
    const existing = next[ns];
    if (!existing || typeof existing !== "object") continue;
    const obj = existing as Record<string, unknown>;
    if (typeof obj.networkNodeUrl !== "string" || !obj.networkNodeUrl) continue;
    if ("allowLan" in obj) continue;
    if (!isLikelyLanUrl(obj.networkNodeUrl)) continue;

    next[ns] = { ...obj, allowLan: true };
    migrated.push(ns);
  }

  return { userConfig: next, migratedNamespaces: migrated };
}
