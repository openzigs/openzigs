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
import type { ApprovalQueue } from "../approvals/index.js";
import type { AuditLogger } from "../logging/audit-logger.js";
import { formatApprovalContext } from "../approvals/approval-formatters.js";
import { logger } from "../logging/logger.js";

export type HooksFactoryOptions = {
  toolRegistry?: ToolRegistry;
  approvalQueue?: ApprovalQueue;
  auditLogger?: AuditLogger;
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
  log = logger,
}: HooksFactoryOptions): HooksConfig => {
  return {
    onPreToolUse: async (input: HookPreToolUseInput): Promise<HookPreToolUseResult> => {
      // Gate high-risk tools through the approval queue
      if (toolRegistry?.requiresApproval(input.toolName) && approvalQueue) {
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
          channelType: "web",
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
