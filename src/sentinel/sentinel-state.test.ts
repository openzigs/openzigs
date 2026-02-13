import { describe, expect, it } from "vitest";
import {
  defaultState,
  SentinelConfigSchema,
} from "./sentinel-state.js";

// Override SENTINEL_DIR for isolated tests by patching the module internals isn't
// straightforward here, so we test the pure-logic functions directly and do basic
// state round-trip tests using the actual default paths (which go to ~/.openzigs/sentinel/).
// For CI isolation we rely on the schema validation and default-state tests.

const NOW = new Date("2026-06-15T12:00:00Z");
const clock = () => NOW;

describe("sentinel-state", () => {
  describe("SentinelConfigSchema", () => {
    it("parses a full config", () => {
      const input = {
        enabled: true,
        model: "gpt-4o",
        checkIntervalMinutes: 5,
        jitterMinutes: 3,
        digestHour: 10,
        auditHour: 3,
        consecutiveFailureThreshold: 5,
        queueDepthThreshold: 20,
      };

      const parsed = SentinelConfigSchema.parse(input);
      expect(parsed.enabled).toBe(true);
      expect(parsed.model).toBe("gpt-4o");
      expect(parsed.checkIntervalMinutes).toBe(5);
      expect(parsed.jitterMinutes).toBe(3);
    });

    it("applies defaults for missing fields", () => {
      const parsed = SentinelConfigSchema.parse({});
      expect(parsed.enabled).toBe(false);
      expect(parsed.model).toBe("gpt-4o-mini");
      expect(parsed.checkIntervalMinutes).toBe(15);
      expect(parsed.consecutiveFailureThreshold).toBe(3);
    });

    it("rejects invalid values", () => {
      expect(() => SentinelConfigSchema.parse({ checkIntervalMinutes: 0 })).toThrow();
      expect(() => SentinelConfigSchema.parse({ digestHour: 25 })).toThrow();
      expect(() => SentinelConfigSchema.parse({ queueDepthThreshold: 0 })).toThrow();
    });

    // ── #195/#196/#197: New config field defaults ────────────────────

    it("applies defaults for digest/alerting/scheduler fields (#195/#196/#197)", () => {
      const parsed = SentinelConfigSchema.parse({});

      // #195: State & Memory
      expect(parsed.persistMarkdownDigest).toBe(true);
      expect(parsed.markdownDigestPath).toBeNull();
      expect(parsed.digestRetentionDays).toBe(30);

      // #196: Multi-channel alerts
      expect(parsed.notifyChannels).toEqual(["admin"]);
      expect(parsed.criticalCooldownMinutes).toBe(5);
      expect(parsed.warningCooldownMinutes).toBe(30);

      // #197: Scheduler
      expect(parsed.timezone).toBe("UTC");
      expect(parsed.noOverlap).toBe(true);
      expect(parsed.maxRandomDelayMs).toBe(0);
    });

    it("accepts custom values for new config fields", () => {
      const parsed = SentinelConfigSchema.parse({
        persistMarkdownDigest: false,
        markdownDigestPath: "/tmp/sentinel/status.md",
        digestRetentionDays: 7,
        notifyChannels: ["admin", "telegram", "discord"],
        criticalCooldownMinutes: 2,
        warningCooldownMinutes: 60,
        timezone: "America/New_York",
        noOverlap: false,
        maxRandomDelayMs: 5000,
      });

      expect(parsed.persistMarkdownDigest).toBe(false);
      expect(parsed.markdownDigestPath).toBe("/tmp/sentinel/status.md");
      expect(parsed.digestRetentionDays).toBe(7);
      expect(parsed.notifyChannels).toEqual(["admin", "telegram", "discord"]);
      expect(parsed.criticalCooldownMinutes).toBe(2);
      expect(parsed.warningCooldownMinutes).toBe(60);
      expect(parsed.timezone).toBe("America/New_York");
      expect(parsed.noOverlap).toBe(false);
      expect(parsed.maxRandomDelayMs).toBe(5000);
    });

    it("rejects invalid retention days and cooldown values", () => {
      expect(() => SentinelConfigSchema.parse({ digestRetentionDays: 0 })).toThrow();
      expect(() => SentinelConfigSchema.parse({ criticalCooldownMinutes: 0 })).toThrow();
      expect(() => SentinelConfigSchema.parse({ warningCooldownMinutes: 0 })).toThrow();
      expect(() => SentinelConfigSchema.parse({ maxRandomDelayMs: -1 })).toThrow();
    });
  });

  describe("defaultState", () => {
    it("creates a state with timestamps from the clock", () => {
      const state = defaultState(clock);
      expect(state.lastTaskCheckAt).toBe("2026-06-15T12:00:00.000Z");
      expect(state.lastDigestAt).toBeNull();
      expect(state.lastPromptAuditAt).toBeNull();
      expect(state.consecutiveFailures).toBe(0);
      expect(state.totalTasksReviewed).toBe(0);
      expect(state.alertsSent).toBe(0);
      expect(state.enabled).toBe(true);
      expect(state.modelOverride).toBeNull();
    });

    it("creates a state with current time when no clock provided", () => {
      const state = defaultState();
      expect(new Date(state.lastTaskCheckAt).getTime()).toBeGreaterThan(0);
    });
  });
});
