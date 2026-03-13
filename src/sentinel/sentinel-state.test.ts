import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  defaultState,
  SentinelConfigSchema,
  readState,
  writeState,
  appendDigestRecord,
  pruneDigestHistory,
  writeStatusMarkdown,
  readStatusMarkdown,
  readDigestHistory,
  ensureSentinelDir,
  SentinelStateSchema,
  type DigestRecord,
} from "./sentinel-state.js";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import fsMock from "node:fs/promises";

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

  // ── File I/O functions ──

  describe("ensureSentinelDir", () => {
    beforeEach(() => vi.clearAllMocks());

    it("calls mkdir with recursive and 0o700 mode", async () => {
      await ensureSentinelDir();
      expect(fsMock.mkdir).toHaveBeenCalledWith(
        expect.stringContaining("sentinel"),
        expect.objectContaining({ recursive: true, mode: 0o700 }),
      );
    });
  });

  describe("readState", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns default state when file is missing", async () => {
      vi.mocked(fsMock.readFile).mockRejectedValueOnce(new Error("ENOENT"));
      const state = await readState(clock);
      expect(state.lastTaskCheckAt).toBe("2026-06-15T12:00:00.000Z");
      expect(state.enabled).toBe(true);
    });

    it("reads valid state from disk", async () => {
      const validState = {
        lastTaskCheckAt: "2026-01-01T00:00:00.000Z",
        lastDigestAt: null,
        lastPromptAuditAt: null,
        consecutiveFailures: 3,
        totalTasksReviewed: 42,
        alertsSent: 5,
        enabled: true,
        modelOverride: "gpt-4o",
      };
      vi.mocked(fsMock.readFile).mockResolvedValueOnce(JSON.stringify(validState));
      const state = await readState();
      expect(state.consecutiveFailures).toBe(3);
      expect(state.totalTasksReviewed).toBe(42);
      expect(state.modelOverride).toBe("gpt-4o");
    });

    it("returns default state when file is corrupt JSON", async () => {
      vi.mocked(fsMock.readFile).mockResolvedValueOnce("not valid json{{");
      const state = await readState(clock);
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe("writeState", () => {
    beforeEach(() => vi.clearAllMocks());

    it("writes state atomically (tmp + rename)", async () => {
      const state = defaultState(clock);
      await writeState(state);
      expect(fsMock.mkdir).toHaveBeenCalled();
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining("lastTaskCheckAt"),
        expect.objectContaining({ mode: 0o600 }),
      );
      expect(fsMock.rename).toHaveBeenCalled();
    });
  });

  describe("appendDigestRecord", () => {
    beforeEach(() => vi.clearAllMocks());

    it("appends a record and calls pruneDigestHistory", async () => {
      // pruneDigestHistory will try to readFile — let it fail gracefully
      vi.mocked(fsMock.readFile).mockRejectedValueOnce(new Error("ENOENT"));

      const record: DigestRecord = {
        timestamp: "2026-06-15T09:00:00Z",
        period: { from: "2026-06-14T09:00:00Z", to: "2026-06-15T09:00:00Z" },
        taskSummary: { completed: 10, failed: 2, cancelled: 1, successRate: 0.77 },
        tokenBurn: null,
        promptAudit: null,
        promptRecommendations: null,
        alertCount: 0,
      };
      await appendDigestRecord(record, 30);
      expect(fsMock.appendFile).toHaveBeenCalledWith(
        expect.stringContaining("digest-history.jsonl"),
        expect.stringContaining('"timestamp"'),
        expect.anything(),
      );
    });
  });

  describe("pruneDigestHistory", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns 0 when file is missing", async () => {
      vi.mocked(fsMock.readFile).mockRejectedValueOnce(new Error("ENOENT"));
      const pruned = await pruneDigestHistory(30);
      expect(pruned).toBe(0);
    });

    it("prunes old entries beyond retention", async () => {
      const old = { timestamp: "2020-01-01T00:00:00Z" };
      const recent = { timestamp: new Date().toISOString() };
      const content = JSON.stringify(old) + "\n" + JSON.stringify(recent) + "\n";
      vi.mocked(fsMock.readFile).mockResolvedValueOnce(content);

      const pruned = await pruneDigestHistory(30);
      expect(pruned).toBe(1);
      expect(fsMock.writeFile).toHaveBeenCalled();
      expect(fsMock.rename).toHaveBeenCalled();
    });

    it("skips malformed lines and counts them as pruned", async () => {
      const valid = { timestamp: new Date().toISOString() };
      const content = "not json\n" + JSON.stringify(valid) + "\n";
      vi.mocked(fsMock.readFile).mockResolvedValueOnce(content);

      const pruned = await pruneDigestHistory(30);
      expect(pruned).toBe(1);
    });

    it("does nothing when all entries are within retention", async () => {
      const recent1 = { timestamp: new Date().toISOString() };
      const recent2 = { timestamp: new Date().toISOString() };
      const content = JSON.stringify(recent1) + "\n" + JSON.stringify(recent2) + "\n";
      vi.mocked(fsMock.readFile).mockResolvedValueOnce(content);

      const pruned = await pruneDigestHistory(30);
      expect(pruned).toBe(0);
      // Should NOT write when nothing was pruned
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
  });

  describe("writeStatusMarkdown", () => {
    beforeEach(() => vi.clearAllMocks());

    it("writes to default path", async () => {
      await writeStatusMarkdown("# Sentinel Status\nAll clear.");
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("status.md"),
        "# Sentinel Status\nAll clear.",
        expect.anything(),
      );
    });

    it("writes to custom path", async () => {
      await writeStatusMarkdown("# Custom", "/tmp/custom-status.md");
      expect(fsMock.mkdir).toHaveBeenCalled();
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        "/tmp/custom-status.md",
        "# Custom",
        expect.anything(),
      );
    });
  });

  describe("readStatusMarkdown", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns null when file is missing", async () => {
      vi.mocked(fsMock.readFile).mockRejectedValueOnce(new Error("ENOENT"));
      const content = await readStatusMarkdown();
      expect(content).toBeNull();
    });

    it("returns content when file exists", async () => {
      vi.mocked(fsMock.readFile).mockResolvedValueOnce("# Status OK");
      const content = await readStatusMarkdown();
      expect(content).toBe("# Status OK");
    });

    it("reads from custom path", async () => {
      vi.mocked(fsMock.readFile).mockResolvedValueOnce("# Custom Status");
      const content = await readStatusMarkdown("/tmp/custom.md");
      expect(content).toBe("# Custom Status");
      expect(fsMock.readFile).toHaveBeenCalledWith("/tmp/custom.md", "utf-8");
    });
  });

  describe("readDigestHistory", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns empty array when file is missing", async () => {
      vi.mocked(fsMock.readFile).mockRejectedValueOnce(new Error("ENOENT"));
      const records = await readDigestHistory();
      expect(records).toEqual([]);
    });

    it("parses JSONL and returns most recent first", async () => {
      const r1 = { timestamp: "2026-01-01T00:00:00Z" };
      const r2 = { timestamp: "2026-06-15T00:00:00Z" };
      vi.mocked(fsMock.readFile).mockResolvedValueOnce(
        JSON.stringify(r1) + "\n" + JSON.stringify(r2) + "\n",
      );

      const records = await readDigestHistory();
      expect(records).toHaveLength(2);
      expect(records[0].timestamp).toBe("2026-06-15T00:00:00Z");
      expect(records[1].timestamp).toBe("2026-01-01T00:00:00Z");
    });

    it("respects the limit parameter", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
      vi.mocked(fsMock.readFile).mockResolvedValueOnce(lines.join("\n") + "\n");

      const records = await readDigestHistory(3);
      expect(records).toHaveLength(3);
    });

    it("skips malformed lines", async () => {
      const valid = { timestamp: "2026-06-15T00:00:00Z" };
      vi.mocked(fsMock.readFile).mockResolvedValueOnce(
        "bad json\n" + JSON.stringify(valid) + "\n",
      );

      const records = await readDigestHistory();
      expect(records).toHaveLength(1);
    });
  });

  describe("SentinelStateSchema", () => {
    it("parses valid state", () => {
      const input = {
        lastTaskCheckAt: "2026-06-15T12:00:00.000Z",
        lastDigestAt: null,
        lastPromptAuditAt: null,
        consecutiveFailures: 0,
        totalTasksReviewed: 0,
        alertsSent: 0,
        enabled: true,
        modelOverride: null,
      };
      expect(() => SentinelStateSchema.parse(input)).not.toThrow();
    });
  });
});
