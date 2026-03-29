import { z } from "zod";

// ── Zod Schemas ───────────────────────────────────────────────────────

export const StageAgentSchema = z.object({
  archetype: z.string().min(1),
  goal: z.string().min(1),
  model: z.string().nullable().default(null),
  allowedTools: z.array(z.string()).default([]),
  autoApproveTools: z.array(z.string()).default([]),
});

export const OrchestrationStageSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["parallel", "sequential"]),
  agents: z.array(StageAgentSchema).min(1),
  dependsOn: z.array(z.string()).default([]),
});

export const TemplateVariableSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  required: z.boolean().default(true),
  defaultValue: z.string().nullable().default(null),
});

export const TemplateCategorySchema = z.enum([
  "research",
  "analysis",
  "content",
  "dev",
  "custom",
]);

export const OrchestrationModeSchema = z.enum(["task", "session"]);

export const CreateOrchestrationTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().default(""),
  category: TemplateCategorySchema.default("custom"),
  stages: z.array(OrchestrationStageSchema).min(1),
  variables: z.array(TemplateVariableSchema).default([]),
  aggregationPrompt: z.string().nullable().default(null),
  defaultMode: OrchestrationModeSchema.optional(),
});

export const UpdateOrchestrationTemplateSchema =
  CreateOrchestrationTemplateSchema.partial();

export const ExecuteTemplateSchema = z.object({
  variables: z.record(z.string()).default({}),
  sessionId: z.string().optional(),
  model: z.string().optional(),
  mode: OrchestrationModeSchema.optional(),
});

// ── TypeScript types ──────────────────────────────────────────────────

export type StageAgent = z.infer<typeof StageAgentSchema>;
export type OrchestrationStage = z.infer<typeof OrchestrationStageSchema>;
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;
export type TemplateCategory = z.infer<typeof TemplateCategorySchema>;

export type OrchestrationMode = z.infer<typeof OrchestrationModeSchema>;

export interface OrchestrationTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  stages: OrchestrationStage[];
  variables: TemplateVariable[];
  aggregationPrompt: string | null;
  defaultMode?: OrchestrationMode;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateOrchestrationTemplateInput = z.infer<typeof CreateOrchestrationTemplateSchema>;
export type UpdateOrchestrationTemplateInput = z.infer<typeof UpdateOrchestrationTemplateSchema>;
export type ExecuteTemplateInput = z.infer<typeof ExecuteTemplateSchema>;

/** Thrown when a template ID is not found, enabling typed 404 handling. */
export class TemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Template not found: ${id}`);
    this.name = "TemplateNotFoundError";
  }
}

/** SQLite row shape. */
export interface StoredOrchestrationTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  stages_json: string;
  variables_json: string;
  aggregation_prompt: string | null;
  default_mode: string | null;
  is_built_in: number;
  created_at: string;
  updated_at: string;
}
