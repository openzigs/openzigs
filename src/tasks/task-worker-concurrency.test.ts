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

const createMockCopilot = () => ({
  authenticate: vi.fn(),
  waitForAuth: vi.fn(),
  isAuthenticated: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue([]),
  onToolCall: vi.fn(),
  setMaxToolsPerRequest: vi.fn(),
  getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
  destroySession: vi.fn().mockResolvedValue(undefined),
  hasSession: vi.fn().mockReturnValue(false),
  clearAllSessions: vi.fn().mockResolvedValue(undefined),
  getReasoningEffort: vi.fn().mockReturnValue(undefined),
  setReasoningEffort: vi.fn(),
  getProvider: vi.fn().mockReturnValue(undefined),
  setProvider: vi.fn(),
  getWorkingDirectory: vi.fn().mockReturnValue(undefined),
  setWorkingDirectory: vi.fn(),
  getCustomAgents: vi.fn().mockReturnValue([]),
  setCustomAgents: vi.fn(),
  getNativeMcpServers: vi.fn().mockReturnValue({}),
  setNativeMcpServers: vi.fn(),
  chat: vi.fn().mockImplementation(async function* () {
    yield "ok";
  }),
});

describe("TaskWorker.setMaxConcurrent", () => {
  let db: Database.Database;
  let repo: TaskRepository;
  let engine: TaskEngine;
  let worker: TaskWorker;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date("2026-02-09T12:00:00Z");
    repo = new TaskRepository(db, () => now);
    repo.migrate();
    engine = new TaskEngine({ repository: repo, clock: () => now });
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it("updates concurrency at runtime", () => {
    worker = new TaskWorker({
      engine,
      copilot: createMockCopilot(),
      maxConcurrent: 2,
      pollIntervalMs: 100_000,
      log: silentLog,
    });

    expect(worker.concurrencyLimit).toBe(2);
    worker.setMaxConcurrent(5);
    expect(worker.concurrencyLimit).toBe(5);
  });

  it("rejects values below 1", () => {
    worker = new TaskWorker({
      engine,
      copilot: createMockCopilot(),
      maxConcurrent: 2,
      pollIntervalMs: 100_000,
      log: silentLog,
    });

    expect(() => worker.setMaxConcurrent(0)).toThrow(RangeError);
    expect(() => worker.setMaxConcurrent(-1)).toThrow(RangeError);
  });

  it("rejects values above 10", () => {
    worker = new TaskWorker({
      engine,
      copilot: createMockCopilot(),
      maxConcurrent: 2,
      pollIntervalMs: 100_000,
      log: silentLog,
    });

    expect(() => worker.setMaxConcurrent(11)).toThrow(RangeError);
    expect(() => worker.setMaxConcurrent(100)).toThrow(RangeError);
  });

  it("allows processing more tasks after increasing concurrency", async () => {
    let concurrentPeak = 0;
    let concurrent = 0;

    const mockCopilot = {
      ...createMockCopilot(),
      chat: vi.fn().mockImplementation(async function* () {
        concurrent++;
        concurrentPeak = Math.max(concurrentPeak, concurrent);
        await new Promise((r) => setTimeout(r, 80));
        yield "done";
        concurrent--;
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 20,
      log: silentLog,
    });

    // Submit 4 tasks
    for (let i = 0; i < 4; i++) {
      engine.submit({ trigger: "cron", goal: `Task ${i}` }, { mode: "background" });
    }

    // Increase concurrency before starting
    worker.setMaxConcurrent(4);

    let doneCount = 0;
    const allDone = new Promise<void>((resolve) => {
      worker.on("task:done", () => {
        doneCount++;
        if (doneCount === 4) resolve();
      });
    });

    worker.start();
    await allDone;

    expect(concurrentPeak).toBeGreaterThan(1);
    expect(concurrentPeak).toBeLessThanOrEqual(4);
    expect(doneCount).toBe(4);
  });
});
