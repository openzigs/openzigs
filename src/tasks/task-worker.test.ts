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
      setMaxToolsPerRequest: vi.fn(),
      getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
      destroySession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn().mockReturnValue(false),
      clearAllSessions: vi.fn().mockResolvedValue(undefined),
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
      setMaxToolsPerRequest: vi.fn(),
      getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
      destroySession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn().mockReturnValue(false),
      clearAllSessions: vi.fn().mockResolvedValue(undefined),
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
      setMaxToolsPerRequest: vi.fn(),
      getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
      destroySession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn().mockReturnValue(false),
      clearAllSessions: vi.fn().mockResolvedValue(undefined),
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
      setMaxToolsPerRequest: vi.fn(),
      getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
      destroySession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn().mockReturnValue(false),
      clearAllSessions: vi.fn().mockResolvedValue(undefined),
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
      setMaxToolsPerRequest: vi.fn(),
      getMaxToolsPerRequest: vi.fn().mockReturnValue(30),
      destroySession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn().mockReturnValue(false),
      clearAllSessions: vi.fn().mockResolvedValue(undefined),
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

  it("injects parentTaskId and sessionId via onToolCall for spawn-agent", async () => {
    let capturedOnToolCall: ((toolName: string, args: unknown) => void) | undefined;

    const mockCopilot = {
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
      chat: vi.fn().mockImplementation(async function* (_prompt: string, options?: { onToolCall?: (t: string, a: unknown) => void }) {
        capturedOnToolCall = options?.onToolCall;
        yield "done";
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
      { trigger: "cron", goal: "Parent job", sessionId: "sess-42" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    // Verify onToolCall was passed to copilot.chat
    expect(capturedOnToolCall).toBeDefined();

    // Simulate calling spawn-agent — should inject parentTaskId and sessionId
    const args: Record<string, unknown> = { goal: "child work" };
    capturedOnToolCall!("spawn-agent", args);
    expect(args.parentTaskId).toBe(task.id);
    expect(args.sessionId).toBe("sess-42");

    // Non-spawn-agent tools should not be modified
    const otherArgs: Record<string, unknown> = { query: "search" };
    capturedOnToolCall!("web-search", otherArgs);
    expect(otherArgs.parentTaskId).toBeUndefined();
  });

  it("start is idempotent", () => {
    const mockCopilot = {
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

  it("passes scoped tools to copilot.chat when task has allowedTools", async () => {
    const mockCopilot = {
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
      chat: vi.fn().mockImplementation(async function* () {
        yield "done";
      }),
    };

    // Create a minimal mock ToolRegistry
    const mockToolDefs = [
      { name: "read-file", description: "Read file", category: "filesystem", riskLevel: "low" },
      { name: "web-search", description: "Search", category: "search", riskLevel: "low" },
      { name: "shell-execute", description: "Execute shell", category: "shell", riskLevel: "high" },
      { name: "spawn-agent", description: "Spawn agent", category: "developer", riskLevel: "medium" },
      { name: "list-directory", description: "List dir", category: "filesystem", riskLevel: "low" },
      { name: "browser-navigate", description: "Navigate", category: "browser", riskLevel: "high" },
      { name: "orchestrate-agents", description: "Orchestrate", category: "developer", riskLevel: "medium" },
      { name: "linkedin-post", description: "Post to LinkedIn", category: "social", riskLevel: "medium" },
      { name: "twitter-post", description: "Post to Twitter", category: "social", riskLevel: "medium" },
    ];

    const mockToolRegistry = {
      listEnabledTools: vi.fn().mockReturnValue(mockToolDefs),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      toolRegistry: mockToolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    // Submit a task WITH allowedTools — only web-search and linkedin-post
    const taskInput = {
      trigger: "cron" as const,
      goal: "Post summary to LinkedIn",
      allowedTools: ["web-search", "linkedin-post"],
    };
    engine.submit(taskInput, { mode: "background" });

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    // Verify tools were passed to copilot.chat
    const chatOptions = mockCopilot.chat.mock.calls[0][1] as { tools?: unknown[] };
    expect(chatOptions.tools).toBeDefined();

    const toolNames = (chatOptions.tools as Array<{ name: string }>).map((t) => t.name);
    // Should include the explicitly allowed tools
    expect(toolNames).toContain("web-search");
    expect(toolNames).toContain("linkedin-post");
    // Should include always-on tools
    expect(toolNames).toContain("read-file");
    expect(toolNames).toContain("spawn-agent");
    expect(toolNames).toContain("orchestrate-agents");
    // Should NOT include twitter-post (not in allowedTools)
    expect(toolNames).not.toContain("twitter-post");
  });

  it("does not scope tools when task has no allowedTools", async () => {
    const mockCopilot = {
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
      chat: vi.fn().mockImplementation(async function* () {
        yield "done";
      }),
    };

    const mockToolRegistry = {
      listEnabledTools: vi.fn().mockReturnValue([]),
    };

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      toolRegistry: mockToolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "cron", goal: "No scoping" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    // tools should be undefined (no scoping)
    const chatOptions = mockCopilot.chat.mock.calls[0][1] as { tools?: unknown[] };
    expect(chatOptions.tools).toBeUndefined();
  });
});
