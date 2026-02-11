import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { PromptManager } from "../../productivity/prompt-manager.js";

const createPromptSchema = z.object({
  name: z.string().min(1, "name is required"),
  content: z.string().min(1, "content is required"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  variables: z.array(z.string()).optional(),
  systemPrompt: z.boolean().optional(),
});

export type SystemConfigToolsOptions = {
  promptManager: PromptManager;
};

export const createSystemConfigTools = ({
  promptManager,
}: SystemConfigToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "create-prompt",
      description:
        "Create a new saved prompt template. Use this when the user asks to create, define, or set up a reusable prompt. The prompt can include {{variable}} placeholders for dynamic interpolation. This tool requires human approval because it creates persistent configuration.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Unique identifier for the prompt (e.g., 'daily-summary', 'code-review')",
          },
          content: {
            type: "string",
            description: "The prompt template body. Supports {{variable}} placeholders.",
          },
          description: {
            type: "string",
            description: "Optional human-readable description of what this prompt does",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for categorization (e.g., ['reporting', 'daily'])",
          },
          variables: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of declared {{variable}} names used in this template",
          },
          systemPrompt: {
            type: "boolean",
            description: "Optional flag to mark this as a system prompt template",
          },
        },
        required: ["name", "content"],
      },
      zodSchema: createPromptSchema,
      category: "productivity",
      riskLevel: "high",
      handler: async (args) => {
        const input = args as z.infer<typeof createPromptSchema>;

        // Check if a prompt with this name already exists
        const existing = promptManager.getByName(input.name);
        if (existing) {
          return {
            text: `A prompt named "${input.name}" already exists (id: ${existing.id}). Use update-prompt to modify it.`,
            isError: true,
          };
        }

        // Build tags array, adding system-prompt tag if flagged
        const tags = [...(input.tags ?? [])];
        if (input.systemPrompt && !tags.includes("system-prompt")) {
          tags.push("system-prompt");
        }

        // If variables are declared, add them as a hint in the description
        const descParts: string[] = [];
        if (input.description) {
          descParts.push(input.description);
        }
        if (input.variables?.length) {
          descParts.push(`Variables: ${input.variables.join(", ")}`);
        }

        const prompt = promptManager.create({
          name: input.name,
          template: input.content,
          description: descParts.join(" | ") || undefined,
          tags: tags.length > 0 ? tags : undefined,
        });

        return { text: JSON.stringify(prompt) };
      },
    },
  ];
};
