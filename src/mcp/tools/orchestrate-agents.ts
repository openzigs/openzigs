import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { TaskEngine } from "../../tasks/task-engine.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { ChannelType } from "../../channels/types.js";
import { logger } from "../../logging/logger.js";
import { waitForTask } from "../../tasks/wait-for-task.js";
import type { TasksConfig } from "../../config/index.js";

const orchestrateAgentsSchema = z.object({
  agents: z
    .array(
      z.object({
        goal: z.string().describe("What this agent should accomplish"),
        context: z
          .string()
          .optional()
          .describe("Additional context or instructions"),
        model: z
          .string()
          .optional()
          .describe(
            "Model override for this specific agent (e.g., 'gpt-4.1', 'claude-sonnet-4')",
          ),
        auto_approve_tools: z
          .array(z.string())
          .optional()
          .describe("Tools that bypass approval gating for this agent"),
      }),
    )
    .min(1)
    .max(10)
    .describe("Array of agent definitions to dispatch"),
  aggregation_prompt: z
    .string()
    .optional()
    .describe(
      "Instructions for how to combine results. If provided, a final Copilot call synthesizes the agent outputs into a single deliverable.",
    ),
  timeout_seconds: z
    .number()
    .min(30)
    .max(600)
    .optional()
    .default(300)
    .describe("Maximum time to wait for all agents (default: 5 minutes)"),
  mode: z
    .enum(["task", "session"])
    .optional()
    .describe(
      "Orchestration mode: 'task' dispatches background tasks (default), 'session' runs all agents in a single SDK session with subagent delegation",
    ),
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
  /** When set (by MessageRouter), sub-tasks inherit this as their parentTaskId. */
  parentTaskId?: string;
  /** Model override from the originating request — sub-agents inherit this unless they specify their own. */
  model?: string;
};

export type OrchestrateAgentsOptions = {
  taskEngine: TaskEngine;
  copilot: CopilotWrapper;
  tasksConfig?: Pick<TasksConfig, "defaultOrchestrationMode">;
};

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
  tasksConfig,
}: OrchestrateAgentsOptions): ToolDefinition[] => {
  return [
    {
      name: "orchestrate-agents",
      description:
        "Dispatch multiple sub-agents and return their aggregated results. " +
        "Supports two modes: 'task' (default) fans out background tasks in parallel, " +
        "'session' composes a single prompt and delegates via SDK subagent in one session. " +
        "Use 'task' mode for true parallelism with separate sessions. " +
        "Use 'session' mode for lower API cost with SDK-native subagent delegation. " +
        "Optionally provide an aggregation_prompt to synthesize results via a Copilot call.",
      inputSchema: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                goal: {
                  type: "string",
                  description: "What this agent should accomplish",
                },
                context: {
                  type: "string",
                  description: "Additional context or instructions",
                },
                model: {
                  type: "string",
                  description: "Model override for this specific agent",
                },
                auto_approve_tools: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Tools that bypass approval gating for this agent",
                },
              },
              required: ["goal"],
            },
            description: "Array of agent definitions to dispatch (1–10)",
          },
          aggregation_prompt: {
            type: "string",
            description:
              "Instructions for combining results into a final deliverable",
          },
          timeout_seconds: {
            type: "number",
            description: "Maximum wait time in seconds (30–600, default 300)",
          },
          mode: {
            type: "string",
            enum: ["task", "session"],
            description:
              "Orchestration mode: 'task' (parallel background tasks) or 'session' (single SDK session with subagent delegation)",
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

        // Resolve effective mode from input, config, or default
        const configMode = tasksConfig?.defaultOrchestrationMode;
        const effectiveMode = input.mode ?? configMode ?? "task";

        if (effectiveMode === "session") {
          return handleSessionMode(input, copilot, taskEngine, startTime);
        }

        return handleTaskMode(input, taskEngine, copilot, startTime);
      },
    },
  ];
};

/**
 * Session mode: compose a single prompt from all agent goals and run via
 * copilot.chat() with enableSubagents: true. Lower API cost, sequential execution.
 */
async function handleSessionMode(
  input: OrchestrateAgentsInput,
  copilot: CopilotWrapper,
  taskEngine: TaskEngine,
  startTime: number,
): Promise<{ text: string; isError?: boolean }> {
  try {
    const sessionId = input.sessionId ?? activeOrchestrateContext.sessionId;
    const channelType =
      (input.channelType as ChannelType | undefined) ??
      activeOrchestrateContext.channelType;
    const chatId = input.chatId ?? activeOrchestrateContext.chatId;
    const contextParentTaskId =
      input.parentTaskId ?? activeOrchestrateContext.parentTaskId;

    logger.info(
      `orchestrate-agents [session mode]: composing prompt for ${input.agents.length} agents`,
    );

    // Build composed prompt
    const taskSections = input.agents.map((agent, i) => {
      let section = `## Task ${i + 1}: ${agent.goal}`;
      if (agent.context) section += `\n${agent.context}`;
      return section;
    });

    const composedPrompt = [
      "You are an orchestrator coordinating multiple analysis tasks.",
      "Complete each task sequentially, using the most appropriate specialist approach for each.",
      "",
      ...taskSections,
      "",
      ...(input.aggregation_prompt ? [input.aggregation_prompt] : []),
    ].join("\n");

    // Get custom agents from the wrapper for SDK subagent delegation
    const customAgents = copilot.getCustomAgents();

    // Call copilot.chat() once with enableSubagents
    const aggModel = activeOrchestrateContext.model;
    let fullResponse = "";
    for await (const chunk of copilot.chat(composedPrompt, {
      enableSubagents: true,
      tools: [],
      ...(customAgents.length > 0 ? { customAgents } : {}),
      ...(aggModel ? { model: aggModel } : {}),
    })) {
      fullResponse += chunk;
    }

    const elapsedMs = Date.now() - startTime;

    // Create and immediately complete an orchestration parent task for tracking/UI
    const orchestrationGoal = `[session] Orchestrate ${input.agents.length} agents: ${input.agents.map((a) => a.goal.slice(0, 50)).join("; ")}`;
    const orchestrationTask = taskEngine.submit(
      {
        trigger: "agent",
        goal: orchestrationGoal,
        notifyOnComplete: !contextParentTaskId,
        parentTaskId: contextParentTaskId,
        sessionId,
        channelType,
        chatId,
      },
      { mode: "immediate" },
    );

    const summary = `Session orchestration complete: ${input.agents.length} tasks in ${Math.round(elapsedMs / 1000)}s`;
    taskEngine.complete(orchestrationTask.id, summary);

    logger.info(`orchestrate-agents [session mode]: done in ${elapsedMs}ms`);

    const agentResults = input.agents.map((agent) => ({
      goal: agent.goal,
      status: "completed" as const,
      result: fullResponse,
      error: undefined,
    }));

    return {
      text: JSON.stringify(
        {
          aggregated_result: fullResponse,
          metadata: {
            mode: "session",
            total: input.agents.length,
            completed: input.agents.length,
            failed: 0,
            cancelled: 0,
            elapsed_ms: elapsedMs,
            results: agentResults,
          },
        },
        null,
        2,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`orchestrate-agents [session mode]: ${message}`);
    return { text: `Session orchestration failed: ${message}`, isError: true };
  }
}

/**
 * Task mode (original): fan-out background tasks, wait for all, optionally aggregate.
 */
async function handleTaskMode(
  input: OrchestrateAgentsInput,
  taskEngine: TaskEngine,
  copilot: CopilotWrapper,
  startTime: number,
): Promise<{ text: string; isError?: boolean }> {
  const controller = new AbortController();
  const timeoutMs = (input.timeout_seconds ?? 300) * 1_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Resolve context
    const sessionId = input.sessionId ?? activeOrchestrateContext.sessionId;
    const channelType =
      (input.channelType as ChannelType | undefined) ??
      activeOrchestrateContext.channelType;
    const chatId = input.chatId ?? activeOrchestrateContext.chatId;
    const contextParentTaskId =
      input.parentTaskId ?? activeOrchestrateContext.parentTaskId;

    logger.info(
      `orchestrate-agents [task mode]: dispatching ${input.agents.length} agents (timeout=${input.timeout_seconds ?? 300}s)`,
    );

    // ── Create orchestration parent task ──
    const orchestrationGoal = `Orchestrate ${input.agents.length} agents: ${input.agents.map((a) => a.goal.slice(0, 50)).join("; ")}`;
    const orchestrationTask = taskEngine.submit(
      {
        trigger: "agent",
        goal: orchestrationGoal,
        notifyOnComplete: !contextParentTaskId,
        parentTaskId: contextParentTaskId,
        sessionId,
        channelType,
        chatId,
      },
      { mode: "immediate" },
    );

    // ── Fan-Out: submit all tasks as children of the orchestration parent ──
    const tasks = input.agents.map((agent) =>
      taskEngine.submit(
        {
          trigger: "agent",
          goal: agent.goal,
          context: agent.context,
          model: agent.model ?? activeOrchestrateContext.model,
          autoApproveTools: agent.auto_approve_tools,
          notifyOnComplete: false,
          parentTaskId: orchestrationTask.id,
          sessionId,
          channelType,
          chatId,
        },
        { mode: "background" },
      ),
    );

    // ── Fan-In: wait for all completions ──
    const completions = await Promise.allSettled(
      tasks.map((task) => waitForTask(taskEngine, task.id, controller.signal)),
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
        error:
          settlement.reason instanceof Error
            ? settlement.reason.message
            : String(settlement.reason),
      };
    });

    const completed = agentResults.filter(
      (r) => r.status === "completed",
    ).length;
    const failed = agentResults.filter((r) => r.status === "failed").length;
    const cancelled = agentResults.filter(
      (r) => r.status === "cancelled",
    ).length;

    const summary = `Orchestration complete: ${completed}/${input.agents.length} agents succeeded in ${Math.round(elapsedMs / 1000)}s`;

    logger.info(
      `orchestrate-agents [task mode]: done in ${elapsedMs}ms — ${completed} completed, ${failed} failed, ${cancelled} cancelled`,
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
    let finalText: string;
    if (input.aggregation_prompt && agentResults.some((r) => r.result)) {
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

      const aggModel = activeOrchestrateContext.model;
      let aggregated = "";
      for await (const chunk of copilot.chat(prompt, {
        tools: [],
        ...(aggModel ? { model: aggModel } : {}),
      })) {
        aggregated += chunk;
      }

      finalText = JSON.stringify(
        {
          aggregated_result: aggregated,
          metadata,
        },
        null,
        2,
      );
    } else {
      // No aggregation — return raw results
      finalText = JSON.stringify(
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
        2,
      );
    }

    // ── Complete the orchestration parent task ──
    taskEngine.complete(orchestrationTask.id, summary);

    return { text: finalText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`orchestrate-agents [task mode]: ${message}`);
    return { text: `Orchestration failed: ${message}`, isError: true };
  } finally {
    clearTimeout(timer);
  }
}
