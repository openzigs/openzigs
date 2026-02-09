import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TaskRepository } from "./task-repository.js";
import { TaskEngine } from "./task-engine.js";
import { TaskWorker } from "./task-worker.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("TaskWorker", () => {
  let db: Database.Database;
  let repo: TaskRepository;
  let engine: TaskEngine;
  let worker: TaskWorker;
  let now: Date;

  beforeEach(() => {
    db = createTestDb();
    now = new Date("2026-02-09T12:00:00Z");
    repo = new TaskRepository(db, () => now);
    repo.migrate();
    engine = new TaskEngine({ repository: repo, clock: () => now });
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it("processes a background task", async () => {
    const chunks = ["Hello", " world"];
    const mockCopilot = {
      authenticate: vi.fn(),
      waitForAuth: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      onToolCall: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    const task = engine.submit(
      { trigger: "cron", goal: "Summarize something" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    const completed = engine.getTask(task.id)!;
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("Hello world");
    expect(mockCopilot.chat).toHaveBeenCalledOnce();
    // Prompt should contain the goal
    const prompt = mockCopilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("Summarize something");
  });

  it("handles task failure gracefully", async () => {
    const mockCopilot = {
      authenticate: vi.fn(),
      waitForAuth: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      onToolCall: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () {
        yield ""; // eslint requires yield in generators
        throw new Error("LLM exploded");
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    const task = engine.submit(
      { trigger: "cron", goal: "Will fail" },
      { mode: "background" }
    );

    const errorPromise = new Promise<void>((resolve) => {
      worker.on("task:error", () => resolve());
    });

    worker.start();
    await errorPromise;

    const failed = engine.getTask(task.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("LLM exploded");
  });

  it("respects maxConcurrent", async () => {
    let concurrentPeak = 0;
    let concurrent = 0;

    const mockCopilot = {
      authenticate: vi.fn(),
      waitForAuth: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      onToolCall: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () {
        concurrent++;
        concurrentPeak = Math.max(concurrentPeak, concurrent);
        await new Promise((r) => setTimeout(r, 100));
        yield "done";
        concurrent--;
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 2,
      pollIntervalMs: 30,
      log: silentLog,
    });

    // Submit 4 tasks
    for (let i = 0; i < 4; i++) {
      engine.submit({ trigger: "cron", goal: `Task ${i}` }, { mode: "background" });
    }

    let doneCount = 0;
    const allDone = new Promise<void>((resolve) => {
      worker.on("task:done", () => {
        doneCount++;
        if (doneCount === 4) resolve();
      });
    });

    worker.start();
    await allDone;

    expect(concurrentPeak).toBeLessThanOrEqual(2);
    expect(doneCount).toBe(4);
  });

  it("passes model to copilot.chat", async () => {
    const mockCopilot = {
      authenticate: vi.fn(),
      waitForAuth: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      onToolCall: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () {
        yield "ok";
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "cron", goal: "Use Claude", model: "claude-sonnet-4" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    const options = mockCopilot.chat.mock.calls[0][1] as { model?: string };
    expect(options.model).toBe("claude-sonnet-4");
  });

  it("includes context in prompt when present", async () => {
    const mockCopilot = {
      authenticate: vi.fn(),
      waitForAuth: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      onToolCall: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () {
        yield "ok";
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "agent", goal: "Analyze data", context: "Dataset: sales-2026.csv" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    const prompt = mockCopilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("Analyze data");
    expect(prompt).toContain("Dataset: sales-2026.csv");
  });

  it("start is idempotent", () => {
    const mockCopilot = {
      authenticate: vi.fn(),
      waitForAuth: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      onToolCall: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () { yield "x"; }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 100_000, // long so we don't actually poll
      log: silentLog,
    });

    worker.start();
    worker.start(); // Should not throw or double-start
  });
});
