import { z } from "zod";

// ── Zod schemas for recursive pipeline validation ─────────────────────
// Supports two node types via discriminated union:
//   - "prompt": A single LLM stage (the existing PipelineStage shape)
//   - "parallel": A group of nodes executed concurrently via Promise.all

/** Schema for a deterministic post-action attached to a pipeline stage. */
export const pipelinePostActionSchema = z.object({
  type: z.string(),
  config: z.record(z.unknown()).optional(),
});

/** Schema for a single prompt stage (leaf node in the pipeline DAG). */
export const promptStageSchema = z.object({
  type: z.literal("prompt"),
  name: z.string().min(1, "Stage name is required"),
  prompt: z.string().min(1, "Stage prompt is required"),
  tools: z.array(z.string()).nullable().optional(),
  autoApproveTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  postAction: pipelinePostActionSchema.optional(),
});

/**
 * Recursive pipeline node: either a prompt stage or a parallel group.
 * Uses z.lazy() for the recursive reference so parallel groups can
 * contain nested prompt stages or further parallel groups.
 */
export type PromptStageNode = z.infer<typeof promptStageSchema>;
export type ParallelGroupNode = {
  type: "parallel";
  name: string;
  branches: PipelineNodeSchema[];
};
export type PipelineNodeSchema = PromptStageNode | ParallelGroupNode;

export const pipelineNodeSchema: z.ZodType<PipelineNodeSchema> = z.discriminatedUnion("type", [
  promptStageSchema,
  z.object({
    type: z.literal("parallel"),
    name: z.string().min(1, "Parallel group name is required"),
    branches: z.lazy(() => z.array(pipelineNodeSchema).min(1, "Parallel group must have at least one branch")),
  }),
]);

/** Top-level pipeline definition: an ordered list of nodes. */
export const pipelineDefinitionSchema = z.object({
  stages: z.array(pipelineNodeSchema).min(1, "Pipeline must have at least one stage"),
});

// ── Validation helpers ────────────────────────────────────────────────

/** Maximum allowed nesting depth for parallel groups. */
const MAX_PIPELINE_DEPTH = 4;

/**
 * Validate a pipeline definition, checking recursive depth limits.
 * Returns `{ success: true, data }` or `{ success: false, error }`.
 */
export const validatePipeline = (
  input: unknown
): { success: true; data: z.infer<typeof pipelineDefinitionSchema> } | { success: false; error: string } => {
  const parsed = pipelineDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return { success: false, error: firstIssue?.message ?? "Invalid pipeline definition" };
  }

  // Check recursive depth
  const depthError = checkDepth(parsed.data.stages, 0);
  if (depthError) {
    return { success: false, error: depthError };
  }

  return { success: true, data: parsed.data };
};

/** Recursively check nesting depth. Returns an error string or null. */
const checkDepth = (nodes: PipelineNodeSchema[], depth: number): string | null => {
  if (depth > MAX_PIPELINE_DEPTH) {
    return `Pipeline nesting exceeds maximum depth of ${MAX_PIPELINE_DEPTH}`;
  }
  for (const node of nodes) {
    if (node.type === "parallel") {
      const err = checkDepth(node.branches, depth + 1);
      if (err) return err;
    }
  }
  return null;
};

/**
 * Flatten a recursive pipeline into an ordered list of prompt stages
 * for backward-compatible display. Parallel branches are flattened
 * depth-first.
 */
export const flattenPipeline = (
  nodes: PipelineNodeSchema[]
): Array<z.infer<typeof promptStageSchema>> => {
  const result: Array<z.infer<typeof promptStageSchema>> = [];
  for (const node of nodes) {
    if (node.type === "prompt") {
      result.push(node);
    } else {
      result.push(...flattenPipeline(node.branches));
    }
  }
  return result;
};

/**
 * Normalize a legacy flat PipelineStage[] (without `type` discriminator)
 * into the recursive PipelineNode[] format. This ensures backward
 * compatibility with existing pipeline definitions.
 */
export const normalizeLegacyStages = (
  stages: Array<Record<string, unknown>>
): PipelineNodeSchema[] => {
  return stages.map((stage) => ({
    type: "prompt" as const,
    name: (stage.name as string) ?? "unnamed",
    prompt: (stage.prompt as string) ?? "",
    tools: (stage.tools as string[] | null) ?? undefined,
    autoApproveTools: (stage.autoApproveTools as string[]) ?? undefined,
    model: (stage.model as string) ?? undefined,
    timeoutSeconds: (stage.timeoutSeconds as number) ?? undefined,
    postAction: stage.postAction as { type: string; config?: Record<string, unknown> } | undefined,
  }));
};
