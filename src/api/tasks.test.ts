import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { TaskRepository } from "../tasks/task-repository.js";
import { TaskEngine } from "../tasks/task-engine.js";
import { createTasksRouter } from "./tasks.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

describe("Tasks API", () => {
  let app: express.Application;
  let engine: TaskEngine;
  let now: Date;

  beforeEach(() => {
    const db = createTestDb();
    now = new Date("2026-02-09T12:00:00Z");
    const repo = new TaskRepository(db, () => now);
    repo.migrate();
    engine = new TaskEngine({ repository: repo, clock: () => now });

    app = express();
    app.use(express.json());
    app.use("/api/tasks", createTasksRouter({ taskEngine: engine }));
  });

  describe("GET /api/tasks", () => {
    it("returns empty list initially", async () => {
      const res = await request(app).get("/api/tasks");
      expect(res.status).toBe(200);
      expect(res.body.tasks).toEqual([]);
      expect(res.body.count).toBe(0);
    });

    it("returns all tasks", async () => {
      engine.submit({ trigger: "chat", goal: "A" }, { mode: "background" });
      engine.submit({ trigger: "cron", goal: "B" }, { mode: "background" });

      const res = await request(app).get("/api/tasks");
      expect(res.body.count).toBe(2);
    });

    it("filters by status", async () => {
      const task = engine.submit({ trigger: "chat", goal: "A" }, { mode: "immediate" });
      engine.submit({ trigger: "cron", goal: "B" }, { mode: "background" });
      engine.complete(task.id, "done");

      const res = await request(app).get("/api/tasks?status=completed");
      expect(res.body.count).toBe(1);
      expect(res.body.tasks[0].goal).toBe("A");
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        engine.submit({ trigger: "chat", goal: `Task ${i}` }, { mode: "background" });
      }
      const res = await request(app).get("/api/tasks?limit=2");
      expect(res.body.count).toBe(2);
    });
  });

  describe("GET /api/tasks/stats", () => {
    it("returns queue stats", async () => {
      engine.submit({ trigger: "cron", goal: "A" }, { mode: "background" });
      engine.submit({ trigger: "cron", goal: "B" }, { mode: "background" });
      engine.dequeue();

      const res = await request(app).get("/api/tasks/stats");
      expect(res.status).toBe(200);
      expect(res.body.queued).toBe(1);
      expect(res.body.running).toBe(1);
    });
  });

  describe("GET /api/tasks/:id", () => {
    it("returns a task by ID", async () => {
      const task = engine.submit({ trigger: "chat", goal: "Hello" }, { mode: "background" });
      const res = await request(app).get(`/api/tasks/${task.id}`);
      expect(res.status).toBe(200);
      expect(res.body.goal).toBe("Hello");
      expect(res.body.createdAt).toBe(now.toISOString());
    });

    it("returns 404 for unknown ID", async () => {
      const res = await request(app).get("/api/tasks/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/tasks/:id/children", () => {
    it("returns children of a task", async () => {
      const parent = engine.submit({ trigger: "chat", goal: "Parent" }, { mode: "immediate" });
      engine.submit(
        { trigger: "agent", goal: "Child", parentTaskId: parent.id },
        { mode: "background" }
      );

      const res = await request(app).get(`/api/tasks/${parent.id}/children`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.children[0].goal).toBe("Child");
    });

    it("returns 404 for unknown parent", async () => {
      const res = await request(app).get("/api/tasks/nope/children");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/tasks/:id/cancel", () => {
    it("cancels a queued task", async () => {
      const task = engine.submit({ trigger: "cron", goal: "Cancel me" }, { mode: "background" });
      const res = await request(app).post(`/api/tasks/${task.id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
    });

    it("returns 409 for already-completed task", async () => {
      const task = engine.submit({ trigger: "chat", goal: "Done" }, { mode: "immediate" });
      engine.complete(task.id, "done");

      const res = await request(app).post(`/api/tasks/${task.id}/cancel`);
      expect(res.status).toBe(409);
    });
  });
});
