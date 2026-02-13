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
