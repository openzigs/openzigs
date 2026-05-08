/**
 * Per-session cost meter (epic #1053 / issue #1059).
 *
 * Tracks every model call against the GitHub Copilot pricing table and
 * persists per-call rows + per-session aggregates to SQLite (table
 * `session_costs`). For local-copilot calls the meter records `actualCost: 0`
 * and computes a `wouldHaveCost` figure against the cloud-equivalent price so
 * users see the dollar value they're saving by going local.
 *
 * Auditability: every row stores the pricing-table version + source ("live",
 * "cached", "bundled") so a cost claim can be traced back to a specific
 * snapshot of GitHub's pricing.
 */

import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";

import {
  BUNDLED_PRICING,
  computeCallCost,
  priceForModel,
  type PricingSource,
  type PricingTable,
} from "./copilot-pricing.js";
import type { AuditLogger } from "../logging/audit-logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProviderKind = "local-copilot" | "cloud";

export interface CallCostInput {
  sessionId: string;
  /** Model id as reported by the provider response. */
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  providerKind: ProviderKind;
  /** Optional cloud-equivalent model used for "would-have-cost" math when
   *  the call is local-copilot and the local model id has no pricing row. */
  cloudEquivalentModelId?: string;
  /** Optional override timestamp (tests). */
  occurredAt?: Date;
  /** Optional override callId. */
  callId?: string;
}

export interface CallCostRow {
  sessionId: string;
  callId: string;
  modelId: string;
  providerKind: ProviderKind;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** USD actually billed by the provider. 0 for local. */
  actualCost: number;
  /** USD that would have been billed by the cloud equivalent. */
  wouldHaveCost: number;
  pricingVersion: string;
  pricingSource: PricingSource;
  occurredAt: string;
}

export interface SessionCostAggregate {
  sessionId: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalActualCost: number;
  totalWouldHaveCost: number;
  /** wouldHave − actual (what going local saved you). */
  savedByLocal: number;
  pricingSource: PricingSource;
  pricingVersion: string;
  pricingFetchedAt: string;
  /** Most recent call timestamp, or null when no calls. */
  lastCallAt: string | null;
}

export type CostMeterOptions = {
  db: Database;
  /** Active pricing table. Default: bundled fallback. */
  pricing?: PricingTable;
  /** Optional audit logger. */
  auditLogger?: AuditLogger;
  /** Override clock. */
  clock?: () => Date;
};

// ── Migration ────────────────────────────────────────────────────────────────

export const migrateSessionCostsTable = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_costs (
      session_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider_kind TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      actual_cost REAL NOT NULL DEFAULT 0,
      would_have_cost REAL NOT NULL DEFAULT 0,
      pricing_version TEXT NOT NULL,
      pricing_source TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (session_id, call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_costs_session
      ON session_costs(session_id, occurred_at);
  `);
};

// ── Service ──────────────────────────────────────────────────────────────────

export class CostMeter {
  private readonly db: Database;
  private pricing: PricingTable;
  private readonly auditLogger?: AuditLogger;
  private readonly clock: () => Date;

  constructor(options: CostMeterOptions) {
    this.db = options.db;
    this.pricing = options.pricing ?? BUNDLED_PRICING;
    this.auditLogger = options.auditLogger;
    this.clock = options.clock ?? (() => new Date());
    migrateSessionCostsTable(this.db);
  }

  setPricing(pricing: PricingTable): void {
    this.pricing = pricing;
  }

  getPricing(): PricingTable {
    return this.pricing;
  }

  /**
   * Record a single model call. Idempotent on `(sessionId, callId)` — re-recording
   * the same call replaces the prior row (defends against retry storms).
   */
  record(input: CallCostInput): CallCostRow {
    const callId = input.callId ?? randomUUID();
    const occurredAt = (input.occurredAt ?? this.clock()).toISOString();
    const cachedTokens = input.cachedTokens ?? 0;

    // For local-copilot: actualCost = 0; would-have-cost is computed against
    // the cloud-equivalent model id (or the local model id directly if it
    // happens to match a pricing row, e.g. someone is running the same model
    // remotely).
    const cloudModelId =
      input.providerKind === "local-copilot"
        ? input.cloudEquivalentModelId ?? input.modelId
        : input.modelId;
    const cloudRow = priceForModel(this.pricing, cloudModelId);
    const wouldHaveCost = computeCallCost(cloudRow, {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedTokens,
    });
    const actualCost =
      input.providerKind === "local-copilot" ? 0 : wouldHaveCost;

    const row: CallCostRow = {
      sessionId: input.sessionId,
      callId,
      modelId: input.modelId,
      providerKind: input.providerKind,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedTokens,
      actualCost,
      wouldHaveCost,
      pricingVersion: this.pricing.version,
      pricingSource: this.pricing.source,
      occurredAt,
    };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_costs (
            session_id, call_id, model_id, provider_kind,
            input_tokens, output_tokens, cached_tokens,
            actual_cost, would_have_cost,
            pricing_version, pricing_source, occurred_at
         ) VALUES (
            @sessionId, @callId, @modelId, @providerKind,
            @inputTokens, @outputTokens, @cachedTokens,
            @actualCost, @wouldHaveCost,
            @pricingVersion, @pricingSource, @occurredAt
         )`,
      )
      .run(row);

    if (this.auditLogger) {
      void this.auditLogger.log({
        category: "system",
        level: "info",
        sessionId: row.sessionId,
        event: "cost.recorded",
        details: {
          callId: row.callId,
          modelId: row.modelId,
          providerKind: row.providerKind,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cachedTokens: row.cachedTokens,
          actualCost: row.actualCost,
          wouldHaveCost: row.wouldHaveCost,
          pricingVersion: row.pricingVersion,
          pricingSource: row.pricingSource,
        },
      });
    }

    return row;
  }

  /** Aggregate totals for a session. */
  aggregate(sessionId: string): SessionCostAggregate {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS callCount,
           COALESCE(SUM(input_tokens), 0)   AS totalInputTokens,
           COALESCE(SUM(output_tokens), 0)  AS totalOutputTokens,
           COALESCE(SUM(cached_tokens), 0)  AS totalCachedTokens,
           COALESCE(SUM(actual_cost), 0)    AS totalActualCost,
           COALESCE(SUM(would_have_cost), 0) AS totalWouldHaveCost,
           MAX(occurred_at)                 AS lastCallAt
         FROM session_costs
         WHERE session_id = ?`,
      )
      .get(sessionId) as {
      callCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCachedTokens: number;
      totalActualCost: number;
      totalWouldHaveCost: number;
      lastCallAt: string | null;
    };

    return {
      sessionId,
      callCount: row.callCount,
      totalInputTokens: row.totalInputTokens,
      totalOutputTokens: row.totalOutputTokens,
      totalCachedTokens: row.totalCachedTokens,
      totalActualCost: row.totalActualCost,
      totalWouldHaveCost: row.totalWouldHaveCost,
      savedByLocal: Math.max(0, row.totalWouldHaveCost - row.totalActualCost),
      pricingSource: this.pricing.source,
      pricingVersion: this.pricing.version,
      pricingFetchedAt: this.pricing.fetchedAt,
      lastCallAt: row.lastCallAt,
    };
  }

  /** All recorded calls for a session, oldest-first. */
  callsForSession(sessionId: string): CallCostRow[] {
    const rows = this.db
      .prepare(
        `SELECT
            session_id      AS sessionId,
            call_id         AS callId,
            model_id        AS modelId,
            provider_kind   AS providerKind,
            input_tokens    AS inputTokens,
            output_tokens   AS outputTokens,
            cached_tokens   AS cachedTokens,
            actual_cost     AS actualCost,
            would_have_cost AS wouldHaveCost,
            pricing_version AS pricingVersion,
            pricing_source  AS pricingSource,
            occurred_at     AS occurredAt
         FROM session_costs
         WHERE session_id = ?
         ORDER BY occurred_at ASC`,
      )
      .all(sessionId);
    return rows as CallCostRow[];
  }
}
