import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { PipelineNode, PipelineDefinition } from "./types.js";
import { validatePipeline } from "./pipeline-schema.js";
import { getUserSelectedModel } from "../config/user-model.js";

export type PlannerResult = {
  /** The generated pipeline definition. */
  pipeline: PipelineDefinition;
  /** Brief rationale for the chosen structure. */
  rationale: string;
};

export type PlannerOptions = {
  /** Available tool names the planner can reference. */
  availableTools?: string[];
  /** Model to use for planning (defaults to gpt-5-mini). */
  model?: string;
};

const PLANNER_SYSTEM_PROMPT = `You are a pipeline planner for OpenZigs, an AI agent platform.
Given a user's goal, design a multi-stage pipeline that breaks the task into sequential and/or parallel steps.

Return ONLY valid JSON with this structure:
{
  "rationale": "Brief explanation of why you chose this pipeline structure",
  "pipeline": {
    "stages": [
      {
        "type": "prompt",
        "name": "stage-name",
        "prompt": "Detailed prompt for this stage",
        "tools": ["tool-name-1", "tool-name-2"] or null,
        "model": null,
        "timeoutSeconds": 300
      },
      {
        "type": "parallel",
        "name": "parallel-group-name",
        "branches": [
          { "type": "prompt", "name": "branch-1", "prompt": "...", "tools": null },
          { "type": "prompt", "name": "branch-2", "prompt": "...", "tools": null }
        ]
      }
    ]
  }
}

Rules:
1. Each stage "type" must be "prompt" (single LLM task) or "parallel" (concurrent branches).
2. Use "parallel" groups ONLY when branches are truly independent.
3. Prompt stages run sequentially; each receives the output of all prior stages as context.
4. Pipeline must have at least 2 stages — otherwise a single task suffices.
5. Keep pipelines flat when possible (max 2 levels of nesting).
6. Stage names must be lowercase-kebab-case (e.g., "research-topic", "write-report").
7. Tools array should be null (all tools) unless the stage genuinely needs restriction.
8. timeoutSeconds defaults to 300 — increase only for heavy tasks.
9. "model" should be null unless a specific model capability is needed.`;

/**
 * Extract JSON from a model response that may contain fenced code blocks or prose.
 */
const extractJsonBlock = (text: string): string | null => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1).trim();
  }
  return null;
};

/**
 * Normalize raw planner output into typed PipelineNode[].
 * Adds missing `type: "prompt"` discriminators and validates structure.
 */
const normalizeNodes = (rawStages: unknown[]): PipelineNode[] => {
  return rawStages.map((raw) => {
    const node = raw as Record<string, unknown>;
    if (node.type === "parallel") {
      return {
        type: "parallel" as const,
        name: String(node.name ?? "parallel-group"),
        branches: Array.isArray(node.branches)
          ? normalizeNodes(node.branches)
          : [],
      };
    }
    return {
      type: "prompt" as const,
      name: String(node.name ?? "unnamed-stage"),
      prompt: String(node.prompt ?? ""),
      tools: node.tools === null ? null : (Array.isArray(node.tools) ? node.tools as string[] : null),
      model: typeof node.model === "string" ? node.model : undefined,
      timeoutSeconds: typeof node.timeoutSeconds === "number" ? node.timeoutSeconds : 300,
    };
  });
};

/**
 * PipelinePlanner: uses a lightweight LLM call to generate a multi-stage
 * pipeline definition from a natural language goal description.
 */
export class PipelinePlanner {
  private copilot: CopilotWrapper;

  constructor(copilot: CopilotWrapper) {
    this.copilot = copilot;
  }

  /**
   * Generate a pipeline definition from a natural language goal.
   *
   * @param goal - The user's high-level task description.
   * @param options - Optional planner configuration.
   * @returns The generated pipeline and rationale.
   * @throws If the model fails to produce valid JSON or the pipeline is invalid.
   */
  async plan(goal: string, options?: PlannerOptions): Promise<PlannerResult> {
    const toolContext = options?.availableTools?.length
      ? `\nAvailable tools: ${options.availableTools.join(", ")}`
      : "";

    const prompt = `${PLANNER_SYSTEM_PROMPT}${toolContext}\n\nUser goal:\n${goal}`;

    let response = "";
    const plannerModel = options?.model ?? await getUserSelectedModel();
    for await (const chunk of this.copilot.chat(prompt, {
      ...(plannerModel ? { model: plannerModel } : {}),
      tools: [],
    })) {
      response += chunk;
    }

    const jsonText = extractJsonBlock(response);
    if (!jsonText) {
      throw new Error(`Pipeline planner did not return valid JSON. Raw response: ${response.slice(0, 500)}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Pipeline planner returned invalid JSON: ${detail}`);
    }

    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
    const pipelineRaw = parsed.pipeline as Record<string, unknown> | undefined;
    const rawStages = pipelineRaw?.stages;

    if (!Array.isArray(rawStages) || rawStages.length < 2) {
      throw new Error(
        "Pipeline planner must produce at least 2 stages. " +
        "For single-step tasks, use a regular task instead."
      );
    }

    const nodes = normalizeNodes(rawStages);
    const pipeline: PipelineDefinition = { stages: nodes };

    // Validate the generated pipeline against the schema
    const validation = validatePipeline(pipeline);
    if (!validation.success) {
      throw new Error(
        `Pipeline planner generated an invalid pipeline: ${validation.error}`
      );
    }

    return { pipeline, rationale };
  }
}
