import { describe, expect, it, vi } from "vitest";
import { RAGHealthCheck, type KnowledgeServiceLike } from "./rag-health-check.js";

const clock = () => new Date("2026-03-30T12:00:00Z");

function createMockKnowledgeService(overrides: Partial<{
  stats: Awaited<ReturnType<KnowledgeServiceLike["getStats"]>>;
  isRunning: boolean;
  statsThrows: boolean;
  restartThrows: boolean;
}> = {}): KnowledgeServiceLike {
  const stats = overrides.stats ?? {
    totalDocuments: 50,
    totalChunks: 500,
    pendingDocuments: 2,
    lastIndexedAt: "2026-03-30T11:00:00Z",
  };
  return {
    getStats: overrides.statsThrows
      ? vi.fn().mockRejectedValue(new Error("LanceDB connection failed"))
      : vi.fn().mockResolvedValue(stats),
    get isRunning() { return overrides.isRunning ?? true; },
    restart: overrides.restartThrows
      ? vi.fn().mockRejectedValue(new Error("restart failed"))
      : vi.fn().mockResolvedValue(undefined),
  };
}

describe("RAGHealthCheck", () => {
  describe("knowledge service not available", () => {
    it("returns unavailable status with no alerts", async () => {
      const check = new RAGHealthCheck({
        knowledgeService: null,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.status.available).toBe(false);
      expect(result.alerts).toHaveLength(0);
      expect(result.status.dbAccessible).toBe(false);
      expect(result.status.totalDocuments).toBe(0);
    });

    it("handles undefined knowledgeService", async () => {
      const check = new RAGHealthCheck({
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.status.available).toBe(false);
    });
  });

  describe("healthy state", () => {
    it("returns healthy status with no alerts", async () => {
      const svc = createMockKnowledgeService();
      const check = new RAGHealthCheck({
        knowledgeService: svc,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.status.available).toBe(true);
      expect(result.status.dbAccessible).toBe(true);
      expect(result.status.ingestionRunning).toBe(true);
      expect(result.status.totalDocuments).toBe(50);
      expect(result.status.totalChunks).toBe(500);
      expect(result.status.pendingDocuments).toBe(2);
      expect(result.status.lastIndexedAt).toBe("2026-03-30T11:00:00Z");
      expect(result.alerts).toHaveLength(0);
      expect(result.status.alerts).toHaveLength(0);
    });
  });

  describe("DB unreachable", () => {
    it("emits critical rag-db-unreachable alert", async () => {
      const svc = createMockKnowledgeService({ statsThrows: true });
      const check = new RAGHealthCheck({
        knowledgeService: svc,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.status.available).toBe(false);
      expect(result.status.dbAccessible).toBe(false);
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].type).toBe("rag-db-unreachable");
      expect(result.alerts[0].priority).toBe("critical");
      expect(result.status.alerts[0].type).toBe("rag-db-unreachable");
    });
  });

  describe("ingestion stopped", () => {
    it("emits warning and attempts restart", async () => {
      const svc = createMockKnowledgeService({ isRunning: false });
      const check = new RAGHealthCheck({
        knowledgeService: svc,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.status.available).toBe(true);
      expect(result.status.ingestionRunning).toBe(false);
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].type).toBe("rag-ingestion-down");
      expect(result.alerts[0].priority).toBe("warning");
      expect(svc.restart).toHaveBeenCalledOnce();
    });
  });

  describe("restart failure", () => {
    it("logs error but does not crash", async () => {
      const svc = createMockKnowledgeService({ isRunning: false, restartThrows: true });
      const check = new RAGHealthCheck({
        knowledgeService: svc,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.status.available).toBe(true);
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].type).toBe("rag-ingestion-down");
      // Should not throw
    });
  });

  describe("high queue depth", () => {
    it("emits warning when pending exceeds threshold", async () => {
      const svc = createMockKnowledgeService({
        stats: {
          totalDocuments: 50,
          totalChunks: 500,
          pendingDocuments: 150,
          lastIndexedAt: "2026-03-30T11:00:00Z",
        },
      });
      const check = new RAGHealthCheck({
        knowledgeService: svc,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].type).toBe("rag-queue-depth");
      expect(result.alerts[0].priority).toBe("warning");
      expect(result.alerts[0].data).toMatchObject({ pending: 150, threshold: 100 });
    });

    it("does not alert when pending is at threshold", async () => {
      const svc = createMockKnowledgeService({
        stats: {
          totalDocuments: 50,
          totalChunks: 500,
          pendingDocuments: 100,
          lastIndexedAt: "2026-03-30T11:00:00Z",
        },
      });
      const check = new RAGHealthCheck({
        knowledgeService: svc,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.alerts).toHaveLength(0);
    });
  });

  describe("multiple issues", () => {
    it("reports both ingestion-down and queue-depth", async () => {
      const svc = createMockKnowledgeService({
        isRunning: false,
        stats: {
          totalDocuments: 50,
          totalChunks: 500,
          pendingDocuments: 200,
          lastIndexedAt: null,
        },
      });
      const check = new RAGHealthCheck({
        knowledgeService: svc,
        config: { ragQueueDepthThreshold: 100 },
        clock,
      });
      const result = await check.check();
      expect(result.alerts).toHaveLength(2);
      const types = result.alerts.map((a) => a.type);
      expect(types).toContain("rag-ingestion-down");
      expect(types).toContain("rag-queue-depth");
    });
  });
});
