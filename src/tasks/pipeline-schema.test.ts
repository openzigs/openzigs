import { describe, it, expect } from "vitest";
import {
  pipelineDefinitionSchema,
  validatePipeline,
  flattenPipeline,
  normalizeLegacyStages,
} from "./pipeline-schema.js";

describe("pipelineDefinitionSchema", () => {
  it("accepts a flat list of prompt stages", () => {
    const input = {
      stages: [
        { type: "prompt", name: "step-1", prompt: "Do something" },
        { type: "prompt", name: "step-2", prompt: "Do another thing" },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts a parallel group with nested prompt stages", () => {
    const input = {
      stages: [
        {
          type: "parallel",
          name: "research-phase",
          branches: [
            { type: "prompt", name: "branch-a", prompt: "Research topic A" },
            { type: "prompt", name: "branch-b", prompt: "Research topic B" },
          ],
        },
        { type: "prompt", name: "combine", prompt: "Merge the research" },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts nested parallel groups", () => {
    const input = {
      stages: [
        {
          type: "parallel",
          name: "outer",
          branches: [
            {
              type: "parallel",
              name: "inner",
              branches: [
                { type: "prompt", name: "deep", prompt: "Deep work" },
              ],
            },
          ],
        },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects empty stages array", () => {
    const input = { stages: [] };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects empty parallel branches", () => {
    const input = {
      stages: [{ type: "parallel", name: "empty", branches: [] }],
    };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects prompt stage with missing name", () => {
    const input = {
      stages: [{ type: "prompt", name: "", prompt: "Do it" }],
    };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects prompt stage with missing prompt", () => {
    const input = {
      stages: [{ type: "prompt", name: "step-1", prompt: "" }],
    };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("accepts prompt stage with optional fields", () => {
    const input = {
      stages: [
        {
          type: "prompt",
          name: "full",
          prompt: "Work hard",
          tools: ["read-file", "web-search"],
          autoApproveTools: ["shell-execute"],
          model: "gpt-4.1",
          timeoutSeconds: 600,
          postAction: { type: "create-github-issues" },
        },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("validatePipeline", () => {
  it("validates a correct pipeline", () => {
    const result = validatePipeline({
      stages: [{ type: "prompt", name: "step-1", prompt: "Go" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects deeply nested parallel groups beyond depth limit", () => {
    // Build depth=5 nesting (limit is 4)
    let inner: unknown = { type: "prompt", name: "leaf", prompt: "work" };
    for (let i = 0; i < 6; i++) {
      inner = { type: "parallel", name: `level-${i}`, branches: [inner] };
    }
    const result = validatePipeline({ stages: [inner] });
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain("nesting exceeds");
  });

  it("returns schema error for invalid input", () => {
    const result = validatePipeline({ stages: "not-an-array" });
    expect(result.success).toBe(false);
  });
});

describe("flattenPipeline", () => {
  it("flattens a flat pipeline", () => {
    const nodes = [
      { type: "prompt" as const, name: "a", prompt: "do A" },
      { type: "prompt" as const, name: "b", prompt: "do B" },
    ];
    const flat = flattenPipeline(nodes);
    expect(flat).toHaveLength(2);
    expect(flat[0].name).toBe("a");
    expect(flat[1].name).toBe("b");
  });

  it("flattens parallel groups depth-first", () => {
    const nodes = [
      {
        type: "parallel" as const,
        name: "group",
        branches: [
          { type: "prompt" as const, name: "b1", prompt: "branch 1" },
          { type: "prompt" as const, name: "b2", prompt: "branch 2" },
        ],
      },
      { type: "prompt" as const, name: "final", prompt: "final step" },
    ];
    const flat = flattenPipeline(nodes);
    expect(flat).toHaveLength(3);
    expect(flat.map((n) => n.name)).toEqual(["b1", "b2", "final"]);
  });
});

describe("normalizeLegacyStages", () => {
  it("adds type: prompt to legacy stages", () => {
    const legacy = [
      { name: "step-1", prompt: "do the thing" },
      { name: "step-2", prompt: "do more" },
    ];
    const normalized = normalizeLegacyStages(legacy);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].type).toBe("prompt");
    expect(normalized[1].type).toBe("prompt");
    expect(normalized[0].name).toBe("step-1");
  });

  it("preserves optional fields", () => {
    const legacy = [
      {
        name: "s1",
        prompt: "go",
        tools: ["web-search"],
        model: "gpt-4.1",
        timeoutSeconds: 60,
        postAction: { type: "create-github-issues" },
      },
    ];
    const normalized = normalizeLegacyStages(legacy);
    expect(normalized[0].type).toBe("prompt");
    expect((normalized[0] as Record<string, unknown>).model).toBe("gpt-4.1");
  });
});
