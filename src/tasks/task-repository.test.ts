import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { TaskRepository } from "./task-repository.js";
import { TASK_LIMITS } from "./types.js";
import type { AgentTask } from "./types.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

describe("TaskRepository", () => {
  let db: Database.Database;
  let repo: TaskRepository;
  let now: Date;

  beforeEach(() => {
    db = createTestDb();
    now = new Date("2026-02-09T12:00:00Z");
    repo = new TaskRepository(db, () => now);
    repo.migrate();
  });

  describe("migrate", () => {
    it("creates agent_tasks table idempotently", () => {
      // Second call should not throw
      repo.migrate();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tasks'")
        .all();
      expect(tables).toHaveLength(1);
    });
  });

  describe("insert", () => {
    it("creates a queued task with defaults", () => {
      const task = repo.insert({
        trigger: "chat",
        goal: "Summarize the report",
      });

      expect(task.id).toBeTruthy();
      expect(task.trigger).toBe("chat");
      expect(task.status).toBe("queued");
      expect(task.goal).toBe("Summarize the report");
      expect(task.context).toBe("");
      expect(task.parentTaskId).toBeNull();
      expect(task.depth).toBe(0);
      expect(task.notifyOnComplete).toBe(false);
      expect(task.createdAt).toEqual(now);
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
    });

    it("sets optional fields", () => {
      const task = repo.insert({
        trigger: "cron",
        goal: "Daily digest",
        context: "Extra context here",
        sessionId: "session-1",
        channelType: "telegram",
        chatId: "chat-42",
        model: "gpt-4.1",
        notifyOnComplete: true,
        spawnedBy: "job-123",
      });

      expect(task.trigger).toBe("cron");
      expect(task.context).toBe("Extra context here");
      expect(task.sessionId).toBe("session-1");
      expect(task.channelType).toBe("telegram");
      expect(task.chatId).toBe("chat-42");
      expect(task.model).toBe("gpt-4.1");
      expect(task.notifyOnComplete).toBe(true);
      expect(task.spawnedBy).toBe("job-123");
    });

    it("sets depth from parent", () => {
      const parent = repo.insert({ trigger: "chat", goal: "Parent" });
      const child = repo.insert({
        trigger: "agent",
        goal: "Child",
        parentTaskId: parent.id,
      });

      expect(child.depth).toBe(1);
      expect(child.parentTaskId).toBe(parent.id);
    });

    it("rejects unknown parent", () => {
      expect(() =>
        repo.insert({ trigger: "agent", goal: "Orphan", parentTaskId: "does-not-exist" })
      ).toThrow("Parent task not found");
    });

    it("enforces max depth", () => {
      let parentId: string | undefined;
      for (let i = 0; i <= TASK_LIMITS.maxDepth; i++) {
        const task = repo.insert({
          trigger: "agent",
          goal: `Depth ${i}`,
          parentTaskId: parentId,
        });
        parentId = task.id;
      }

      expect(() =>
        repo.insert({ trigger: "agent", goal: "Too deep", parentTaskId: parentId })
      ).toThrow("Maximum task depth");
    });

    it("enforces max children", () => {
      const parent = repo.insert({ trigger: "chat", goal: "Parent" });
      for (let i = 0; i < TASK_LIMITS.maxChildren; i++) {
        repo.insert({ trigger: "agent", goal: `Child ${i}`, parentTaskId: parent.id });
      }

      expect(() =>
        repo.insert({ trigger: "agent", goal: "One too many", parentTaskId: parent.id })
      ).toThrow(`already has ${TASK_LIMITS.maxChildren} children`);
    });
  });

  describe("getById", () => {
    it("returns null for missing ID", () => {
      expect(repo.getById("nope")).toBeNull();
    });

    it("round-trips a task", () => {
      const inserted = repo.insert({ trigger: "chat", goal: "Test" });
      const fetched = repo.getById(inserted.id);
      expect(fetched).toEqual(inserted);
    });
  });

  describe("list", () => {
    it("lists all tasks newest first", () => {
      repo.insert({ trigger: "chat", goal: "First" });
      now = new Date("2026-02-09T12:01:00Z");
      repo.insert({ trigger: "cron", goal: "Second" });

      const all = repo.list();
      expect(all).toHaveLength(2);
      expect(all[0].goal).toBe("Second");
      expect(all[1].goal).toBe("First");
    });

    it("filters by status", () => {
      const task = repo.insert({ trigger: "chat", goal: "A" });
      repo.insert({ trigger: "chat", goal: "B" });
      repo.markCompleted(task.id, "done");

      const completed = repo.list({ status: "completed" });
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe(task.id);
    });

    it("filters by parent", () => {
      const parent = repo.insert({ trigger: "chat", goal: "Parent" });
      repo.insert({ trigger: "agent", goal: "Child", parentTaskId: parent.id });
      repo.insert({ trigger: "chat", goal: "Unrelated" });

      const children = repo.list({ parentTaskId: parent.id });
      expect(children).toHaveLength(1);
      expect(children[0].goal).toBe("Child");
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        repo.insert({ trigger: "chat", goal: `Task ${i}` });
      }
      const limited = repo.list({ limit: 2 });
      expect(limited).toHaveLength(2);
    });
  });

  describe("dequeue", () => {
    it("returns null when queue is empty", () => {
      expect(repo.dequeue()).toBeNull();
    });

    it("claims the oldest queued task", () => {
      const first = repo.insert({ trigger: "chat", goal: "First" });
      now = new Date("2026-02-09T12:01:00Z");
      repo.insert({ trigger: "chat", goal: "Second" });

      const claimed = repo.dequeue();
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(first.id);
      expect(claimed!.status).toBe("running");
      expect(claimed!.startedAt).toEqual(now);
    });

    it("skips already-running tasks", () => {
      repo.insert({ trigger: "chat", goal: "A" });
      repo.dequeue(); // claims A

      now = new Date("2026-02-09T12:01:00Z");
      const second = repo.insert({ trigger: "chat", goal: "B" });

      const claimed = repo.dequeue();
      expect(claimed!.id).toBe(second.id);
    });
  });

  describe("lifecycle transitions", () => {
    let task: AgentTask;

    beforeEach(() => {
      task = repo.insert({ trigger: "chat", goal: "Test" });
    });

    it("markRunning sets status and startedAt", () => {
      repo.markRunning(task.id);
      const updated = repo.getById(task.id)!;
      expect(updated.status).toBe("running");
      expect(updated.startedAt).toEqual(now);
    });

    it("markCompleted sets result and completedAt", () => {
      repo.markRunning(task.id);
      repo.markCompleted(task.id, "All done");
      const updated = repo.getById(task.id)!;
      expect(updated.status).toBe("completed");
      expect(updated.result).toBe("All done");
      expect(updated.completedAt).toEqual(now);
    });

    it("markFailed sets error and completedAt", () => {
      repo.markRunning(task.id);
      repo.markFailed(task.id, "Something broke");
      const updated = repo.getById(task.id)!;
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("Something broke");
      expect(updated.completedAt).toEqual(now);
    });

    it("cancel returns true for queued task", () => {
      expect(repo.cancel(task.id)).toBe(true);
      const updated = repo.getById(task.id)!;
      expect(updated.status).toBe("cancelled");
    });

    it("cancel returns true for running task", () => {
      repo.markRunning(task.id);
      expect(repo.cancel(task.id)).toBe(true);
    });

    it("cancel returns false for completed task", () => {
      repo.markCompleted(task.id, "done");
      expect(repo.cancel(task.id)).toBe(false);
    });
  });

  describe("children helpers", () => {
    it("getChildren returns ordered children", () => {
      const parent = repo.insert({ trigger: "chat", goal: "Parent" });
      repo.insert({ trigger: "agent", goal: "C1", parentTaskId: parent.id });
      now = new Date("2026-02-09T12:01:00Z");
      repo.insert({ trigger: "agent", goal: "C2", parentTaskId: parent.id });

      const children = repo.getChildren(parent.id);
      expect(children).toHaveLength(2);
      expect(children[0].goal).toBe("C1");
      expect(children[1].goal).toBe("C2");
    });

    it("countChildren returns correct count", () => {
      const parent = repo.insert({ trigger: "chat", goal: "Parent" });
      expect(repo.countChildren(parent.id)).toBe(0);
      repo.insert({ trigger: "agent", goal: "C1", parentTaskId: parent.id });
      expect(repo.countChildren(parent.id)).toBe(1);
    });
  });

  describe("counting helpers", () => {
    it("countQueued and countRunning", () => {
      repo.insert({ trigger: "chat", goal: "A" });
      repo.insert({ trigger: "chat", goal: "B" });
      expect(repo.countQueued()).toBe(2);
      expect(repo.countRunning()).toBe(0);

      repo.dequeue();
      expect(repo.countQueued()).toBe(1);
      expect(repo.countRunning()).toBe(1);
    });

    it("countRecentBySession counts within window", () => {
      repo.insert({ trigger: "chat", goal: "A", sessionId: "s1" });
      now = new Date("2026-02-09T12:00:30Z");
      repo.insert({ trigger: "chat", goal: "B", sessionId: "s1" });
      repo.insert({ trigger: "chat", goal: "C", sessionId: "s2" });

      // 60s window should include both s1 tasks
      expect(repo.countRecentBySession("s1", 60_000)).toBe(2);
      expect(repo.countRecentBySession("s2", 60_000)).toBe(1);
    });
  });
});
