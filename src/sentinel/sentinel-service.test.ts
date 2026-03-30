import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock node-cron before importing SentinelService
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
  },
}));

// Mock sentinel-state I/O
vi.mock("./sentinel-state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readState: vi.fn().mockResolvedValue({
      lastTaskCheckAt: "2026-01-01T00:00:00Z",
      lastDigestAt: null,
      lastPromptAuditAt: null,
      consecutiveFailures: 0,
      totalTasksReviewed: 0,
      alertsSent: 0,
      enabled: true,
      modelOverride: null,
    }),
    writeState: vi.fn().mockResolvedValue(undefined),
    readDigestHistory: vi.fn().mockResolvedValue([]),
    appendDigestRecord: vi.fn().mockResolvedValue(undefined),
    writeStatusMarkdown: vi.fn().mockResolvedValue(undefined),
  };
});

import { SentinelService, type SentinelDependencies } from "./sentinel-service.js";
import type { SentinelConfig } from "./sentinel-state.js";

const testConfig: SentinelConfig = {
  enabled: true,
  model: "gpt-4o-mini",
  checkIntervalMinutes: 15,
  jitterMinutes: 0,
  slowTaskThresholdMinutes: 5,
  orphanTaskThresholdMinutes: 30,
  digestHour: 9,
  auditHour: 2,
  consecutiveFailureThreshold: 3,
  queueDepthThreshold: 10,
  ragQueueDepthThreshold: 100,
  persistMarkdownDigest: false,
  markdownDigestPath: null,
  digestRetentionDays: 30,
  notifyChannels: ["admin"],
  criticalCooldownMinutes: 5,
  warningCooldownMinutes: 30,
  timezone: "UTC",
  noOverlap: true,
  maxRandomDelayMs: 0,
};

function createMockDeps(): SentinelDependencies {
  const clock = () => new Date("2026-01-15T12:00:00Z");
  return {
    taskRepo: {
      listSince: vi.fn().mockReturnValue([
        { id: "t1", status: "completed", goal: "Test", createdAt: "2026-01-15T11:00:00Z", completedAt: "2026-01-15T11:05:00Z" },
        { id: "t2", status: "failed", goal: "Fail", createdAt: "2026-01-15T11:10:00Z", completedAt: "2026-01-15T11:15:00Z", error: "Boom" },
      ]),
      listByStatus: vi.fn().mockReturnValue([]),
      getRunningTasks: vi.fn().mockReturnValue([]),
      list: vi.fn().mockReturnValue([]),
      countQueued: vi.fn().mockReturnValue(0),
    } as never,
    copilot: {
      chat: vi.fn().mockResolvedValue("Audit result"),
    } as never,
    sessionManager: {
      listSessions: vi.fn().mockReturnValue([]),
    } as never,
    config: { ...testConfig },
    clock,
    io: { emit: vi.fn() },
  };
}

describe("SentinelService", () => {
  let sentinel: SentinelService;
  let deps: SentinelDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    sentinel = new SentinelService(deps);
  });

  describe("constructor", () => {
    it("creates an instance with correct initial state", () => {
      expect(sentinel).toBeInstanceOf(SentinelService);
      expect(sentinel.isRunning).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("returns status with enabled=false when not started", () => {
      const status = sentinel.getStatus();
      expect(status.enabled).toBe(false);
      expect(status.totalTasksReviewed).toBe(0);
      expect(status.alertsSent).toBe(0);
      expect(status.config).toMatchObject({ checkIntervalMinutes: 15 });
    });
  });

  describe("start/stop", () => {
    it("sets running to true after start", async () => {
      await sentinel.start();
      expect(sentinel.isRunning).toBe(true);
    });

    it("is idempotent when already running", async () => {
      await sentinel.start();
      await sentinel.start(); // no-op
      expect(sentinel.isRunning).toBe(true);
    });

    it("sets running to false after stop", async () => {
      await sentinel.start();
      await sentinel.stop();
      expect(sentinel.isRunning).toBe(false);
    });

    it("stop is idempotent when not running", async () => {
      await sentinel.stop(); // no-op
      expect(sentinel.isRunning).toBe(false);
    });
  });

  describe("runCheck", () => {
    it("returns task review result", async () => {
      await sentinel.start();
      const result = await sentinel.runCheck();
      expect(result).toBeDefined();
      expect(typeof result.totalTasks).toBe("number");
      expect(typeof result.successRate).toBe("number");
    });

    it("emits check:complete event", async () => {
      await sentinel.start();
      const handler = vi.fn();
      sentinel.on("check:complete", handler);
      await sentinel.runCheck();
      expect(handler).toHaveBeenCalledOnce();
    });

    it("emits Socket.IO event via io.emit", async () => {
      await sentinel.start();
      await sentinel.runCheck();
      expect(deps.io!.emit).toHaveBeenCalledWith("sentinel:check-complete", expect.objectContaining({
        timestamp: expect.any(String),
      }));
    });
  });

  describe("toggle", () => {
    it("starts when toggling to enabled", async () => {
      await sentinel.toggle(true);
      expect(sentinel.isRunning).toBe(true);
    });

    it("stops when toggling to disabled", async () => {
      await sentinel.start();
      await sentinel.toggle(false);
      expect(sentinel.isRunning).toBe(false);
    });
  });

  describe("updateConfig", () => {
    it("updates config without restart when non-scheduling field changes", async () => {
      await sentinel.start();
      await sentinel.updateConfig({ consecutiveFailureThreshold: 5 });
      const status = sentinel.getStatus();
      expect(status.config.consecutiveFailureThreshold).toBe(5);
      expect(sentinel.isRunning).toBe(true);
    });

    it("restarts when scheduling field changes", async () => {
      await sentinel.start();
      await sentinel.updateConfig({ checkIntervalMinutes: 30 });
      expect(sentinel.isRunning).toBe(true);
      const status = sentinel.getStatus();
      expect(status.config.checkIntervalMinutes).toBe(30);
    });

    it("sets modelOverride when model is provided", async () => {
      await sentinel.updateConfig({ model: "claude-sonnet-4" });
      const status = sentinel.getStatus();
      expect(status.modelOverride).toBe("claude-sonnet-4");
    });
  });

  describe("setIO", () => {
    it("injects IO instance", () => {
      const io = { emit: vi.fn() };
      sentinel.setIO(io);
      // No error means success — IO is used in runCheck
    });
  });

  describe("getDigestHistory", () => {
    it("returns digest history from disk", async () => {
      const history = await sentinel.getDigestHistory();
      expect(Array.isArray(history)).toBe(true);
    });
  });

  // ── NEW: Additional coverage ────────────────────────────────────

  describe("runCheck — state updates", () => {
    it("updates state counters after check", async () => {
      await sentinel.start();
      const statusBefore = sentinel.getStatus();
      const prevTotal = statusBefore.totalTasksReviewed;
      const result = await sentinel.runCheck();
      const status = sentinel.getStatus();
      expect(status.totalTasksReviewed).toBe(prevTotal + result.totalTasks);
      expect(status.lastTaskCheckAt).toBeDefined();
    });
  });

  describe("getStatus — nextCheckEstimate", () => {
    it("has nextCheckEstimate when running", async () => {
      await sentinel.start();
      const status = sentinel.getStatus();
      expect(status.nextCheckEstimate).toBeDefined();
      expect(status.enabled).toBe(true);
    });

    it("has no nextCheckEstimate when not running", () => {
      const status = sentinel.getStatus();
      expect(status.nextCheckEstimate).toBeNull();
    });
  });

  describe("runPromptAudit", () => {
    it("runs prompt audit and updates state", async () => {
      await sentinel.start();
      const result = await sentinel.runPromptAudit();
      expect(result).toBeDefined();
      expect(typeof result.sampledCount).toBe("number");
      const status = sentinel.getStatus();
      expect(status.lastPromptAuditAt).toBeDefined();
    });
  });

  describe("generateDigest", () => {
    it("generates digest and emits event", async () => {
      await sentinel.start();
      const digestHandler = vi.fn();
      sentinel.on("digest:generated", digestHandler);
      const digest = await sentinel.generateDigest();
      expect(digest).toBeDefined();
      expect(digestHandler).toHaveBeenCalled();
      const status = sentinel.getStatus();
      expect(status.lastDigestAt).toBeDefined();
    });

    it("emits socket.io digest event", async () => {
      await sentinel.start();
      await sentinel.generateDigest();
      expect(deps.io!.emit).toHaveBeenCalledWith("sentinel:digest", expect.anything());
    });
  });

  describe("updateConfig — notifyChannels", () => {
    it("updates notify channels", async () => {
      await sentinel.updateConfig({ notifyChannels: ["admin", "telegram"] });
      const status = sentinel.getStatus();
      expect(status.config.notifyChannels).toEqual(["admin", "telegram"]);
    });

    it("updates cooldowns", async () => {
      await sentinel.updateConfig({ criticalCooldownMinutes: 10, warningCooldownMinutes: 60 });
      const status = sentinel.getStatus();
      expect(status.config.criticalCooldownMinutes).toBe(10);
      expect(status.config.warningCooldownMinutes).toBe(60);
    });
  });

  describe("toggle — idempotent", () => {
    it("toggling on when already running is safe", async () => {
      await sentinel.start();
      await sentinel.toggle(true);
      expect(sentinel.isRunning).toBe(true);
    });

    it("toggling off when already stopped is safe", async () => {
      await sentinel.toggle(false);
      expect(sentinel.isRunning).toBe(false);
    });
  });

  describe("updateConfig — scheduling restarts", () => {
    it("restarts when digestHour changes", async () => {
      await sentinel.start();
      await sentinel.updateConfig({ digestHour: 10 });
      expect(sentinel.isRunning).toBe(true);
      expect(sentinel.getStatus().config.digestHour).toBe(10);
    });

    it("restarts when auditHour changes", async () => {
      await sentinel.start();
      await sentinel.updateConfig({ auditHour: 5 });
      expect(sentinel.isRunning).toBe(true);
      expect(sentinel.getStatus().config.auditHour).toBe(5);
    });

    it("restarts when timezone changes", async () => {
      await sentinel.start();
      await sentinel.updateConfig({ timezone: "America/New_York" });
      expect(sentinel.isRunning).toBe(true);
      expect(sentinel.getStatus().config.timezone).toBe("America/New_York");
    });

    it("restarts when jitterMinutes changes", async () => {
      await sentinel.start();
      await sentinel.updateConfig({ jitterMinutes: 5 });
      expect(sentinel.isRunning).toBe(true);
    });
  });

  describe("start with native jitter", () => {
    it("starts with maxRandomDelayMs > 0", async () => {
      deps = createMockDeps();
      deps.config = { ...testConfig, maxRandomDelayMs: 5000 };
      sentinel = new SentinelService(deps);
      await sentinel.start();
      expect(sentinel.isRunning).toBe(true);
      await sentinel.stop();
    });
  });

  describe("RAG health check integration", () => {
    it("runs RAG health check during runCheck when knowledgeService provided", async () => {
      deps = createMockDeps();
      deps.knowledgeService = {
        getStats: vi.fn().mockResolvedValue({
          totalDocuments: 10,
          totalChunks: 100,
          pendingDocuments: 2,
          lastIndexedAt: "2026-01-15T11:00:00Z",
        }),
        get isRunning() { return true; },
        restart: vi.fn(),
      };
      sentinel = new SentinelService(deps);
      await sentinel.start();
      const result = await sentinel.runCheck();
      expect(result).toBeDefined();
      // No RAG alerts for healthy service
      const ragAlerts = result.alerts.filter((a) =>
        ["rag-db-unreachable", "rag-ingestion-down", "rag-queue-depth"].includes(a.type)
      );
      expect(ragAlerts).toHaveLength(0);
    });

    it("includes RAG alerts when knowledge DB is unreachable", async () => {
      deps = createMockDeps();
      deps.knowledgeService = {
        getStats: vi.fn().mockRejectedValue(new Error("DB failed")),
        get isRunning() { return false; },
        restart: vi.fn(),
      };
      sentinel = new SentinelService(deps);
      await sentinel.start();
      const result = await sentinel.runCheck();
      const ragAlerts = result.alerts.filter((a) => a.type === "rag-db-unreachable");
      expect(ragAlerts).toHaveLength(1);
      expect(ragAlerts[0].priority).toBe("critical");
    });

    it("works without knowledgeService (no RAG alerts)", async () => {
      deps = createMockDeps();
      // knowledgeService not set
      sentinel = new SentinelService(deps);
      await sentinel.start();
      const result = await sentinel.runCheck();
      const ragAlerts = result.alerts.filter((a) =>
        a.type.startsWith("rag-")
      );
      expect(ragAlerts).toHaveLength(0);
    });
  });
});
