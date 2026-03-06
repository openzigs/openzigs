import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrandVoiceService } from "../../personality/brand-voice-service.js";

const manageBrandVoiceSchema = z.object({
  action: z.enum(["list", "get", "get_active", "analyze_and_save", "set_active", "deactivate_all", "delete"]),
  id: z.string().optional().describe("Brand voice ID (for get/set_active/delete)"),
  name: z.string().optional().describe("Name for new brand voice (for analyze_and_save)"),
  samples: z.array(z.string()).optional().describe("Writing samples to analyze (for analyze_and_save)"),
  model: z.string().optional().describe("LLM model override for analysis"),
});

export type BrandVoiceToolsOptions = {
  brandVoiceService: BrandVoiceService;
};

export const createBrandVoiceTools = ({ brandVoiceService }: BrandVoiceToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "manage-brand-voice",
      description:
        "Manage brand voice profiles. Analyze writing samples via LLM to extract tone, vocabulary, and style rules. Set an active voice that gets injected into all LLM outputs.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "get_active", "analyze_and_save", "set_active", "deactivate_all", "delete"] },
          id: { type: "string" },
          name: { type: "string" },
          samples: { type: "array", items: { type: "string" } },
          model: { type: "string" },
        },
        required: ["action"],
      },
      zodSchema: manageBrandVoiceSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = manageBrandVoiceSchema.parse(args);

          switch (input.action) {
            case "list":
              return { text: JSON.stringify(brandVoiceService.getAll(), null, 2) };
            case "get": {
              if (!input.id) return { text: "'id' is required for 'get'.", isError: true };
              const voice = brandVoiceService.getById(input.id);
              if (!voice) return { text: `Brand voice '${input.id}' not found.`, isError: true };
              return { text: JSON.stringify(voice, null, 2) };
            }
            case "get_active": {
              const active = brandVoiceService.getActive();
              if (!active) return { text: "No active brand voice is set." };
              return { text: JSON.stringify(active, null, 2) };
            }
            case "analyze_and_save": {
              if (!input.name || !input.samples?.length) {
                return { text: "'name' and 'samples' (non-empty array) are required.", isError: true };
              }
              const voice = await brandVoiceService.analyzeAndSave(input.name, input.samples, {
                model: input.model,
              });
              return { text: JSON.stringify(voice, null, 2) };
            }
            case "set_active": {
              if (!input.id) return { text: "'id' is required for 'set_active'.", isError: true };
              const result = brandVoiceService.setActive(input.id);
              if (!result) return { text: `Brand voice '${input.id}' not found.`, isError: true };
              return { text: JSON.stringify(result, null, 2) };
            }
            case "deactivate_all":
              brandVoiceService.deactivateAll();
              return { text: "All brand voices deactivated." };
            case "delete": {
              if (!input.id) return { text: "'id' is required for 'delete'.", isError: true };
              const deleted = brandVoiceService.delete(input.id);
              if (!deleted) return { text: `Brand voice '${input.id}' not found.`, isError: true };
              return { text: `Brand voice '${input.id}' deleted.` };
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
