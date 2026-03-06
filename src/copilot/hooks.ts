import type {
  HooksConfig,
  HookPreToolUseInput,
  HookPreToolUseResult,
  HookPostToolUseInput,
  HookPostToolUseResult,
  HookSessionStartInput,
  HookSessionEndInput,
  HookErrorInput,
} from "./copilot-wrapper.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import type { ApprovalQueue, ApprovalChannel } from "../approvals/index.js";
import type { AuditLogger } from "../logging/audit-logger.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { formatApprovalContext } from "../approvals/approval-formatters.js";
import { logger } from "../logging/logger.js";

// ── Async-local auto-approve context ──────────────────────────────────
// Per-task override: tools listed here bypass approval gating entirely.
// This uses AsyncLocalStorage to ensure context is not shared between
// concurrent task executions.
const autoApproveContext = new AsyncLocalStorage<string[] | null>();

export const runWithAutoApproveContext = <T>(tools: string[] | null, fn: () => T): T => {
  return autoApproveContext.run(tools ?? null, fn);
};

export const getActiveAutoApproveTools = (): string[] | null => {
  return autoApproveContext.getStore() ?? null;
};

export type HooksFactoryOptions = {
  toolRegistry?: ToolRegistry;
  approvalQueue?: ApprovalQueue;
  auditLogger?: AuditLogger;
  sessionManager?: SessionManager;
  /** Callback returning all currently disabled native MCP tool names. */
  getDisabledNativeMcpToolNames?: () => Set<string>;
  /** For testing: inject a logger. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

/**
 * Build a `HooksConfig` that wires approval gating, audit logging,
 * and session lifecycle events into the Copilot SDK hook system.
 */
export const createHooksConfig = ({
  toolRegistry,
  approvalQueue,
  auditLogger,
  sessionManager,
  getDisabledNativeMcpToolNames,
  log = logger,
}: HooksFactoryOptions): HooksConfig => {

  /**
   * Shared helper: resolve the approval channel, format context, and submit
   * the approval request. Returns a deny result if the user rejects or the
   * request times out, or null when approval is granted.
   */
  const requestToolApproval = async (
    input: HookPreToolUseInput,
    explanation: string,
  ): Promise<HookPreToolUseResult | null> => {
    if (!approvalQueue) return null;

    let channelType: ApprovalChannel = "web";
    if (sessionManager && input.context?.sessionId) {
      try {
        const session = await sessionManager.getSession(input.context.sessionId);
        if (session?.channel) {
          channelType = session.channel as ApprovalChannel;
        }
      } catch {
        // If session lookup fails, default to web
      }
    }

    const preview = formatApprovalContext(
      input.toolName,
      input.toolArgs as Record<string, unknown>,
    );

    const approval = await approvalQueue.requestApproval({
      tool: input.toolName,
      args: input.toolArgs as Record<string, unknown>,
      riskLevel: "high",
      explanation,
      preview: preview?.summary,
      channelType,
      sessionId: input.context?.sessionId,
    });

    if (!approval.approved) {
      const reason = approval.status === "expired" ? "Approval timed out" : "User denied";
      return { permissionDecision: "deny", permissionDecisionReason: reason };
    }

    return null; // approved
  };

  return {
    onPreToolUse: async (input: HookPreToolUseInput): Promise<HookPreToolUseResult> => {
      // Priority 0: Reject disabled native MCP tools before any other checks.
      if (getDisabledNativeMcpToolNames) {
        const disabledTools = getDisabledNativeMcpToolNames();
        if (disabledTools.has(input.toolName)) {
          log.info(`Blocked disabled native MCP tool "${input.toolName}"`);
          return { permissionDecision: "deny", permissionDecisionReason: "Tool is disabled by administrator" };
        }
      }

      // Priority 1: Global approval lock — tool requires approval regardless of risk level.
      // This is checked BEFORE auto-approve so that global locks cannot be bypassed.
      if (toolRegistry?.requiresGlobalApproval(input.toolName)) {
        log.info(`Global approval lock triggered for tool "${input.toolName}"`);
        const denied = await requestToolApproval(
          input,
          "Global approval lock: this tool always requires human confirmation.",
        );
        if (denied) return denied;
        return { permissionDecision: "allow" };
      }

      // Priority 2: Per-task auto-approve override: skip approval gating entirely.
      // Check both AsyncLocalStorage (works within same async chain, e.g. task-worker)
      // and closure-captured context (survives JSON-RPC boundaries, e.g. chat sessions).
      const activeAutoApproveTools =
        getActiveAutoApproveTools() ?? input.context?.autoApproveTools ?? null;
      if (activeAutoApproveTools?.includes(input.toolName)) {
        log.info(`Auto-approved tool "${input.toolName}" (per-task override)`);
        if (auditLogger) {
          await auditLogger.log({
            level: "info",
            category: "tool",
            event: "tool_auto_approved",
            details: {
              toolName: input.toolName,
              toolArgs: input.toolArgs,
              sessionId: input.context?.sessionId,
            },
          });
        }
        return { permissionDecision: "allow" };
      }

      // Gate high-risk tools through the approval queue
      if (toolRegistry?.requiresApproval(input.toolName)) {
        const denied = await requestToolApproval(
          input,
          "High-risk tool execution requires approval.",
        );
        if (denied) return denied;
      }

      return { permissionDecision: "allow" };
    },

    onPostToolUse: async (input: HookPostToolUseInput): Promise<HookPostToolUseResult> => {
      if (auditLogger) {
        await auditLogger.log({
          level: "info",
          category: "tool",
          event: "tool_executed",
          details: {
            toolName: input.toolName,
            toolArgs: input.toolArgs,
            toolResult: typeof input.toolResult === "string"
              ? input.toolResult.slice(0, 500)
              : input.toolResult,
            timestamp: input.timestamp,
          },
        });
      }
      return null; // no modifications to the result
    },

    onSessionStart: async (input: HookSessionStartInput) => {
      log.info(`SDK session started (source=${input.source ?? "unknown"})`);
      return null;
    },

    onSessionEnd: async (input: HookSessionEndInput) => {
      log.info(`SDK session ended (reason=${input.reason ?? "unknown"})`);
      return null;
    },

    onErrorOccurred: async (input: HookErrorInput) => {
      // SDK types say `error` is string, but at runtime it can be an object
      const errStr = typeof input.error === "string" ? input.error : JSON.stringify(input.error);
      log.error(`SDK session error: ${errStr} (context=${input.errorContext ?? "none"}, recoverable=${input.recoverable ?? false})`);
      return {
        errorHandling: input.recoverable ? "retry" as const : "abort" as const,
      };
    },
  };
};
