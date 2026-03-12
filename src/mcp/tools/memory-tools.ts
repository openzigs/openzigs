/**
 * Memory tools — let the LLM save and recall persistent facts during conversations.
 *
 * `save-memory`    — Store a fact, preference, or convention for future sessions.
 * `recall-memories` — Search stored memories by category or keyword.
 *
 * The LLM proactively calls `save-memory` when it discovers important information
 * about the user's preferences, workflows, or context. This mirrors how GitHub's
 * native Copilot Memory works — the model decides what's worth remembering.
 *
 * @module mcp/tools/memory-tools
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { MemoryManager, MemoryCategory } from "../../memory/memory-manager.js";
import { MEMORY_CATEGORIES } from "../../memory/memory-manager.js";

// ── Schemas ────────────────────────────────────────────────────────────

const saveMemorySchema = z.object({
  category: z
    .enum(["conventions", "patterns", "decisions", "preferences", "context"])
    .describe(
      "Category for the memory: conventions (naming rules, format standards), " +
      "patterns (recurring workflows, integration patterns), " +
      "decisions (technology choices, architecture trade-offs), " +
      "preferences (user likes/dislikes, style choices, scheduling habits), " +
      "context (project info, account details, domain knowledge).",
    ),
  title: z
    .string()
    .min(1)
    .max(120)
    .describe("Short, descriptive title for the memory (e.g. 'YouTube channel name', 'Preferred video format')."),
  content: z
    .string()
    .min(1)
    .max(2000)
    .describe("The fact, preference, or convention to remember. Be specific and concise."),
});

const recallMemoriesSchema = z.object({
  category: z
    .enum(["conventions", "patterns", "decisions", "preferences", "context"])
    .optional()
    .describe("Filter memories by category. Omit to search all categories."),
  query: z
    .string()
    .optional()
    .describe("Keyword to search memory titles and content (case-insensitive substring match). Omit to list all."),
});

type SaveMemoryInput = z.infer<typeof saveMemorySchema>;
type RecallMemoriesInput = z.infer<typeof recallMemoriesSchema>;

// ── Factory ────────────────────────────────────────────────────────────

export type MemoryToolsOptions = {
  memoryManager: MemoryManager;
};

export const createMemoryTools = ({ memoryManager }: MemoryToolsOptions): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  // ── save-memory ──────────────────────────────────────────────────────

  tools.push({
    name: "save-memory",
    description:
      "Save an important fact, user preference, workflow convention, or project context " +
      "to persistent memory. Saved memories are automatically injected into future " +
      "sessions so the AI remembers across conversations. Use this proactively when " +
      "you discover information worth remembering — account names, preferred formats, " +
      "scheduling habits, brand guidelines, technology choices, etc.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...MEMORY_CATEGORIES],
          description:
            "Category: conventions, patterns, decisions, preferences, or context.",
        },
        title: {
          type: "string",
          description: "Short, descriptive title for the memory.",
        },
        content: {
          type: "string",
          description: "The fact or preference to remember. Be specific and concise.",
        },
      },
      required: ["category", "title", "content"],
    },
    zodSchema: saveMemorySchema,
    category: "productivity",
    riskLevel: "low",
    handler: async (args) => {
      const config = memoryManager.getConfig();
      if (!config.enabled) {
        return {
          text: "Agent Memory is disabled. Enable it from Admin → Agent Memory before saving memories.",
          isError: true,
        };
      }

      if (!config.owner) {
        return {
          text: "Agent Memory repository has not been set up yet. Complete setup from Admin → Agent Memory.",
          isError: true,
        };
      }

      const { category, title, content } = args as SaveMemoryInput;

      // Check for duplicates — avoid saving the same fact twice
      try {
        const existing = await memoryManager.listMemories();
        const duplicate = existing.find(
          (m) =>
            m.category === category &&
            m.title.toLowerCase() === title.toLowerCase(),
        );
        if (duplicate) {
          // Update existing memory instead of creating a duplicate
          const updated = await memoryManager.updateMemory(duplicate.id, { content });
          return {
            text: JSON.stringify({
              action: "updated",
              id: updated.id,
              category: updated.category,
              title: updated.title,
              message: `Updated existing memory "${title}" with new content.`,
            }),
          };
        }
      } catch {
        // If list fails, proceed with creation anyway
      }

      try {
        const memory = await memoryManager.createMemory({
          category: category as MemoryCategory,
          title,
          content,
        });

        return {
          text: JSON.stringify({
            action: "created",
            id: memory.id,
            category: memory.category,
            title: memory.title,
            message: `Saved memory "${title}" in ${category}. This will be available in future sessions.`,
          }),
        };
      } catch (err) {
        return {
          text: `Failed to save memory: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });

  // ── recall-memories ──────────────────────────────────────────────────

  tools.push({
    name: "recall-memories",
    description:
      "Search or list stored memories from previous sessions. Use this to check " +
      "what the agent already knows about the user's preferences, conventions, " +
      "project context, or past decisions. Filter by category or keyword.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...MEMORY_CATEGORIES],
          description: "Filter by category. Omit to search all.",
        },
        query: {
          type: "string",
          description: "Keyword to search titles and content (case-insensitive). Omit to list all.",
        },
      },
    },
    zodSchema: recallMemoriesSchema,
    category: "productivity",
    riskLevel: "low",
    handler: async (args) => {
      const config = memoryManager.getConfig();
      if (!config.enabled) {
        return {
          text: JSON.stringify({ memories: [], message: "Agent Memory is disabled." }),
        };
      }

      if (!config.owner) {
        return {
          text: JSON.stringify({ memories: [], message: "Agent Memory repository not set up." }),
        };
      }

      const { category, query } = args as RecallMemoriesInput;

      try {
        let memories = await memoryManager.listMemories();

        if (category) {
          memories = memories.filter((m) => m.category === category);
        }

        if (query) {
          const needle = query.toLowerCase();
          memories = memories.filter(
            (m) =>
              m.title.toLowerCase().includes(needle) ||
              m.content.toLowerCase().includes(needle),
          );
        }

        return {
          text: JSON.stringify({
            count: memories.length,
            memories: memories.map((m) => ({
              id: m.id,
              category: m.category,
              title: m.title,
              content: m.content,
              updatedAt: m.updatedAt,
            })),
          }),
        };
      } catch (err) {
        return {
          text: `Failed to recall memories: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });

  return tools;
};
