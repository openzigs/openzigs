/**
 * Sub-issue #908 — webhook-manager.safeCompare must not leak input length
 * via timing of the throw-on-mismatch path.
 *
 * The patched implementation pads both buffers to a common length, runs
 * `timingSafeEqual` on the equal-length buffers, then ANDs the result with
 * an explicit length check. This test exercises three properties:
 *   1. equal strings compare equal
 *   2. unequal-length strings always return false
 *   3. equal-length / different-content strings return false
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WebhookManager } from "./webhook-manager.js";
import { WebhookRepository } from "./webhook-repository.js";

const buildManager = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new WebhookRepository(db);
  repo.migrate();
  return new WebhookManager(repo);
};

const callSafeCompare = (mgr: WebhookManager, a: string, b: string): boolean => {
  // safeCompare is private; use bracket-access for the test.
  return (mgr as unknown as { safeCompare: (x: string, y: string) => boolean })
    .safeCompare(a, b);
};

describe("WebhookManager.safeCompare (sub-issue #908)", () => {
  const mgr = buildManager();

  it("returns true for identical strings", () => {
    expect(callSafeCompare(mgr, "abc123", "abc123")).toBe(true);
  });

  it("returns false for equal-length strings with different content", () => {
    expect(callSafeCompare(mgr, "abc123", "xyz456")).toBe(false);
  });

  it("returns false for unequal-length strings without throwing", () => {
    expect(callSafeCompare(mgr, "short", "longer-string-here")).toBe(false);
    expect(callSafeCompare(mgr, "longer-string-here", "short")).toBe(false);
  });

  it("returns false for empty / non-empty mismatch", () => {
    expect(callSafeCompare(mgr, "", "x")).toBe(false);
    expect(callSafeCompare(mgr, "x", "")).toBe(false);
  });

  it("handles empty/empty without throwing", () => {
    expect(callSafeCompare(mgr, "", "")).toBe(true);
  });
});
