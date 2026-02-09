import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { TaskRepository } from "./task-repository.js";
import { TaskEngine } from "./task-engine.js";
import { TaskWorker } from "./task-worker.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

/**
 * Integration tests that exercise the full task lifecycle:
 * TaskEngine → TaskWorker → NotificationDispatcher
 *
 * Uses an in-memory SQLite database and a mock CopilotWrapper.
 */

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new TaskRepository(db);
  repo.migrate();
  return { db, repo };
};

const createMockCopilot = (response = "Task completed successfully") => {
  return {
    chat: vi.fn(async function* (_prompt: string, _opts?: unknown) {
      yield response;
    }),
  } as unknown as CopilotWrapper;
};

const createMockChannelManager = () => ({
  getChannel: vi.fn().mockReturnValue({
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }),
});

const createMockSessionManager = () => ({
  appendEvent: vi.fn().mockResolvedValue(undefined),
});

const createMockIo = () => ({
  emit: vi.fn(),
});

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Task System Integration", () => {
  let repo: TaskRepository;
  let engine: TaskEngine;

  beforeEach(() => {
    const created = createTestDb();
    repo = created.repo;
    engine = new TaskEngine({ repository: repo });
  });

  describe("Full lifecycle: submit → worker → complete → notify", () => {
    it("should process a background task end-to-end", async () => {
      const copilot = createMockCopilot("Research results here");
      const io = createMockIo();
      const channelManager = createMockChannelManager();
      const sessionManager = createMockSessionManager();

      // Wire up the full system
      const worker = new TaskWorker({
        engine,
        copilot,
        pollIntervalMs: 50,
        log: silentLog,
      });

      // NotificationDispatcher registers event listeners as a side-effect
      new NotificationDispatcher({
        engine,
        channelManager: channelManager as never,
        sessionManager: sessionManager as never,
        io,
        log: silentLog,
      });

      // Submit a background task
      const task = engine.submit(
        {
          trigger: "agent",
          goal: "Research quantum computing trends",
          context: "Focus on 2024 breakthroughs",
          notifyOnComplete: true,
        },
        { mode: "background" }
      );

      expect(task.status).toBe("queued");

      // Start worker and wait for processing
      worker.start();
      await waitFor(200);
      await worker.stop();

      // Verify task was completed
      const completed = engine.getTask(task.id);
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe("completed");
      expect(completed!.result).toBe("Research results here");

      // Verify copilot was called
      expect(copilot.chat).toHaveBeenCalledOnce();

      // Verify notification was emitted via Socket.IO
      expect(io.emit).toHaveBeenCalledWith(
        "task:notification",
        expect.objectContaining({
          type: "completed",
          task: expect.objectContaining({
            id: task.id,
            status: "completed",
            goal: "Research quantum computing trends",
            result: "Research results here",
          }),
        })
      );
    });

    it("should handle task failure and notify", async () => {
      const copilot = {
        chat: vi.fn(async function* () {
          yield ""; // eslint requires yield in generators
          throw new Error("Model unavailable");
        }),
      } as unknown as CopilotWrapper;

      const io = createMockIo();

      const worker = new TaskWorker({
        engine,
        copilot,
        pollIntervalMs: 50,
        log: silentLog,
      });

      // NotificationDispatcher registers event listeners as a side-effect
      new NotificationDispatcher({
        engine,
        channelManager: createMockChannelManager() as never,
        sessionManager: createMockSessionManager() as never,
        io,
        log: silentLog,
      });

      const task = engine.submit(
        { trigger: "agent", goal: "Failing task", notifyOnComplete: true },
        { mode: "background" }
      );

      worker.start();
      await waitFor(200);
      await worker.stop();

      const failed = engine.getTask(task.id);
      expect(failed!.status).toBe("failed");
      expect(failed!.error).toContain("Model unavailable");

      expect(io.emit).toHaveBeenCalledWith(
        "task:notification",
        expect.objectContaining({
          type: "failed",
          task: expect.objectContaining({
            id: task.id,
            status: "failed",
          }),
        })
      );
    });
  });

  describe("Recursive task chaining (parent → child)", () => {
    it("should create parent and child tasks with depth tracking", () => {
      const parent = engine.submit(
        { trigger: "chat", goal: "Parent research task" },
        { mode: "immediate" }
      );

      expect(parent.depth).toBe(0);

      const child = engine.submit(
        {
          trigger: "agent",
          goal: "Sub-research: topic A",
          parentTaskId: parent.id,
          spawnedBy: parent.id,
        },
        { mode: "background" }
      );

      expect(child.depth).toBe(1);
      expect(child.parentTaskId).toBe(parent.id);

      const grandchild = engine.submit(
        {
          trigger: "agent",
          goal: "Deep sub-research",
          parentTaskId: child.id,
          spawnedBy: child.id,
        },
        { mode: "background" }
      );

      expect(grandchild.depth).toBe(2);

      // Verify parent-child relationships
      const children = engine.getChildren(parent.id);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(child.id);

      const grandchildren = engine.getChildren(child.id);
      expect(grandchildren).toHaveLength(1);
      expect(grandchildren[0].id).toBe(grandchild.id);
    });

    it("should enforce max depth limit", () => {
      // Create a chain up to maxDepth (depths 0 through maxDepth)
      let currentParentId: string | undefined;
      for (let i = 0; i <= 5; i++) {
        const task = engine.submit(
          {
            trigger: "agent",
            goal: `Depth ${i} task`,
            parentTaskId: currentParentId,
          },
          { mode: "background" }
        );
        currentParentId = task.id;
      }

      // The next level (depth 6, which is > maxDepth=5) should fail
      expect(() =>
        engine.submit(
          {
            trigger: "agent",
            goal: "Too deep",
            parentTaskId: currentParentId,
          },
          { mode: "background" }
        )
      ).toThrow(/depth/i);
    });

    it("should enforce max children limit", () => {
      const parent = engine.submit(
        { trigger: "chat", goal: "Parent with many children" },
        { mode: "immediate" }
      );

      // Create maxChildren (10) children
      for (let i = 0; i < 10; i++) {
        engine.submit(
          { trigger: "agent", goal: `Child ${i}`, parentTaskId: parent.id },
          { mode: "background" }
        );
      }

      // 11th child should fail
      expect(() =>
        engine.submit(
          { trigger: "agent", goal: "Too many children", parentTaskId: parent.id },
          { mode: "background" }
        )
      ).toThrow(/children/i);
    });

    it("should process recursive tasks via worker", async () => {
      const copilot = createMockCopilot("done");
      const worker = new TaskWorker({
        engine,
        copilot,
        pollIntervalMs: 50,
        log: silentLog,
      });

      // Create a parent with two children
      const parent = engine.submit(
        { trigger: "chat", goal: "Parent" },
        { mode: "immediate" }
      );
      engine.complete(parent.id, "Parent done");

      engine.submit(
        { trigger: "agent", goal: "Child A", parentTaskId: parent.id },
        { mode: "background" }
      );
      engine.submit(
        { trigger: "agent", goal: "Child B", parentTaskId: parent.id },
        { mode: "background" }
      );

      worker.start();
      await waitFor(300);
      await worker.stop();

      // Both children should be completed
      const children = engine.getChildren(parent.id);
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child.status).toBe("completed");
      }
    });
  });

  describe("Rate limiting", () => {
    it("should enforce per-session rate limit", () => {
      const sessionId = "rate-test-session";

      // Fill up the rate limit
      for (let i = 0; i < 20; i++) {
        engine.submit(
          { trigger: "chat", goal: `Task ${i}`, sessionId },
          { mode: "immediate" }
        );
      }

      // 21st should fail
      expect(() =>
        engine.submit(
          { trigger: "chat", goal: "Over limit", sessionId },
          { mode: "immediate" }
        )
      ).toThrow(/rate limit/i);
    });
  });

  describe("Task cancellation", () => {
    it("should cancel a queued task", () => {
      const task = engine.submit(
        { trigger: "agent", goal: "Cancel me" },
        { mode: "background" }
      );

      const cancelled = engine.cancel(task.id);
      expect(cancelled).not.toBeNull();
      expect(cancelled!.status).toBe("cancelled");
    });

    it("should not cancel a completed task", () => {
      const task = engine.submit(
        { trigger: "chat", goal: "Already done" },
        { mode: "immediate" }
      );
      engine.complete(task.id, "done");

      const result = engine.cancel(task.id);
      expect(result).toBeNull();
    });
  });

  describe("Stats and queries", () => {
    it("should return accurate queue stats", () => {
      engine.submit({ trigger: "agent", goal: "Q1" }, { mode: "background" });
      engine.submit({ trigger: "agent", goal: "Q2" }, { mode: "background" });
      engine.submit({ trigger: "chat", goal: "R1" }, { mode: "immediate" });

      const stats = engine.getStats();
      expect(stats.queued).toBe(2);
      expect(stats.running).toBe(1);
    });

    it("should filter tasks by status", () => {
      engine.submit({ trigger: "agent", goal: "Q" }, { mode: "background" });
      const r = engine.submit({ trigger: "chat", goal: "R" }, { mode: "immediate" });
      engine.complete(r.id, "done");

      const queued = engine.listTasks({ status: "queued" });
      expect(queued).toHaveLength(1);

      const completed = engine.listTasks({ status: "completed" });
      expect(completed).toHaveLength(1);
    });
  });
});
