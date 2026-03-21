import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { ResultInjector } from "./result-injector.js";
import type { AgentTask } from "./types.js";

const createMockTaskEngine = () => {
  const ee = new EventEmitter();
  return ee as any;
};

const createMockSessionManager = () => ({
  appendEvent: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn(),
});

const createMockIO = () => ({
  emit: vi.fn(),
});

const createMockLog = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const baseTask = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  id: "task-1",
  parentTaskId: "parent-1",
  trigger: "agent",
  status: "completed",
  goal: "Research AI trends",
  context: "",
  result: "AI is trending upward",
  error: null,
  sessionId: "session-1",
  channelType: "web",
  chatId: null,
  model: null,
  reasoningEffort: null,
  allowedTools: null,
  autoApproveTools: null,
  pipeline: null,
  tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, turns: 1 },
  notifyOnComplete: false,
  depth: 1,
  createdAt: new Date("2026-03-21T10:00:00Z"),
  startedAt: new Date("2026-03-21T10:00:01Z"),
  completedAt: new Date("2026-03-21T10:00:05Z"),
  spawnedBy: null,
  skillName: null,
  skillBody: null,
  disabledSkills: null,
  agentName: null,
  ...overrides,
});

describe("ResultInjector", () => {
  let taskEngine: ReturnType<typeof createMockTaskEngine>;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let io: ReturnType<typeof createMockIO>;
  let log: ReturnType<typeof createMockLog>;
  let injector: ResultInjector;

  beforeEach(() => {
    taskEngine = createMockTaskEngine();
    sessionManager = createMockSessionManager();
    io = createMockIO();
    log = createMockLog();
    injector = new ResultInjector({
      taskEngine,
      sessionManager: sessionManager as any,
      io: io as any,
      log,
    });
  });

  describe("task:completed", () => {
    it("injects result as system message into session", async () => {
      const task = baseTask();
      taskEngine.emit("task:completed", task);

      // Wait for async handler
      await vi.waitFor(() => {
        expect(sessionManager.appendEvent).toHaveBeenCalledOnce();
      });

      const call = sessionManager.appendEvent.mock.calls[0];
      expect(call[0]).toBe("session-1");
      expect(call[1].type).toBe("assistant");
      expect(call[1].content).toContain("[Sub-agent completed: Research AI trends]");
      expect(call[1].content).toContain("AI is trending upward");
      expect(call[1].metadata.type).toBe("subagent-result");
      expect(call[1].metadata.status).toBe("completed");
      expect(call[1].metadata.taskId).toBe("task-1");
      expect(call[1].metadata.duration).toBe(4000);
    });

    it("emits task:result-injected via Socket.IO", async () => {
      taskEngine.emit("task:completed", baseTask());

      await vi.waitFor(() => {
        expect(io.emit).toHaveBeenCalledWith("task:result-injected", {
          taskId: "task-1",
          sessionId: "session-1",
          status: "completed",
          goal: "Research AI trends",
        });
      });
    });

    it("truncates long results", async () => {
      const longResult = "x".repeat(5000);
      taskEngine.emit("task:completed", baseTask({ result: longResult }));

      await vi.waitFor(() => {
        expect(sessionManager.appendEvent).toHaveBeenCalledOnce();
      });

      const content = sessionManager.appendEvent.mock.calls[0][1].content;
      expect(content.length).toBeLessThan(5000);
      expect(content).toContain("[...truncated");
    });

    it("emits injected event on the EventEmitter", async () => {
      const handler = vi.fn();
      injector.on("injected", handler);

      taskEngine.emit("task:completed", baseTask());

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledOnce();
      });

      expect(handler.mock.calls[0][0].metadata.status).toBe("completed");
    });
  });

  describe("task:failed", () => {
    it("injects error summary into session", async () => {
      const task = baseTask({
        status: "failed",
        result: null,
        error: "API rate limit exceeded",
      });
      taskEngine.emit("task:failed", task);

      await vi.waitFor(() => {
        expect(sessionManager.appendEvent).toHaveBeenCalledOnce();
      });

      const content = sessionManager.appendEvent.mock.calls[0][1].content;
      expect(content).toContain("[Sub-agent failed: Research AI trends]");
      expect(content).toContain("Error: API rate limit exceeded");
    });
  });

  describe("filtering", () => {
    it("does not inject for cron-triggered tasks", async () => {
      taskEngine.emit("task:completed", baseTask({ trigger: "cron" }));

      // Give it a tick to ensure handler doesn't fire
      await new Promise((r) => setTimeout(r, 10));
      expect(sessionManager.appendEvent).not.toHaveBeenCalled();
    });

    it("does not inject for tasks without sessionId", async () => {
      taskEngine.emit("task:completed", baseTask({ sessionId: null }));

      await new Promise((r) => setTimeout(r, 10));
      expect(sessionManager.appendEvent).not.toHaveBeenCalled();
    });

    it("does not inject for chat-triggered tasks", async () => {
      taskEngine.emit("task:completed", baseTask({ trigger: "chat" }));

      await new Promise((r) => setTimeout(r, 10));
      expect(sessionManager.appendEvent).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("logs warning if injection fails", async () => {
      sessionManager.appendEvent.mockRejectedValueOnce(new Error("Session not found"));

      taskEngine.emit("task:completed", baseTask());

      await vi.waitFor(() => {
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining("failed to inject result for task task-1"),
          expect.objectContaining({ error: expect.any(Error) })
        );
      });
    });
  });
});
