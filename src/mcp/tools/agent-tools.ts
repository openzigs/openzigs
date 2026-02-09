import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { TaskEngine } from "../../tasks/task-engine.js";

const spawnAgentSchema = z.object({
  goal: z.string().describe("What the sub-agent should accomplish"),
  context: z.string().optional().describe("Additional context or data for the sub-agent"),
  notify_user: z.boolean().optional().describe("Whether to notify the user when the task completes (default: true)"),
  model: z.string().optional().describe("Model override for the sub-agent (e.g., 'gpt-4.1', 'claude-sonnet-4')"),
  // Internal fields for recursive chaining — injected by TaskWorker's onToolCall, not set by the LLM.
  parentTaskId: z.string().optional(),
  sessionId: z.string().optional(),
});

type SpawnAgentInput = z.infer<typeof spawnAgentSchema>;

export type AgentToolsOptions = {
  taskEngine: TaskEngine;
};

/**
 * Creates the `spawn-agent` MCP tool that allows the LLM to create
 * asynchronous background sub-tasks during a conversation.
 */
export const createAgentTools = ({ taskEngine }: AgentToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "spawn-agent",
      description:
        "Spawn an asynchronous background sub-agent to handle a task independently. " +
        "Use this when a user request involves long-running work (research, analysis, report generation) " +
        "that shouldn't block the current conversation. The sub-agent will execute in the background " +
        "and the user will be notified upon completion. Returns a task ID for tracking.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What the sub-agent should accomplish" },
          context: { type: "string", description: "Additional context or data for the sub-agent" },
          notify_user: { type: "boolean", description: "Whether to notify the user when complete (default: true)" },
          model: { type: "string", description: "Model override for the sub-agent" },
        },
        required: ["goal"],
      },
      zodSchema: spawnAgentSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as SpawnAgentInput;

        try {
          const task = taskEngine.submit(
            {
              trigger: "agent",
              goal: input.goal,
              context: input.context,
              notifyOnComplete: input.notify_user ?? true,
              model: input.model,
              parentTaskId: input.parentTaskId,
              sessionId: input.sessionId,
            },
            { mode: "background" }
          );

          return {
            text: JSON.stringify({
              taskId: task.id,
              status: task.status,
              message: `Background task created: "${input.goal.slice(0, 100)}". The user will be notified when it completes.`,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `Failed to spawn agent: ${message}`, isError: true };
        }
      },
    },
  ];
};
