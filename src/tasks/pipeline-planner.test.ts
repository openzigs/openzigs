import { describe, it, expect, vi } from "vitest";
import { PipelinePlanner } from "./pipeline-planner.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

const makeMockCopilot = (response: string): CopilotWrapper => {
  return {
    chat: async function* () {
      yield response;
    },
  } as unknown as CopilotWrapper;
};

describe("PipelinePlanner", () => {
  it("generates a valid pipeline from a goal", async () => {
    const response = JSON.stringify({
      rationale: "Two-step: research then summarize",
      pipeline: {
        stages: [
          { type: "prompt", name: "research", prompt: "Research the topic", tools: null },
          { type: "prompt", name: "summarize", prompt: "Summarize findings", tools: null },
        ],
      },
    });

    const planner = new PipelinePlanner(makeMockCopilot(response));
    const result = await planner.plan("Research and summarize AI trends");

    expect(result.rationale).toBe("Two-step: research then summarize");
    expect(result.pipeline.stages).toHaveLength(2);
    expect(result.pipeline.stages[0].name).toBe("research");
    expect(result.pipeline.stages[1].name).toBe("summarize");
  });

  it("handles parallel groups in planner output", async () => {
    const response = JSON.stringify({
      rationale: "Parallel research, then merge",
      pipeline: {
        stages: [
          {
            type: "parallel",
            name: "research-phase",
            branches: [
              { type: "prompt", name: "research-web", prompt: "Search the web", tools: ["brave-search"] },
              { type: "prompt", name: "research-docs", prompt: "Read local docs", tools: ["file-read"] },
            ],
          },
          { type: "prompt", name: "synthesize", prompt: "Combine findings", tools: null },
        ],
      },
    });

    const planner = new PipelinePlanner(makeMockCopilot(response));
    const result = await planner.plan("Research from multiple sources");

    expect(result.pipeline.stages).toHaveLength(2);
    const parallel = result.pipeline.stages[0];
    expect(parallel.type).toBe("parallel");
    if (parallel.type === "parallel") {
      expect(parallel.branches).toHaveLength(2);
    }
  });

  it("handles fenced JSON code blocks", async () => {
    const response = "Here's the pipeline:\n```json\n" + JSON.stringify({
      rationale: "Simple two-stage",
      pipeline: {
        stages: [
          { type: "prompt", name: "step-1", prompt: "Do thing 1", tools: null },
          { type: "prompt", name: "step-2", prompt: "Do thing 2", tools: null },
        ],
      },
    }) + "\n```\nDone.";

    const planner = new PipelinePlanner(makeMockCopilot(response));
    const result = await planner.plan("Do two things");

    expect(result.pipeline.stages).toHaveLength(2);
  });

  it("throws on non-JSON response", async () => {
    const planner = new PipelinePlanner(makeMockCopilot("I cannot generate a pipeline."));
    await expect(planner.plan("Do something")).rejects.toThrow("did not return valid JSON");
  });

  it("throws on fewer than 2 stages", async () => {
    const response = JSON.stringify({
      rationale: "Only one step",
      pipeline: {
        stages: [
          { type: "prompt", name: "only-step", prompt: "Do everything", tools: null },
        ],
      },
    });

    const planner = new PipelinePlanner(makeMockCopilot(response));
    await expect(planner.plan("Simple task")).rejects.toThrow("at least 2 stages");
  });

  it("normalizes stages without type discriminator", async () => {
    const response = JSON.stringify({
      rationale: "Inferred types",
      pipeline: {
        stages: [
          { name: "step-1", prompt: "First step", tools: null },
          { name: "step-2", prompt: "Second step", tools: null },
        ],
      },
    });

    const planner = new PipelinePlanner(makeMockCopilot(response));
    const result = await planner.plan("Two-step task");

    expect(result.pipeline.stages[0].type).toBe("prompt");
    expect(result.pipeline.stages[1].type).toBe("prompt");
  });

  it("passes available tools context to the model", async () => {
    const chatSpy = vi.fn(async function* () {
      yield JSON.stringify({
        rationale: "Used available tools",
        pipeline: {
          stages: [
            { type: "prompt", name: "step-1", prompt: "Do thing 1", tools: ["shell-execute"] },
            { type: "prompt", name: "step-2", prompt: "Do thing 2", tools: null },
          ],
        },
      });
    });

    const mockCopilot = { chat: chatSpy } as unknown as CopilotWrapper;
    const planner = new PipelinePlanner(mockCopilot);
    await planner.plan("Build and test", { availableTools: ["shell-execute", "file-read"] });

    const callArgs = chatSpy.mock.calls[0] as unknown[];
    expect(callArgs[0]).toContain("shell-execute");
    expect(callArgs[0]).toContain("file-read");
  });

  it("uses specified model override", async () => {
    const chatSpy = vi.fn(async function* () {
      yield JSON.stringify({
        rationale: "Custom model",
        pipeline: {
          stages: [
            { type: "prompt", name: "a", prompt: "Step A", tools: null },
            { type: "prompt", name: "b", prompt: "Step B", tools: null },
          ],
        },
      });
    });

    const mockCopilot = { chat: chatSpy } as unknown as CopilotWrapper;
    const planner = new PipelinePlanner(mockCopilot);
    await planner.plan("Plan something", { model: "o4-mini" });

    const options = (chatSpy.mock.calls[0] as unknown[])[1];
    expect(options).toMatchObject({ model: "o4-mini" });
  });

  it("falls back to getUserSelectedModel when no explicit model is passed", async () => {
    // Mock getUserSelectedModel to return a specific model
    vi.mock("../config/user-model.js", () => ({
      getUserSelectedModel: vi.fn().mockResolvedValue("claude-sonnet-4"),
    }));

    // Re-import to get the mocked version
    const { PipelinePlanner: FreshPlanner } = await import("./pipeline-planner.js");

    const chatSpy = vi.fn(async function* () {
      yield JSON.stringify({
        rationale: "User model fallback",
        pipeline: {
          stages: [
            { type: "prompt", name: "a", prompt: "Step A", tools: null },
            { type: "prompt", name: "b", prompt: "Step B", tools: null },
          ],
        },
      });
    });

    const mockCopilot = { chat: chatSpy } as unknown as CopilotWrapper;
    const planner = new FreshPlanner(mockCopilot);
    await planner.plan("Plan something");

    const options = (chatSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(options.model).toBe("claude-sonnet-4");

    vi.restoreAllMocks();
  });
});
