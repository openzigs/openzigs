import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { PersonalityManager } from "../../personality/personality-manager.js";

const getPersonalitySchema = z.object({});

const setPersonalitySchema = z.object({
  systemInstruction: z.string().optional(),
  prePrompt: z.string().optional(),
  postPrompt: z.string().optional(),
  enabled: z.boolean().optional(),
});

const resetPersonalitySchema = z.object({});

export type PersonalityToolsOptions = {
  personalityManager: PersonalityManager;
};

export const createPersonalityTools = ({ personalityManager }: PersonalityToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "get-personality",
      description: "Get the current system personality configuration including system instruction, pre-prompt, and post-prompt.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: getPersonalitySchema,
      category: "productivity",
      riskLevel: "low",
      handler: async () => {
        const config = personalityManager.getConfig();
        return { text: JSON.stringify(config) };
      },
    },
    {
      name: "set-personality",
      description: "Update the system personality configuration. Supports partial updates — only provided fields are changed.",
      inputSchema: {
        type: "object",
        properties: {
          systemInstruction: { type: "string", description: "The system instruction / persona" },
          prePrompt: { type: "string", description: "Text injected before the user message" },
          postPrompt: { type: "string", description: "Text injected after the user message" },
          enabled: { type: "boolean", description: "Enable or disable personality injection" },
        },
      },
      zodSchema: setPersonalitySchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as z.infer<typeof setPersonalitySchema>;
        try {
          const updated = personalityManager.update(input);
          return { text: JSON.stringify(updated) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: message, isError: true };
        }
      },
    },
    {
      name: "reset-personality",
      description: "Reset the system personality to its defaults.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: resetPersonalitySchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async () => {
        const config = personalityManager.reset();
        return { text: JSON.stringify(config) };
      },
    },
  ];
};
