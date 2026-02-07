import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { PromptManager } from "../../productivity/prompt-manager.js";

const savePromptSchema = z.object({
  name: z.string(),
  template: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const getPromptSchema = z.object({
  name: z.string(),
});

const listPromptsSchema = z.object({
  query: z.string().optional(),
});

const updatePromptSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  template: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const deletePromptSchema = z.object({
  id: z.string(),
});

const runPromptSchema = z.object({
  name: z.string(),
  variables: z.record(z.string()).optional(),
});

export type PromptToolsOptions = {
  promptManager: PromptManager;
};

export const createPromptTools = ({ promptManager }: PromptToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "save-prompt",
      description: "Save a reusable prompt template with {{variable}} placeholders",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          template: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name", "template"],
      },
      zodSchema: savePromptSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof savePromptSchema>;
        const prompt = promptManager.create(input);
        return { text: JSON.stringify(prompt) };
      },
    },
    {
      name: "get-prompt",
      description: "Retrieve a saved prompt by name",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      zodSchema: getPromptSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { name } = args as z.infer<typeof getPromptSchema>;
        const prompt = promptManager.getByName(name);
        if (!prompt) {
          return { text: `Prompt not found: ${name}`, isError: true };
        }
        return { text: JSON.stringify(prompt) };
      },
    },
    {
      name: "list-prompts",
      description: "List all saved prompts, optionally filtered by search query",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      zodSchema: listPromptsSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { query } = args as z.infer<typeof listPromptsSchema>;
        const prompts = query ? promptManager.search(query) : promptManager.list();
        return { text: JSON.stringify(prompts) };
      },
    },
    {
      name: "update-prompt",
      description: "Update an existing saved prompt",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          template: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
      },
      zodSchema: updatePromptSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { id, ...rest } = args as z.infer<typeof updatePromptSchema>;
        try {
          const updated = promptManager.update(id, rest);
          return { text: JSON.stringify(updated) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: message, isError: true };
        }
      },
    },
    {
      name: "delete-prompt",
      description: "Delete a saved prompt by ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      zodSchema: deletePromptSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const { id } = args as z.infer<typeof deletePromptSchema>;
        const deleted = promptManager.delete(id);
        return { text: deleted ? "Prompt deleted" : "Prompt not found" };
      },
    },
    {
      name: "run-prompt",
      description: "Resolve a saved prompt by name with variable interpolation and return the filled text",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          variables: { type: "object" },
        },
        required: ["name"],
      },
      zodSchema: runPromptSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { name, variables } = args as z.infer<typeof runPromptSchema>;
        const result = promptManager.resolve(name, variables ?? {});
        if (result === null) {
          return { text: `Prompt not found: ${name}`, isError: true };
        }
        return { text: result };
      },
    },
  ];
};
