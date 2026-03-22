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

    it("stores and retrieves allowedTools", () => {
      const task = repo.insert({
        trigger: "cron",
        goal: "Scoped task",
        allowedTools: ["web-search", "read-file"],
      });

      expect(task.allowedTools).toEqual(["web-search", "read-file"]);

      const fetched = repo.getById(task.id);
      expect(fetched!.allowedTools).toEqual(["web-search", "read-file"]);
    });

    it("defaults allowedTools to null when not provided", () => {
      const task = repo.insert({
        trigger: "chat",
        goal: "Unscoped task",
      });

      expect(task.allowedTools).toBeNull();
    });

    it("stores and retrieves skillName and skillBody", () => {
      const task = repo.insert({
        trigger: "cron",
        goal: "Skill task",
        skillName: "media-director",
        skillBody: "You are a media director skill.\n\nDo media things.",
      });

      expect(task.skillName).toBe("media-director");
      expect(task.skillBody).toBe("You are a media director skill.\n\nDo media things.");

      const fetched = repo.getById(task.id);
      expect(fetched!.skillName).toBe("media-director");
      expect(fetched!.skillBody).toBe("You are a media director skill.\n\nDo media things.");
    });

    it("defaults skillName and skillBody to null", () => {
      const task = repo.insert({
        trigger: "chat",
        goal: "No skill task",
      });

      expect(task.skillName).toBeNull();
      expect(task.skillBody).toBeNull();
    });

    it("stores and retrieves disabledSkills and agentName", () => {
      const task = repo.insert({
        trigger: "cron",
        goal: "Focused skill task",
        disabledSkills: ["content-creator", "knowledge-curator"],
        agentName: "scheduled-researcher",
      });

      expect(task.disabledSkills).toEqual(["content-creator", "knowledge-curator"]);
      expect(task.agentName).toBe("scheduled-researcher");

      const fetched = repo.getById(task.id);
      expect(fetched!.disabledSkills).toEqual(["content-creator", "knowledge-curator"]);
      expect(fetched!.agentName).toBe("scheduled-researcher");
    });

    it("defaults disabledSkills and agentName to null", () => {
      const task = repo.insert({
        trigger: "chat",
        goal: "No extras",
      });

      expect(task.disabledSkills).toBeNull();
      expect(task.agentName).toBeNull();
    });

    it("stores and retrieves enableInSessionSubagents", () => {
      const task = repo.insert({
        trigger: "cron",
        goal: "Subagent task",
        enableInSessionSubagents: true,
      });

      expect(task.enableInSessionSubagents).toBe(true);

      const fetched = repo.getById(task.id);
      expect(fetched!.enableInSessionSubagents).toBe(true);
    });

    it("defaults enableInSessionSubagents to false", () => {
      const task = repo.insert({
        trigger: "chat",
        goal: "No subagents",
      });

      expect(task.enableInSessionSubagents).toBe(false);
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

  describe("findByJobName", () => {
    it("finds tasks matching a job name in context JSON", () => {
      repo.insert({
        trigger: "cron",
        goal: "Run daily report",
        context: JSON.stringify({ jobName: "daily-report", jobId: "j1" }),
      });
      repo.insert({
        trigger: "cron",
        goal: "Run weekly digest",
        context: JSON.stringify({ jobName: "weekly-digest", jobId: "j2" }),
      });
      repo.insert({
        trigger: "cron",
        goal: "Another daily report",
        context: JSON.stringify({ jobName: "daily-report", jobId: "j1" }),
      });

      const results = repo.findByJobName("daily-report");
      expect(results).toHaveLength(2);
      expect(results.every((t) => t.goal.includes("daily report"))).toBe(true);
    });

    it("returns empty array when no tasks match", () => {
      repo.insert({ trigger: "chat", goal: "No context" });
      expect(repo.findByJobName("nonexistent")).toEqual([]);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        repo.insert({
          trigger: "cron",
          goal: `Task ${i}`,
          context: JSON.stringify({ jobName: "my-job" }),
        });
      }
      expect(repo.findByJobName("my-job", 3)).toHaveLength(3);
    });

    it("returns results ordered by most recent first", () => {
      repo.insert({
        trigger: "cron",
        goal: "First",
        context: JSON.stringify({ jobName: "ordered-job" }),
      });
      now = new Date("2026-02-09T13:00:00Z");
      repo.insert({
        trigger: "cron",
        goal: "Second",
        context: JSON.stringify({ jobName: "ordered-job" }),
      });

      const results = repo.findByJobName("ordered-job");
      expect(results[0].goal).toBe("Second");
      expect(results[1].goal).toBe("First");
    });

    it("sanitizes double quotes from job name to prevent injection", () => {
      repo.insert({
        trigger: "cron",
        goal: "Safe task",
        context: JSON.stringify({ jobName: "safe-job" }),
      });
      // Attempting injection via quotes should return nothing
      const results = repo.findByJobName('safe-job" OR 1=1 --');
      expect(results).toEqual([]);
    });

    it("escapes LIKE wildcards (% and _) in job name (Issue #468)", () => {
      // Insert a task with a job name that contains a literal %
      repo.insert({
        trigger: "cron",
        goal: "Percent task",
        context: JSON.stringify({ jobName: "100%_done" }),
      });
      repo.insert({
        trigger: "cron",
        goal: "Other task",
        context: JSON.stringify({ jobName: "other-job" }),
      });

      // Searching for the literal % name should find only the matching task
      const results = repo.findByJobName("100%_done");
      expect(results).toHaveLength(1);
      expect(results[0].goal).toBe("Percent task");

      // Searching with % as a wildcard attack should NOT match all tasks
      const wildcard = repo.findByJobName("%");
      expect(wildcard).toHaveLength(0);
    });
  });

  describe("list — LIMIT parameterization (Issue #468)", () => {
    it("respects numeric limit param", () => {
      for (let i = 0; i < 5; i++) {
        repo.insert({ trigger: "chat", goal: `Task ${i}` });
      }
      const tasks = repo.list({ limit: 3 });
      expect(tasks).toHaveLength(3);
    });

    it("returns all tasks when no limit", () => {
      for (let i = 0; i < 3; i++) {
        repo.insert({ trigger: "chat", goal: `Task ${i}` });
      }
      const tasks = repo.list();
      expect(tasks).toHaveLength(3);
    });

    it("does not allow SQL injection via limit (parameterized)", () => {
      repo.insert({ trigger: "chat", goal: "Task" });
      // If limit were string-interpolated, "1; DROP TABLE agent_tasks" would be dangerous.
      // With parameterized ?, passing a number is the only valid option.
      // This test verifies the code doesn't crash and works correctly.
      const tasks = repo.list({ limit: 1 });
      expect(tasks).toHaveLength(1);
    });
  });

  describe("listSince — LIMIT parameterization (Issue #468)", () => {
    it("respects numeric limit param", () => {
      for (let i = 0; i < 5; i++) {
        repo.insert({ trigger: "chat", goal: `Task ${i}` });
      }
      const tasks = repo.listSince("2026-01-01T00:00:00Z", { limit: 2 });
      expect(tasks).toHaveLength(2);
    });

    it("filters by status and applies limit", () => {
      for (let i = 0; i < 3; i++) {
        const t = repo.insert({ trigger: "chat", goal: `Task ${i}` });
        if (i < 2) repo.markCompleted(t.id, "done");
      }
      const tasks = repo.listSince("2026-01-01T00:00:00Z", { status: "completed", limit: 1 });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("completed");
    });
  });
});
