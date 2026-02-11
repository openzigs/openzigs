import { describe, expect, it, vi } from "vitest";
import { createHooksConfig } from "./hooks.js";

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("createHooksConfig", () => {
  it("onPreToolUse allows tools that do not require approval", async () => {
    const toolRegistry = {
      requiresApproval: vi.fn().mockReturnValue(false),
    };
    const hooks = createHooksConfig({
      toolRegistry: toolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
      log: silentLog,
    });

    const result = await hooks.onPreToolUse!({
      toolName: "read-file",
      toolArgs: { path: "/tmp/test.txt" },
      context: { sessionId: "test-session" },
    });

    expect(result.permissionDecision).toBe("allow");
  });

  it("onPreToolUse denies tools when approval is rejected", async () => {
    const toolRegistry = {
      requiresApproval: vi.fn().mockReturnValue(true),
    };
    const approvalQueue = {
      requestApproval: vi.fn().mockResolvedValue({
        approved: false,
        status: "rejected",
        reason: "Too dangerous",
      }),
    };
    const hooks = createHooksConfig({
      toolRegistry: toolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
      approvalQueue: approvalQueue as unknown as import("../approvals/index.js").ApprovalQueue,
      log: silentLog,
    });

    const result = await hooks.onPreToolUse!({
      toolName: "shell-execute",
      toolArgs: { command: "rm -rf /" },
      context: { sessionId: "test-session" },
    });

    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toBe("User denied");
  });

  it("onPreToolUse reports timeout when approval expires", async () => {
    const toolRegistry = {
      requiresApproval: vi.fn().mockReturnValue(true),
    };
    const approvalQueue = {
      requestApproval: vi.fn().mockResolvedValue({
        approved: false,
        status: "expired",
      }),
    };
    const hooks = createHooksConfig({
      toolRegistry: toolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
      approvalQueue: approvalQueue as unknown as import("../approvals/index.js").ApprovalQueue,
      log: silentLog,
    });

    const result = await hooks.onPreToolUse!({
      toolName: "shell-execute",
      toolArgs: { command: "ls" },
      context: { sessionId: "test-session" },
    });

    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toBe("Approval timed out");
  });

  it("onPreToolUse allows tools when approval is granted", async () => {
    const toolRegistry = {
      requiresApproval: vi.fn().mockReturnValue(true),
    };
    const approvalQueue = {
      requestApproval: vi.fn().mockResolvedValue({
        approved: true,
        status: "approved",
      }),
    };
    const hooks = createHooksConfig({
      toolRegistry: toolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
      approvalQueue: approvalQueue as unknown as import("../approvals/index.js").ApprovalQueue,
      log: silentLog,
    });

    const result = await hooks.onPreToolUse!({
      toolName: "shell-execute",
      context: { sessionId: "test-session" },
      toolArgs: { command: "echo hello" },
    });

    expect(result.permissionDecision).toBe("allow");
  });
  it("onPreToolUse resolves channel from sessionManager", async () => {
    const toolRegistry = {
      requiresApproval: vi.fn().mockReturnValue(true),
    };
    const approvalQueue = {
      requestApproval: vi.fn().mockResolvedValue({
        approved: true,
        status: "approved",
      }),
    };
    const sessionManager = {
      getSession: vi.fn().mockResolvedValue({ channel: "telegram" }),
    };
    const hooks = createHooksConfig({
      toolRegistry: toolRegistry as unknown as import("../mcp/tool-registry.js").ToolRegistry,
      approvalQueue: approvalQueue as unknown as import("../approvals/index.js").ApprovalQueue,
      sessionManager: sessionManager as unknown as import("../sessions/session-manager.js").SessionManager,
      log: silentLog,
    });

    await hooks.onPreToolUse!({
      toolName: "shell-execute",
      toolArgs: { command: "echo hello" },
      context: { sessionId: "session-123" },
    });

    expect(sessionManager.getSession).toHaveBeenCalledWith("session-123");
    expect(approvalQueue.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "telegram",
      })
    );
  });

  it("onPostToolUse logs to audit logger", async () => {
    const auditLogger = {
      log: vi.fn().mockResolvedValue({ id: "entry-1" }),
    };
    const hooks = createHooksConfig({
      auditLogger: auditLogger as unknown as import("../logging/audit-logger.js").AuditLogger,
      log: silentLog,
    });

    const result = await hooks.onPostToolUse!({
      toolName: "read-file",
      toolArgs: { path: "/tmp/x.txt" },
      toolResult: "file contents here",
      timestamp: Date.now(),
    });

    expect(result).toBeNull();
    expect(auditLogger.log).toHaveBeenCalledOnce();
    const entry = auditLogger.log.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.category).toBe("tool");
    expect(entry.event).toBe("tool_executed");
    expect((entry.details as Record<string, unknown>).toolName).toBe("read-file");
  });

  it("onPostToolUse is a no-op when no audit logger is provided", async () => {
    const hooks = createHooksConfig({ log: silentLog });

    const result = await hooks.onPostToolUse!({
      toolName: "read-file",
      toolArgs: {},
      toolResult: "ok",
    });

    expect(result).toBeNull();
  });

  it("onSessionStart logs session start", async () => {
    const hooks = createHooksConfig({ log: silentLog });

    const result = await hooks.onSessionStart!({ source: "chat" });

    expect(result).toBeNull();
    expect(silentLog.info).toHaveBeenCalledWith(
      expect.stringContaining("session started")
    );
  });

  it("onSessionEnd logs session end", async () => {
    const hooks = createHooksConfig({ log: silentLog });

    const result = await hooks.onSessionEnd!({ reason: "user_cleared" });

    expect(result).toBeNull();
    expect(silentLog.info).toHaveBeenCalledWith(
      expect.stringContaining("session ended")
    );
  });

  it("onErrorOccurred retries recoverable errors", async () => {
    const hooks = createHooksConfig({ log: silentLog });

    const result = await hooks.onErrorOccurred!({
      error: "temporary failure",
      recoverable: true,
    });

    expect(result).toEqual({ errorHandling: "retry" });
    expect(silentLog.error).toHaveBeenCalled();
  });

  it("onErrorOccurred aborts non-recoverable errors", async () => {
    const hooks = createHooksConfig({ log: silentLog });

    const result = await hooks.onErrorOccurred!({
      error: "fatal crash",
      recoverable: false,
    });

    expect(result).toEqual({ errorHandling: "abort" });
  });
});
