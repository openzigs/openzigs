import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { TaskRepository } from "./task-repository.js";
import { TaskEngine } from "./task-engine.js";
import { TASK_LIMITS } from "./types.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

describe("TaskEngine", () => {
  let db: Database.Database;
  let repo: TaskRepository;
  let engine: TaskEngine;
  let now: Date;

  beforeEach(() => {
    db = createTestDb();
    now = new Date("2026-02-09T12:00:00Z");
    repo = new TaskRepository(db, () => now);
    repo.migrate();
    engine = new TaskEngine({ repository: repo, clock: () => now });
  });

  describe("submit", () => {
    it("creates an immediate task in running state", () => {
      const task = engine.submit(
        { trigger: "chat", goal: "Hello" },
        { mode: "immediate" }
      );

      expect(task.status).toBe("running");
      expect(task.startedAt).toEqual(now);
    });

    it("creates a background task in queued state", () => {
      const task = engine.submit(
        { trigger: "cron", goal: "Daily digest" },
        { mode: "background" }
      );

      expect(task.status).toBe("queued");
      expect(task.startedAt).toBeNull();
    });

    it("emits task:running for immediate tasks", () => {
      const handler = vi.fn();
      engine.on("task:running", handler);

      engine.submit({ trigger: "chat", goal: "X" }, { mode: "immediate" });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].status).toBe("running");
    });

    it("emits task:queued for background tasks", () => {
      const handler = vi.fn();
      engine.on("task:queued", handler);

      engine.submit({ trigger: "cron", goal: "Y" }, { mode: "background" });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].status).toBe("queued");
    });

    it("enforces session rate limit", () => {
      for (let i = 0; i < TASK_LIMITS.maxRatePerMinute; i++) {
        engine.submit(
          { trigger: "chat", goal: `Task ${i}`, sessionId: "s1" },
          { mode: "background" }
        );
      }

      expect(() =>
        engine.submit(
          { trigger: "chat", goal: "One too many", sessionId: "s1" },
          { mode: "background" }
        )
      ).toThrow("Rate limit");
    });

    it("does not rate-limit tasks without a session", () => {
      // Should not throw even with many tasks
      for (let i = 0; i < 25; i++) {
        engine.submit({ trigger: "cron", goal: `Task ${i}` }, { mode: "background" });
      }
    });

    it("applies backgroundTaskDefaultModel to non-chat tasks without model", () => {
      const engineWithDefault = new TaskEngine({
        repository: repo,
        clock: () => now,
        backgroundTaskDefaultModel: "gpt-4.1-mini",
      });

      const task = engineWithDefault.submit(
        { trigger: "cron", goal: "Background task" },
        { mode: "background" }
      );

      expect(task.model).toBe("gpt-4.1-mini");
    });

    it("does not override explicit model for non-chat tasks", () => {
      const engineWithDefault = new TaskEngine({
        repository: repo,
        clock: () => now,
        backgroundTaskDefaultModel: "gpt-4.1-mini",
      });

      const task = engineWithDefault.submit(
        { trigger: "cron", goal: "Explicit model", model: "gpt-4.1" },
        { mode: "background" }
      );

      expect(task.model).toBe("gpt-4.1");
    });

    it("does not apply backgroundTaskDefaultModel to chat-triggered tasks", () => {
      const engineWithDefault = new TaskEngine({
        repository: repo,
        clock: () => now,
        backgroundTaskDefaultModel: "gpt-4.1-mini",
      });

      const task = engineWithDefault.submit(
        { trigger: "chat", goal: "Interactive task" },
        { mode: "immediate" }
      );

      expect(task.model).toBeNull();
    });
  });

  describe("backgroundTaskDefaultModel", () => {
    it("getter returns configured default", () => {
      const engineWithDefault = new TaskEngine({
        repository: repo,
        clock: () => now,
        backgroundTaskDefaultModel: "gpt-4.1-nano",
      });

      expect(engineWithDefault.getBackgroundTaskDefaultModel()).toBe("gpt-4.1-nano");
    });

    it("setter updates default at runtime", () => {
      expect(engine.getBackgroundTaskDefaultModel()).toBeUndefined();

      engine.setBackgroundTaskDefaultModel("gpt-4.1-mini");
      expect(engine.getBackgroundTaskDefaultModel()).toBe("gpt-4.1-mini");

      // Verify it applies to new tasks
      const task = engine.submit(
        { trigger: "cron", goal: "After setter" },
        { mode: "background" }
      );
      expect(task.model).toBe("gpt-4.1-mini");
    });

    it("setter clears default when called with undefined", () => {
      engine.setBackgroundTaskDefaultModel("gpt-4.1-mini");
      engine.setBackgroundTaskDefaultModel(undefined);

      expect(engine.getBackgroundTaskDefaultModel()).toBeUndefined();

      const task = engine.submit(
        { trigger: "cron", goal: "No default" },
        { mode: "background" }
      );
      expect(task.model).toBeNull();
    });
  });

  describe("complete", () => {
    it("marks task completed and emits event", () => {
      const handler = vi.fn();
      engine.on("task:completed", handler);

      const task = engine.submit({ trigger: "chat", goal: "X" }, { mode: "immediate" });
      const completed = engine.complete(task.id, "Result here");

      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("Result here");
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("fail", () => {
    it("marks task failed and emits event", () => {
      const handler = vi.fn();
      engine.on("task:failed", handler);

      const task = engine.submit({ trigger: "chat", goal: "X" }, { mode: "immediate" });
      const failed = engine.fail(task.id, "Boom");

      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("Boom");
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("cancel", () => {
    it("cancels a queued task and emits event", () => {
      const handler = vi.fn();
      engine.on("task:cancelled", handler);

      const task = engine.submit({ trigger: "cron", goal: "X" }, { mode: "background" });
      const cancelled = engine.cancel(task.id);

      expect(cancelled).not.toBeNull();
      expect(cancelled!.status).toBe("cancelled");
      expect(handler).toHaveBeenCalledOnce();
    });

    it("returns null for already-completed task", () => {
      const task = engine.submit({ trigger: "chat", goal: "X" }, { mode: "immediate" });
      engine.complete(task.id, "done");

      expect(engine.cancel(task.id)).toBeNull();
    });
  });

  describe("dequeue", () => {
    it("dequeues the oldest background task", () => {
      engine.submit({ trigger: "cron", goal: "First" }, { mode: "background" });
      now = new Date("2026-02-09T12:01:00Z");
      engine.submit({ trigger: "cron", goal: "Second" }, { mode: "background" });

      const task = engine.dequeue();
      expect(task).not.toBeNull();
      expect(task!.goal).toBe("First");
      expect(task!.status).toBe("running");
    });

    it("emits task:running on dequeue", () => {
      const handler = vi.fn();
      engine.on("task:running", handler);

      engine.submit({ trigger: "cron", goal: "X" }, { mode: "background" });
      engine.dequeue();

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("getStats", () => {
    it("returns queue counts", () => {
      engine.submit({ trigger: "cron", goal: "A" }, { mode: "background" });
      engine.submit({ trigger: "cron", goal: "B" }, { mode: "background" });
      engine.dequeue();

      const stats = engine.getStats();
      expect(stats.queued).toBe(1);
      expect(stats.running).toBe(1);
    });
  });

  describe("listTasks / getTask / getChildren", () => {
    it("lists by status", () => {
      engine.submit({ trigger: "chat", goal: "A" }, { mode: "background" });
      const b = engine.submit({ trigger: "chat", goal: "B" }, { mode: "immediate" });
      engine.complete(b.id, "done");

      expect(engine.listTasks({ status: "queued" })).toHaveLength(1);
      expect(engine.listTasks({ status: "completed" })).toHaveLength(1);
    });

    it("getTask returns task by id", () => {
      const task = engine.submit({ trigger: "chat", goal: "X" }, { mode: "background" });
      expect(engine.getTask(task.id)?.goal).toBe("X");
      expect(engine.getTask("nope")).toBeNull();
    });

    it("getChildren returns child tasks", () => {
      const parent = engine.submit({ trigger: "chat", goal: "P" }, { mode: "immediate" });
      engine.submit(
        { trigger: "agent", goal: "C", parentTaskId: parent.id },
        { mode: "background" }
      );

      const children = engine.getChildren(parent.id);
      expect(children).toHaveLength(1);
      expect(children[0].goal).toBe("C");
    });
  });
});
