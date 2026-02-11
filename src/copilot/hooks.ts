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
  log = logger,
}: HooksFactoryOptions): HooksConfig => {
  return {
    onPreToolUse: async (input: HookPreToolUseInput): Promise<HookPreToolUseResult> => {
      // Per-task auto-approve override: skip approval gating entirely
      const activeAutoApproveTools = getActiveAutoApproveTools();
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
      if (toolRegistry?.requiresApproval(input.toolName) && approvalQueue) {
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
          input.toolArgs as Record<string, unknown>
        );
        const approval = await approvalQueue.requestApproval({
          tool: input.toolName,
          args: input.toolArgs as Record<string, unknown>,
          riskLevel: "high",
          explanation: "High-risk tool execution requires approval.",
          preview: preview?.summary,
          channelType,
          sessionId: input.context?.sessionId,
        });


        if (!approval.approved) {
          const reason = approval.status === "expired"
            ? "Approval timed out"
            : "User denied";
          return {
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          };
        }
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
      log.error(`SDK session error: ${input.error} (context=${input.errorContext ?? "none"}, recoverable=${input.recoverable ?? false})`);
      return {
        errorHandling: input.recoverable ? "retry" as const : "abort" as const,
      };
    },
  };
};
