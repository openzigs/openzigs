import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TaskRepository } from "../tasks/task-repository.js";
import { TaskEngine } from "../tasks/task-engine.js";
import { TaskWorker } from "../tasks/task-worker.js";
import { createOrchestrateAgentsTools } from "./tools/orchestrate-agents.js";

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

const createMockCopilot = (responseChunks: string[] = ["result"]) => ({
  authenticate: vi.fn(),
  waitForAuth: vi.fn(),
  isAuthenticated: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue([]),
  onToolCall: vi.fn(),
  chat: vi.fn().mockImplementation(async function* () {
    for (const chunk of responseChunks) {
      yield chunk;
    }
  }),
});

describe("orchestrate-agents tool", () => {
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

  it("dispatches multiple agents and returns aggregated results", async () => {
    const mockCopilot = createMockCopilot(["agent done"]);

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 3,
      pollIntervalMs: 50,
      log: silentLog,
    });
    worker.start();

    const tools = createOrchestrateAgentsTools({ taskEngine: engine, copilot: mockCopilot });
    const orchestrateTool = tools.find((t) => t.name === "orchestrate-agents")!;
    expect(orchestrateTool).toBeDefined();

    const result = await orchestrateTool.handler({
      agents: [
        { goal: "Research market A" },
        { goal: "Research market B" },
        { goal: "Research market C" },
      ],
      timeout_seconds: 30,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.metadata.total).toBe(3);
    expect(parsed.metadata.completed).toBe(3);
    expect(parsed.metadata.failed).toBe(0);
  }, 15_000);

  it("handles partial failures gracefully (allSettled)", async () => {
    let callCount = 0;
    const mockCopilot = {
      ...createMockCopilot(),
      chat: vi.fn().mockImplementation(async function* () {
        callCount++;
        if (callCount === 2) {
          yield "";
          throw new Error("Agent 2 exploded");
        }
        yield "success";
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 3,
      pollIntervalMs: 50,
      log: silentLog,
    });
    worker.start();

    const tools = createOrchestrateAgentsTools({ taskEngine: engine, copilot: mockCopilot });
    const orchestrateTool = tools[0];

    const result = await orchestrateTool.handler({
      agents: [
        { goal: "Will succeed 1" },
        { goal: "Will fail" },
        { goal: "Will succeed 2" },
      ],
      timeout_seconds: 30,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.metadata.total).toBe(3);
    expect(parsed.metadata.completed).toBe(2);
    expect(parsed.metadata.failed).toBe(1);
    // The failed agent should have an error field
    const failedResult = parsed.results.find((r: { status: string }) => r.status === "failed");
    expect(failedResult).toBeDefined();
    expect(failedResult.error).toContain("Agent 2 exploded");
  }, 15_000);

  it("uses aggregation_prompt to synthesize results", async () => {
    // First calls are for agents, last call is for aggregation
    let chatCallIdx = 0;
    const mockCopilot = {
      ...createMockCopilot(),
      chat: vi.fn().mockImplementation(async function* () {
        chatCallIdx++;
        if (chatCallIdx <= 2) {
          yield `Research result ${chatCallIdx}`;
        } else {
          // Aggregation call
          yield "Synthesized report combining all findings";
        }
      }),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 2,
      pollIntervalMs: 50,
      log: silentLog,
    });
    worker.start();

    const tools = createOrchestrateAgentsTools({ taskEngine: engine, copilot: mockCopilot });
    const orchestrateTool = tools[0];

    const result = await orchestrateTool.handler({
      agents: [
        { goal: "Research topic A" },
        { goal: "Research topic B" },
      ],
      aggregation_prompt: "Combine these research findings into a comprehensive report.",
      timeout_seconds: 30,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.aggregated_result).toContain("Synthesized report");
    expect(parsed.metadata.completed).toBe(2);
  }, 15_000);

  it("times out and fails when agents take too long", async () => {
    vi.useFakeTimers();

    const mockCopilot = createMockCopilot();
    // Don't start a worker — tasks stay queued, abort fires on timeout

    const tools = createOrchestrateAgentsTools({ taskEngine: engine, copilot: mockCopilot });
    const orchestrateTool = tools[0];

    const resultPromise = orchestrateTool.handler({
      agents: [{ goal: "Will timeout" }],
      timeout_seconds: 30,
    });

    // Advance past the 30s AbortController timeout
    await vi.advanceTimersByTimeAsync(31_000);

    const result = await resultPromise;
    const parsed = JSON.parse(result.text);
    expect(parsed.metadata.total).toBe(1);
    expect(parsed.metadata.failed).toBe(1);
    expect(parsed.results[0].error).toContain("Timeout waiting for task");

    vi.useRealTimers();
  });

  it("includes elapsed_ms in metadata", async () => {
    const mockCopilot = createMockCopilot(["quick result"]);

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 2,
      pollIntervalMs: 50,
      log: silentLog,
    });
    worker.start();

    const tools = createOrchestrateAgentsTools({ taskEngine: engine, copilot: mockCopilot });
    const orchestrateTool = tools[0];

    const result = await orchestrateTool.handler({
      agents: [{ goal: "Quick task" }],
      timeout_seconds: 60,
    });

    const parsed = JSON.parse(result.text);
    expect(parsed.metadata.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(parsed.metadata.elapsed_ms).toBeLessThan(10_000);
  }, 15_000);

  it("passes context to spawned tasks", async () => {
    const mockCopilot = createMockCopilot(["done"]);

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 2,
      pollIntervalMs: 50,
      log: silentLog,
    });
    worker.start();

    const tools = createOrchestrateAgentsTools({ taskEngine: engine, copilot: mockCopilot });
    const orchestrateTool = tools[0];

    const result = await orchestrateTool.handler({
      agents: [
        { goal: "Research with context", context: "Focus on AI coding assistants" },
      ],
      timeout_seconds: 30,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.metadata.completed).toBe(1);

    // Verify context was passed to copilot.chat
    const prompt = mockCopilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("Focus on AI coding assistants");
  }, 15_000);
});
