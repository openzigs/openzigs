/**
 * LocalEndpointHealthMonitor — Sentinel module for epic #1053 / issue #1055.
 *
 * Polls the active local-copilot endpoint's `/v1/models` route on a fixed
 * cadence and runs a simple state machine that gates failover:
 *
 *   healthy        ──(N consecutive failures within window)──▶ failed-over
 *   failed-over    ──(M consecutive successes)──────────────▶ healthy
 *
 * Defaults (locked by product owner): 3 failures inside a 60s window trip
 * failover; 5 consecutive successes restore service. Probe cadence 30s,
 * probe timeout 2s.
 *
 * Privacy mode is a hard short-circuit. When global lockdown is active (or a
 * per-session block flag is true), `assertAvailable()` throws
 * `LOCAL_ENDPOINT_UNAVAILABLE_PRIVACY_MODE` regardless of the health state —
 * we will not silently hand work off to a remote provider.
 *
 * State persists to ~/.openzigs/sentinel/local-endpoint-health.json via
 * write-to-temp-then-rename. A `clock?: () => Date` injection makes the
 * window math fully deterministic for tests.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  secureDirOptions,
  secureWriteOptions,
} from "../config/file-permissions.js";
import { logger } from "../logging/logger.js";
import type { AuditLogger } from "../logging/audit-logger.js";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".openzigs", "sentinel");
const DEFAULT_STATE_FILE = path.join(
  DEFAULT_STATE_DIR,
  "local-endpoint-health.json",
);

export type HealthStatus =
  | "healthy"
  | "degraded"
  | "failed-over"
  | "disabled";

export interface LocalEndpointHealthState {
  status: HealthStatus;
  lastProbeAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failoverActive: boolean;
  /** Sliding window of recent failure timestamps (ms epoch). */
  failureWindow: number[];
}

export interface LocalEndpointHealthOptions {
  endpoint: string;
  /** Bearer/api-key for the endpoint, if any. */
  apiKey?: string;
  /** Polling interval, ms. */
  intervalMs?: number;
  /** Per-probe HTTP timeout, ms. */
  probeTimeoutMs?: number;
  /** N failures in window → failover. */
  failoverThreshold?: number;
  /** Sliding window length, ms. */
  failoverWindowMs?: number;
  /** M successes in a row → failback. */
  failbackSuccesses?: number;
  /** State file path override (tests). */
  statePath?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Frozen clock for tests. */
  clock?: () => Date;
  /** Audit logger (security/system events). */
  auditLogger?: AuditLogger;
  /** Privacy-mode read fn — when true, assertAvailable() throws. */
  isPrivacyLocked?: () => boolean;
}

export class LocalEndpointHealthMonitor extends EventEmitter {
  private state: LocalEndpointHealthState;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: Required<
    Omit<
      LocalEndpointHealthOptions,
      "apiKey" | "fetchImpl" | "auditLogger" | "isPrivacyLocked" | "clock"
    >
  > & {
    apiKey?: string;
    fetchImpl: typeof fetch;
    auditLogger?: AuditLogger;
    isPrivacyLocked: () => boolean;
    clock: () => Date;
  };

  constructor(options: LocalEndpointHealthOptions) {
    super();
    this.opts = {
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      intervalMs: options.intervalMs ?? 30000,
      probeTimeoutMs: options.probeTimeoutMs ?? 2000,
      failoverThreshold: options.failoverThreshold ?? 3,
      failoverWindowMs: options.failoverWindowMs ?? 60000,
      failbackSuccesses: options.failbackSuccesses ?? 5,
      statePath: options.statePath ?? DEFAULT_STATE_FILE,
      fetchImpl: options.fetchImpl ?? fetch,
      auditLogger: options.auditLogger,
      isPrivacyLocked: options.isPrivacyLocked ?? (() => false),
      clock: options.clock ?? (() => new Date()),
    };
    this.state = {
      status: "healthy",
      lastProbeAt: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      failoverActive: false,
      failureWindow: [],
    };
  }

  /** Snapshot of the current state (safe to expose via /status). */
  getState(): LocalEndpointHealthState {
    return { ...this.state, failureWindow: [...this.state.failureWindow] };
  }

  /** Begin periodic polling. Idempotent. */
  start(): void {
    if (this.timer) return;
    // Fire-and-forget the first probe immediately so /status doesn't lie.
    void this.probeOnce();
    this.timer = setInterval(() => {
      void this.probeOnce();
    }, this.opts.intervalMs);
    // Don't keep the event loop alive on its own.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop periodic polling. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Throw if the endpoint cannot serve the request. Two failure modes:
   *  - LOCAL_ENDPOINT_UNAVAILABLE_PRIVACY_MODE  → privacy lockdown engaged
   *  - LOCAL_ENDPOINT_UNAVAILABLE              → failover active
   * Both are surfaced as Errors with a `.code` property for upstream
   * handlers to discriminate without string-matching message text.
   */
  assertAvailable(): void {
    if (this.opts.isPrivacyLocked()) {
      const err = new Error("LOCAL_ENDPOINT_UNAVAILABLE_PRIVACY_MODE");
      (err as Error & { code: string }).code =
        "LOCAL_ENDPOINT_UNAVAILABLE_PRIVACY_MODE";
      // Fire-and-forget audit log; do not block the throw.
      void this.audit({
        level: "security",
        category: "security",
        event: "sentinel.privacy_mode_block",
        details: { endpoint: this.opts.endpoint },
      });
      throw err;
    }
    if (this.state.failoverActive) {
      const err = new Error("LOCAL_ENDPOINT_UNAVAILABLE");
      (err as Error & { code: string }).code = "LOCAL_ENDPOINT_UNAVAILABLE";
      throw err;
    }
  }

  /** Run one probe + state-machine evaluation. Exposed for tests. */
  async probeOnce(): Promise<void> {
    const ok = await this.probe();
    this.evaluate(ok);
    await this.persist();
  }

  /** Apply a probe result to the state machine. Pure, sync, testable. */
  evaluate(success: boolean): void {
    const now = this.opts.clock().getTime();
    this.state.lastProbeAt = new Date(now).toISOString();

    if (success) {
      this.state.consecutiveFailures = 0;
      this.state.consecutiveSuccesses += 1;
      this.state.failureWindow = [];
      if (
        this.state.failoverActive &&
        this.state.consecutiveSuccesses >= this.opts.failbackSuccesses
      ) {
        this.state.failoverActive = false;
        this.state.status = "healthy";
        this.emit("failback", { at: this.state.lastProbeAt });
        void this.audit({
          level: "info",
          category: "system",
          event: "sentinel.failback",
          details: {
            endpoint: this.opts.endpoint,
            consecutiveSuccesses: this.state.consecutiveSuccesses,
          },
        });
      } else if (!this.state.failoverActive) {
        this.state.status = "healthy";
      }
      return;
    }

    // Failure path
    this.state.consecutiveSuccesses = 0;
    this.state.consecutiveFailures += 1;
    // Trim sliding window to the failoverWindowMs lookback.
    const cutoff = now - this.opts.failoverWindowMs;
    this.state.failureWindow = this.state.failureWindow.filter(
      (t) => t >= cutoff,
    );
    this.state.failureWindow.push(now);

    if (
      !this.state.failoverActive &&
      this.state.failureWindow.length >= this.opts.failoverThreshold
    ) {
      this.state.failoverActive = true;
      this.state.status = "failed-over";
      this.emit("failover", {
        at: this.state.lastProbeAt,
        failuresInWindow: this.state.failureWindow.length,
      });
      void this.audit({
        level: "security",
        category: "system",
        event: "sentinel.failover",
        details: {
          endpoint: this.opts.endpoint,
          failuresInWindow: this.state.failureWindow.length,
          windowMs: this.opts.failoverWindowMs,
        },
      });
    } else if (!this.state.failoverActive) {
      this.state.status = "degraded";
    }
  }

  private async probe(): Promise<boolean> {
    try {
      const url = `${this.opts.endpoint.replace(/\/+$/, "")}/models`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      const res = await this.opts.fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.opts.probeTimeoutMs),
      });
      return res.ok;
    } catch (err) {
      logger.debug("local-endpoint probe failed", {
        endpoint: this.opts.endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.opts.statePath), secureDirOptions());
      const tmp = `${this.opts.statePath}.tmp`;
      await fs.writeFile(
        tmp,
        JSON.stringify(this.state, null, 2),
        secureWriteOptions(),
      );
      await fs.rename(tmp, this.opts.statePath);
    } catch (err) {
      logger.warn("Failed to persist local-endpoint health state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async audit(entry: {
    level: "info" | "warn" | "error" | "security";
    category: "system" | "security";
    event: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    if (!this.opts.auditLogger) return;
    try {
      await this.opts.auditLogger.log(entry);
    } catch {
      /* never let audit failure crash the monitor */
    }
  }
}
