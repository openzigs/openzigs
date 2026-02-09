import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { TaskEngine } from "../../tasks/task-engine.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { AgentTask } from "../../tasks/types.js";
import type { ChannelType } from "../../channels/types.js";
import { logger } from "../../logging/logger.js";

const orchestrateAgentsSchema = z.object({
  agents: z
    .array(
      z.object({
        goal: z.string().describe("What this agent should accomplish"),
        context: z.string().optional().describe("Additional context or instructions"),
      })
    )
    .min(1)
    .max(10)
    .describe("Array of agent definitions to dispatch"),
  aggregation_prompt: z
    .string()
    .optional()
    .describe(
      "Instructions for how to combine results. If provided, a final Copilot call synthesizes the agent outputs into a single deliverable."
    ),
  timeout_seconds: z
    .number()
    .min(30)
    .max(600)
    .optional()
    .default(300)
    .describe("Maximum time to wait for all agents (default: 5 minutes)"),
  // Internal fields injected by TaskWorker — not set by the LLM.
  parentTaskId: z.string().optional(),
  sessionId: z.string().optional(),
  channelType: z.string().optional(),
  chatId: z.string().optional(),
});

type OrchestrateAgentsInput = z.infer<typeof orchestrateAgentsSchema>;

/** Chat context injected by MessageRouter. */
export type OrchestrateContext = {
  sessionId?: string;
  channelType?: ChannelType;
  chatId?: string;
};

export type OrchestrateAgentsOptions = {
  taskEngine: TaskEngine;
  copilot: CopilotWrapper;
};

/**
 * Wait for a specific task to reach a terminal state.
 *
 * Uses a listener + re-check pattern to avoid race conditions:
 * 1. Check if already completed
 * 2. Attach listeners
 * 3. Re-check (task may have completed between step 1 and 2)
 */
const waitForTask = (
  engine: TaskEngine,
  taskId: string,
  signal: AbortSignal
): Promise<AgentTask> => {
  // Fast path: already in terminal state
  const existing = engine.getTask(taskId);
  if (existing && isTerminal(existing.status)) {
    return Promise.resolve(existing);
  }

  return new Promise<AgentTask>((resolve, reject) => {
    const onComplete = (task: AgentTask) => {
      if (task.id === taskId) {
        cleanup();
        resolve(task);
      }
    };
    const onFail = (task: AgentTask) => {
      if (task.id === taskId) {
        cleanup();
        resolve(task); // Resolve (not reject) — we handle failures in aggregation
      }
    };
    const onCancel = (task: AgentTask) => {
      if (task.id === taskId) {
        cleanup();
        resolve(task);
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new Error(`Timeout waiting for task ${taskId}`));
    };

    const cleanup = () => {
      engine.off("task:completed", onComplete);
      engine.off("task:failed", onFail);
      engine.off("task:cancelled", onCancel);
      signal.removeEventListener("abort", onAbort);
    };

    engine.on("task:completed", onComplete);
    engine.on("task:failed", onFail);
    engine.on("task:cancelled", onCancel);
    signal.addEventListener("abort", onAbort, { once: true });

    // Re-check after attaching listeners (race condition guard)
    const recheck = engine.getTask(taskId);
    if (recheck && isTerminal(recheck.status)) {
      cleanup();
      resolve(recheck);
    }
  });
};

const isTerminal = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

/**
 * Module-level mutable context — set by MessageRouter before each request
 * so that orchestrated tasks inherit the originating session/channel info.
 */
let activeOrchestrateContext: OrchestrateContext = {};

/** Set the active orchestrate context. Called by MessageRouter before routing. */
export const setActiveOrchestrateContext = (ctx: OrchestrateContext): void => {
  activeOrchestrateContext = ctx;
};

/** Clear the active orchestrate context. Called by MessageRouter after routing. */
export const clearActiveOrchestrateContext = (): void => {
  activeOrchestrateContext = {};
};

/**
 * Creates the `orchestrate-agents` MCP tool that dispatches multiple agents
 * concurrently, waits for all to complete, and optionally aggregates results.
 */
export const createOrchestrateAgentsTools = ({
  taskEngine,
  copilot,
}: OrchestrateAgentsOptions): ToolDefinition[] => {
  return [
    {
      name: "orchestrate-agents",
      description:
        "Dispatch multiple background sub-agents in parallel, wait for all to complete, " +
        "and return their aggregated results. Use this for workflows that require " +
        "fan-out / fan-in patterns: parallel research, multi-source analysis, or any task " +
        "where you need results from several agents before producing a final deliverable. " +
        "Optionally provide an aggregation_prompt to synthesize results via a Copilot call.",
      inputSchema: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                goal: { type: "string", description: "What this agent should accomplish" },
                context: { type: "string", description: "Additional context or instructions" },
              },
              required: ["goal"],
            },
            description: "Array of agent definitions to dispatch (1–10)",
          },
          aggregation_prompt: {
            type: "string",
            description: "Instructions for combining results into a final deliverable",
          },
          timeout_seconds: {
            type: "number",
            description: "Maximum wait time in seconds (30–600, default 300)",
          },
        },
        required: ["agents"],
      },
      zodSchema: orchestrateAgentsSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as OrchestrateAgentsInput;
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutMs = (input.timeout_seconds ?? 300) * 1_000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          // Resolve context
          const sessionId = input.sessionId ?? activeOrchestrateContext.sessionId;
          const channelType =
            (input.channelType as ChannelType | undefined) ?? activeOrchestrateContext.channelType;
          const chatId = input.chatId ?? activeOrchestrateContext.chatId;

          logger.info(
            `orchestrate-agents: dispatching ${input.agents.length} agents (timeout=${input.timeout_seconds ?? 300}s)`
          );

          // ── Fan-Out: submit all tasks ──
          const tasks = input.agents.map((agent) =>
            taskEngine.submit(
              {
                trigger: "agent",
                goal: agent.goal,
                context: agent.context,
                notifyOnComplete: false, // Orchestrator handles notification
                parentTaskId: input.parentTaskId,
                sessionId,
                channelType,
                chatId,
              },
              { mode: "background" }
            )
          );

          // ── Fan-In: wait for all completions ──
          const completions = await Promise.allSettled(
            tasks.map((task) => waitForTask(taskEngine, task.id, controller.signal))
          );

          const elapsedMs = Date.now() - startTime;

          // ── Build result summary ──
          const agentResults = completions.map((settlement, i) => {
            if (settlement.status === "fulfilled") {
              const task = settlement.value;
              return {
                taskId: tasks[i].id,
                goal: input.agents[i].goal,
                status: task.status as string,
                result: task.result ?? undefined,
                error: task.error ?? undefined,
              };
            }
            return {
              taskId: tasks[i].id,
              goal: input.agents[i].goal,
              status: "failed" as const,
              result: undefined,
              error: settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason),
            };
          });

          const completed = agentResults.filter((r) => r.status === "completed").length;
          const failed = agentResults.filter((r) => r.status === "failed").length;
          const cancelled = agentResults.filter(
            (r) => r.status === "cancelled"
          ).length;

          logger.info(
            `orchestrate-agents: done in ${elapsedMs}ms — ${completed} completed, ${failed} failed, ${cancelled} cancelled`
          );

          const metadata = {
            total: input.agents.length,
            completed,
            failed,
            cancelled,
            elapsed_ms: elapsedMs,
            results: agentResults,
          };

          // ── Optional Aggregation via Copilot ──
          if (
            input.aggregation_prompt &&
            agentResults.some((r) => r.result)
          ) {
            const aggregationInput = agentResults
              .filter((r) => r.result)
              .map((r, i) => `### Agent ${i + 1}: ${r.goal}\n${r.result}`)
              .join("\n\n---\n\n");

            const prompt = [
              input.aggregation_prompt,
              "",
              "Below are the results from the parallel agents:",
              "",
              aggregationInput,
            ].join("\n");

            let aggregated = "";
            for await (const chunk of copilot.chat(prompt, { tools: [] })) {
              aggregated += chunk;
            }

            return {
              text: JSON.stringify(
                {
                  aggregated_result: aggregated,
                  metadata,
                },
                null,
                2
              ),
            };
          }

          // No aggregation — return raw results
          return {
            text: JSON.stringify(
              {
                results: agentResults.map((r) => ({
                  goal: r.goal,
                  status: r.status,
                  result: r.result,
                  error: r.error,
                })),
                metadata,
              },
              null,
              2
            ),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`orchestrate-agents: ${message}`);
          return { text: `Orchestration failed: ${message}`, isError: true };
        } finally {
          clearTimeout(timer);
        }
      },
    },
  ];
};
