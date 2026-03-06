import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { CharacterRepository } from "../../characters/character-repository.js";

const manageCharactersSchema = z.object({
  action: z.enum(["list", "get", "get_ready"]).describe("'list' all, 'get' by ID, or 'get_ready' for trained LoRA characters"),
  id: z.string().optional().describe("Character ID (required for 'get')"),
});

export type CharacterToolsOptions = {
  characterRepo: CharacterRepository;
};

export const createCharacterTools = ({ characterRepo }: CharacterToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "manage-characters",
      description:
        "Manage Character Lab LoRA identities. List available characters, check training status, get trigger words for image generation. Characters with 'ready' status have trained LoRA adapters that are auto-injected when their trigger word appears in image generation prompts.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "get_ready"] },
          id: { type: "string", description: "Character ID (required for 'get')" },
        },
        required: ["action"],
      },
      zodSchema: manageCharactersSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = manageCharactersSchema.parse(args);

          switch (input.action) {
            case "list": {
              const all = characterRepo.getAll();
              return { text: JSON.stringify({ count: all.length, characters: all }, null, 2) };
            }
            case "get": {
              if (!input.id) return { text: "Parameter 'id' is required for 'get' action.", isError: true };
              const char = characterRepo.getById(input.id);
              if (!char) return { text: `Character '${input.id}' not found.`, isError: true };
              return { text: JSON.stringify(char, null, 2) };
            }
            case "get_ready": {
              const ready = characterRepo.getByStatus("ready");
              return { text: JSON.stringify({ count: ready.length, characters: ready }, null, 2) };
            }
            default:
              return { text: `Unknown action: ${input.action}`, isError: true };
          }
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
