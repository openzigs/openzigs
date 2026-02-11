import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { UserInputHandler } from "../../copilot/copilot-wrapper.js";

/**
 * MCP tool: workflow-wizard
 *
 * Presents a structured workflow preview card to the user through the
 * chat UI. The user can Confirm, Edit, or (for jobs) Test Run the
 * proposed configuration before the AI persists it.
 *
 * This tool is the bridge between the conversational wizard persona and
 * the WorkflowPreviewCard component in the frontend.
 */

const wizardSchema = z.object({
  type: z.enum(["prompt", "scheduled-job", "webhook", "agent"]),
  name: z.string().describe("Human-readable name for the configuration being created"),
  summary: z.string().describe("One-line summary of what this config does"),
  config: z.record(z.unknown()).describe("Key-value pairs to display in the preview card"),
  question: z.string().optional().describe("Optional clarifying question (default: 'Does this look right?')"),
});

/** Re-export UserInputHandler for callers that set context. */
export type WizardUserInputFn = UserInputHandler;

/**
 * Mutable wizard context — set by MessageRouter before each request
 * so that the workflow-wizard handler can present interactive preview
 * cards to the originating channel. Same pattern as activeChatContext
 * in agent-tools.ts.
 */
let activeWizardContext: {
  requestUserInput?: WizardUserInputFn;
  sessionId?: string;
} = {};

/** Set the active wizard context. Called by MessageRouter before routing. */
export const setActiveWizardContext = (ctx: {
  requestUserInput?: WizardUserInputFn;
  sessionId?: string;
}): void => {
  activeWizardContext = ctx;
};

/** Clear the active wizard context. Called by MessageRouter after routing. */
export const clearActiveWizardContext = (): void => {
  activeWizardContext = {};
};

export type WizardToolOptions = Record<string, never>;

export const createWizardTools = (_options?: WizardToolOptions): ToolDefinition[] => {
  return [
    {
      name: "workflow-wizard",
      description:
        "Present a structured workflow preview card to the user for confirmation. " +
        "Use this after gathering all the details for a prompt, scheduled job, webhook, or agent. " +
        "The user will see a preview card and can Confirm, Edit, or Test Run. " +
        "Returns the user's choice as a string: 'confirm', 'edit', or 'test-run'.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["prompt", "scheduled-job", "webhook", "agent"],
          },
          name: { type: "string" },
          summary: { type: "string" },
          config: { type: "object" },
          question: { type: "string" },
        },
        required: ["type", "name", "summary", "config"],
      },
      zodSchema: wizardSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof wizardSchema>;

        // Resolve requestUserInput from the active context (set by MessageRouter
        // before each chat call, analogous to activeChatContext for spawn-agent).
        const { requestUserInput, sessionId } = activeWizardContext;

        if (!requestUserInput) {
          // No interactive UI available (non-web channel, or context not set)
          return {
            text: JSON.stringify({
              action: "confirm",
              message: "No interactive UI available — auto-confirming.",
              preview: input,
            }),
          };
        }

        try {
          const response = await requestUserInput(
            {
              question: input.question ?? "Does this look right?",
              choices: ["confirm", "edit", "test-run"],
              allowFreeform: true,
              preview: {
                type: input.type,
                name: input.name,
                summary: input.summary,
                config: input.config,
              },
            },
            sessionId ?? "unknown"
          );

          return {
            text: JSON.stringify({
              action: response.answer || "confirm",
              wasFreeform: response.wasFreeform ?? false,
            }),
          };
        } catch {
          return {
            text: JSON.stringify({ action: "confirm", message: "User input timed out — auto-confirming." }),
          };
        }
      },
    },
  ];
};
