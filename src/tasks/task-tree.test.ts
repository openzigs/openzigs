import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { TaskRepository } from "./task-repository.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function makeRepo(): { db: Database.Database; repo: TaskRepository } {
  const db = makeDb();
  const repo = new TaskRepository(db);
  repo.migrate();
  return { db, repo };
}

describe("TaskRepository — Task Tree", () => {
  let repo: TaskRepository;

  beforeEach(() => {
    ({ repo } = makeRepo());
  });

  function insertTask(
    goal: string,
    parentTaskId?: string
  ): ReturnType<TaskRepository["insert"]> {
    return repo.insert({
      trigger: "agent",
      goal,
      parentTaskId,
      sessionId: "s1",
    });
  }

  describe("getTaskTreeFlat", () => {
    it("returns a single root task with no children", () => {
      const root = insertTask("root task");
      const flat = repo.getTaskTreeFlat(root.id);
      expect(flat).toHaveLength(1);
      expect(flat[0].id).toBe(root.id);
    });

    it("returns root + children in depth order", () => {
      const root = insertTask("root task");
      const child1 = insertTask("child 1", root.id);
      insertTask("child 2", root.id);
      insertTask("grandchild", child1.id);

      const flat = repo.getTaskTreeFlat(root.id);
      expect(flat).toHaveLength(4);
      expect(flat[0].id).toBe(root.id);
      expect(flat.map((t) => t.goal)).toContain("child 1");
      expect(flat.map((t) => t.goal)).toContain("child 2");
      expect(flat.map((t) => t.goal)).toContain("grandchild");
    });

    it("respects maxDepth limit", () => {
      const root = insertTask("root");
      const child = insertTask("child", root.id);
      insertTask("grandchild", child.id);

      const flat = repo.getTaskTreeFlat(root.id, 1);
      expect(flat).toHaveLength(2); // root + child, no grandchild
    });

    it("returns empty array for nonexistent task", () => {
      expect(repo.getTaskTreeFlat("nonexistent")).toHaveLength(0);
    });
  });

  describe("getTaskTree", () => {
    it("returns null for nonexistent task", () => {
      expect(repo.getTaskTree("nonexistent")).toBeNull();
    });

    it("returns nested tree with stats for single root", () => {
      const root = insertTask("root");
      const result = repo.getTaskTree(root.id)!;

      expect(result.root.id).toBe(root.id);
      expect(result.root.goal).toBe("root");
      expect(result.root.children).toHaveLength(0);
      expect(result.stats.totalTasks).toBe(1);
      expect(result.stats.queued).toBe(1);
    });

    it("builds correct nested tree structure", () => {
      const root = insertTask("root");
      const child1 = insertTask("child-1", root.id);
      insertTask("child-2", root.id);
      insertTask("grandchild-1", child1.id);

      const result = repo.getTaskTree(root.id)!;

      expect(result.root.children).toHaveLength(2);
      const c1 = result.root.children.find((c) => c.goal === "child-1");
      expect(c1?.children).toHaveLength(1);
      expect(c1?.children[0].goal).toBe("grandchild-1");

      const c2 = result.root.children.find((c) => c.goal === "child-2");
      expect(c2?.children).toHaveLength(0);

      expect(result.stats.totalTasks).toBe(4);
    });

    it("computes aggregate stats correctly", () => {
      const root = insertTask("root");
      const child1 = insertTask("child-1", root.id);
      const child2 = insertTask("child-2", root.id);

      // Mark child1 as completed
      repo.markRunning(child1.id);
      repo.markCompleted(child1.id, "done");
      repo.updateTokenUsage(child1.id, {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        turns: 1,
      });

      // Mark child2 as failed
      repo.markRunning(child2.id);
      repo.markFailed(child2.id, "error");
      repo.updateTokenUsage(child2.id, {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        turns: 2,
      });

      const result = repo.getTaskTree(root.id)!;
      expect(result.stats.totalTasks).toBe(3);
      expect(result.stats.queued).toBe(1); // root still queued
      expect(result.stats.completed).toBe(1);
      expect(result.stats.failed).toBe(1);
      expect(result.stats.totalTokens).toBe(450);
    });

    it("includes durationMs for completed tasks", () => {
      const root = insertTask("root");
      repo.markRunning(root.id);
      repo.markCompleted(root.id, "ok");

      const result = repo.getTaskTree(root.id)!;
      expect(result.root.durationMs).toBeTypeOf("number");
      expect(result.root.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getRootTasks", () => {
    it("returns empty list when no tasks exist", () => {
      expect(repo.getRootTasks()).toHaveLength(0);
    });

    it("returns only root tasks", () => {
      const root1 = insertTask("root 1");
      const root2 = insertTask("root 2");
      insertTask("child of root 1", root1.id);

      const roots = repo.getRootTasks();
      expect(roots).toHaveLength(2);
      expect(roots.map((r) => r.id)).toContain(root1.id);
      expect(roots.map((r) => r.id)).toContain(root2.id);
    });

    it("includes correct child count", () => {
      const root = insertTask("root");
      insertTask("child 1", root.id);
      insertTask("child 2", root.id);

      const roots = repo.getRootTasks();
      const found = roots.find((r) => r.id === root.id)!;
      expect(found.childCount).toBe(2);
    });

    it("supports pagination via limit and offset", () => {
      insertTask("root 1");
      insertTask("root 2");
      insertTask("root 3");

      const page1 = repo.getRootTasks({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = repo.getRootTasks({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
    });

    it("returns root tasks ordered by created_at descending", () => {
      // Use a repo with deterministic clock to ensure distinct timestamps
      const db = new Database(":memory:");
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      let tick = 0;
      const clockedRepo = new TaskRepository(db, () => new Date(Date.now() + tick++ * 1000));
      clockedRepo.migrate();

      const r1 = clockedRepo.insert({ trigger: "agent", goal: "first", sessionId: "s1" });
      clockedRepo.insert({ trigger: "agent", goal: "second", sessionId: "s1" });
      const r3 = clockedRepo.insert({ trigger: "agent", goal: "third", sessionId: "s1" });

      const roots = clockedRepo.getRootTasks();
      // Most recent first
      expect(roots[0].id).toBe(r3.id);
      expect(roots[2].id).toBe(r1.id);
    });
  });
});
