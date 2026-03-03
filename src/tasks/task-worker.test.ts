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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
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

  it("passes SDK-native availableTools when task has allowedTools", async () => {
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () {
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

    // Verify availableTools string array was passed to copilot.chat
    const chatOptions = mockCopilot.chat.mock.calls[0][1] as { availableTools?: string[] };
    expect(chatOptions.availableTools).toBeDefined();

    // Should include the explicitly allowed tools
    expect(chatOptions.availableTools).toContain("web-search");
    expect(chatOptions.availableTools).toContain("linkedin-post");
    // When allowedTools is explicitly set, ALWAYS_ON_TOOLS are NOT merged —
    // the whole point of allowedTools is to scope what the agent can use.
    expect(chatOptions.availableTools).toHaveLength(2);
    expect(chatOptions.availableTools).not.toContain("read-file");
    expect(chatOptions.availableTools).not.toContain("spawn-agent");
    expect(chatOptions.availableTools).not.toContain("orchestrate-agents");
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
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
      chat: vi.fn().mockImplementation(async function* () {
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

    engine.submit(
      { trigger: "cron", goal: "No scoping" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    // availableTools should be undefined (no scoping)
    const chatOptions = mockCopilot.chat.mock.calls[0][1] as { availableTools?: string[] };
    expect(chatOptions.availableTools).toBeUndefined();
  });

  // ── Helper to reduce mock boilerplate ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeMockCopilot(chatImpl?: (...args: any[]) => AsyncGenerator<string>) {
    return {
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
      modelSupportsReasoning: vi.fn().mockReturnValue(false),
      getProvider: vi.fn().mockReturnValue(undefined),
      setProvider: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue(undefined),
      setWorkingDirectory: vi.fn(),
      getCustomAgents: vi.fn().mockReturnValue([]),
      setCustomAgents: vi.fn(),
      getNativeMcpServers: vi.fn().mockReturnValue({}),
      setNativeMcpServers: vi.fn(),
      getSessionUsage: vi.fn().mockReturnValue(null),
      clearSessionUsage: vi.fn().mockReturnValue(null),
      listSdkSessions: vi.fn().mockResolvedValue([]),
      getSdkSessionMessages: vi.fn().mockResolvedValue([]),
      deleteSdkSession: vi.fn().mockResolvedValue(undefined),
      getSessionAnalytics: vi.fn().mockReturnValue({ sessionsCreated: 0, sessionsResumed: 0, sessionsDestroyed: 0, compactionCount: 0, lifecycleEvents: [], lastUpdated: "" }),
      resetSessionAnalytics: vi.fn(),
      chat: vi.fn().mockImplementation(chatImpl ?? async function* () { yield "ok"; }),
    };
  }

  it("exposes activeCount and concurrencyLimit getters", () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 3,
      pollIntervalMs: 100_000,
      log: silentLog,
    });
    expect(worker.activeCount).toBe(0);
    expect(worker.concurrencyLimit).toBe(3);
  });

  it("setMaxConcurrent validates range 1-10", () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 2,
      pollIntervalMs: 100_000,
      log: silentLog,
    });

    worker.setMaxConcurrent(5);
    expect(worker.concurrencyLimit).toBe(5);

    expect(() => worker.setMaxConcurrent(0)).toThrow(RangeError);
    expect(() => worker.setMaxConcurrent(11)).toThrow(RangeError);
    expect(() => worker.setMaxConcurrent(-1)).toThrow(RangeError);
  });

  it("stop drains in-flight tasks", async () => {
    const mockCopilot = makeMockCopilot(async function* () {
      await new Promise((r) => setTimeout(r, 100));
      yield "delayed";
    });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit({ trigger: "cron", goal: "Slow work" }, { mode: "background" });
    worker.start();
    // Give the poll time to pick up
    await new Promise((r) => setTimeout(r, 80));

    // stop() should wait for the task to finish
    await worker.stop();
    const tasks = engine.listTasks({ status: "completed" });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("emits task:executing event before processing", async () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    const executingHandler = vi.fn();
    worker.on("task:executing", executingHandler);

    engine.submit({ trigger: "cron", goal: "Emit test" }, { mode: "background" });

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    expect(executingHandler).toHaveBeenCalledOnce();
    expect(executingHandler.mock.calls[0][0].goal).toBe("Emit test");
  });

  it("passes reasoningEffort to copilot.chat", async () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "cron", goal: "Think hard", reasoningEffort: "high" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    const chatOptions = mockCopilot.chat.mock.calls[0][1] as { reasoningEffort?: string };
    expect(chatOptions.reasoningEffort).toBe("high");
  });

  it("passes autoApproveTools to copilot.chat", async () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "cron", goal: "Auto approve", autoApproveTools: ["shell-execute", "read-file"] },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    const chatOptions = mockCopilot.chat.mock.calls[0][1] as { autoApproveTools?: string[] };
    expect(chatOptions.autoApproveTools).toEqual(["shell-execute", "read-file"]);
  });

  it("injects parentTaskId for orchestrate-agents tool calls", async () => {
    let capturedOnToolCall: ((toolName: string, args: unknown) => void) | undefined;

    const mockCopilot = makeMockCopilot(async function* (_prompt: string, options?: { onToolCall?: (t: string, a: unknown) => void }) {
      capturedOnToolCall = options?.onToolCall;
      yield "done";
    });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    const task = engine.submit(
      { trigger: "cron", goal: "Orchestrate", sessionId: "sess-99", channelType: "web", chatId: "chat-1" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    const args: Record<string, unknown> = { agents: [] };
    capturedOnToolCall!("orchestrate-agents", args);
    expect(args.parentTaskId).toBe(task.id);
    expect(args.sessionId).toBe("sess-99");
    expect(args.channelType).toBe("web");
    expect(args.chatId).toBe("chat-1");
  });

  it("provides onUserInputRequest that returns empty answer", async () => {
    let capturedOnUserInput: (() => Promise<{ answer: string; wasFreeform: boolean }>) | undefined;

    const mockCopilot = makeMockCopilot(async function* (_prompt: string, options?: { onUserInputRequest?: () => Promise<{ answer: string; wasFreeform: boolean }> }) {
      capturedOnUserInput = options?.onUserInputRequest;
      yield "done";
    });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit({ trigger: "cron", goal: "Background task" }, { mode: "background" });

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    expect(capturedOnUserInput).toBeDefined();
    const result = await capturedOnUserInput!();
    expect(result).toEqual({ answer: "", wasFreeform: false });
  });

  it("persists token usage on success when taskRepository is set", async () => {
    const mockCopilot = makeMockCopilot();
    mockCopilot.clearSessionUsage.mockReturnValue({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      turns: 1,
    });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      taskRepository: repo,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "cron", goal: "Track tokens", sessionId: "sess-tok" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    expect(mockCopilot.clearSessionUsage).toHaveBeenCalledWith("sess-tok");
  });

  it("persists token usage even on task failure", async () => {
    // eslint-disable-next-line require-yield
    const mockCopilot = makeMockCopilot(async function* () {
      throw new Error("Boom");
    });
    mockCopilot.clearSessionUsage.mockReturnValue({ inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1 });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      taskRepository: repo,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "cron", goal: "Fail with tokens", sessionId: "sess-fail" },
      { mode: "background" }
    );

    const errorPromise = new Promise<void>((resolve) => {
      worker.on("task:error", () => resolve());
    });

    worker.start();
    await errorPromise;

    expect(mockCopilot.clearSessionUsage).toHaveBeenCalledWith("sess-fail");
  });

  it("skips token persistence when no taskRepository", async () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      // no taskRepository
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "cron", goal: "No repo" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    // clearSessionUsage should not be called when there's no repo or no sessionId
    expect(mockCopilot.clearSessionUsage).not.toHaveBeenCalled();
  });

  it("handles non-Error throw in executeTask", async () => {
    // eslint-disable-next-line require-yield
    const mockCopilot = makeMockCopilot(async function* () {
      // eslint-disable-next-line no-throw-literal
      throw "string-error";
    });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit({ trigger: "cron", goal: "String throw" }, { mode: "background" });

    const errorPromise = new Promise<void>((resolve) => {
      worker.on("task:error", () => resolve());
    });

    worker.start();
    await errorPromise;

    const tasks = engine.listTasks({ status: "failed" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].error).toBe("string-error");
  });

  it("does not poll when stopped", async () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    worker.start();
    await worker.stop();

    // Submit after stop — should NOT be picked up
    engine.submit({ trigger: "cron", goal: "After stop" }, { mode: "background" });
    await new Promise((r) => setTimeout(r, 150));

    const tasks = engine.listTasks({ status: "queued" });
    expect(tasks).toHaveLength(1); // still queued since worker is stopped
  });

  it("executes a pipeline with sequential stages", async () => {
    let chatCallCount = 0;
    const mockCopilot = makeMockCopilot(async function* () {
      chatCallCount++;
      yield `stage-${chatCallCount}-result`;
    });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 2, // needs capacity for parent + child tasks
      pollIntervalMs: 50,
      log: silentLog,
    });

    // Submit a task with pipeline stages
    engine.submit(
      {
        trigger: "cron",
        goal: "Pipeline test",
        pipeline: {
          stages: [
            { type: "prompt", name: "research", prompt: "Research the topic" },
            { type: "prompt", name: "summarize", prompt: "Summarize findings" },
          ],
        },
      },
      { mode: "background" }
    );

    // Wait for the pipeline parent to complete (it emits task:done)
    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", (t) => {
        if (t.goal === "Pipeline test") resolve();
      });
    });

    worker.start();
    await donePromise;

    const completed = engine.listTasks({ status: "completed" });
    const parentTask = completed.find((t) => t.goal === "Pipeline test");
    expect(parentTask).toBeDefined();
    expect(parentTask!.status).toBe("completed");
    // Each stage spawns a child task, plus the worker processes them
    expect(mockCopilot.chat.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("pipeline aborts if a stage fails", async () => {
    let callCount = 0;
    const mockCopilot = makeMockCopilot(async function* () {
      callCount++;
      if (callCount === 1) {
        // First stage child task succeeds
        yield "stage-1-ok";
      } else {
        throw new Error("Stage 2 exploded");
      }
    });

    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 2, // needs capacity for parent + child tasks
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      {
        trigger: "cron",
        goal: "Pipeline fail test",
        pipeline: {
          stages: [
            { type: "prompt", name: "step-1", prompt: "Step 1" },
            { type: "prompt", name: "step-2", prompt: "Step 2 will fail" },
          ],
        },
      },
      { mode: "background" }
    );

    const errorPromise = new Promise<void>((resolve) => {
      worker.on("task:error", (t) => {
        if (t.goal === "Pipeline fail test") resolve();
      });
    });

    worker.start();
    await errorPromise;

    const parentTask = engine.getTask(
      engine.listTasks().find((t) => t.goal === "Pipeline fail test")!.id
    )!;
    expect(parentTask.status).toBe("failed");
    expect(parentTask.error).toContain("step-2");
  }, 15_000);

  it("buildPrompt includes context section when task has context", async () => {
    const mockCopilot = makeMockCopilot();
    worker = new TaskWorker({
      engine,
      copilot: mockCopilot,
      maxConcurrent: 1,
      pollIntervalMs: 50,
      log: silentLog,
    });

    engine.submit(
      { trigger: "agent", goal: "Summarize report", context: "Q4 revenue: $5M" },
      { mode: "background" }
    );

    const donePromise = new Promise<void>((resolve) => {
      worker.on("task:done", () => resolve());
    });

    worker.start();
    await donePromise;

    const prompt = mockCopilot.chat.mock.calls[0][0] as string;
    expect(prompt).toContain("Additional Context:");
    expect(prompt).toContain("Q4 revenue: $5M");
    expect(prompt).toContain("autonomous agent");
  });
});
