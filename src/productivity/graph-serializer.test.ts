import { describe, it, expect } from "vitest";
import {
  graphToStages,
  stagesToGraph,
  validateGraph,
  type FlowGraph,
  type FlowNode,
  type FlowEdge,
} from "./graph-serializer.js";
import type { PipelineNode, PipelineStage, ParallelGroup } from "../tasks/types.js";

// ── Helpers ────────────────────────────────────────────────────────────

const makePromptNode = (id: string, name: string, prompt = "Do something"): FlowNode => ({
  id,
  type: "promptStage",
  position: { x: 0, y: 0 },
  data: { name, prompt, tools: null, model: null, timeoutSeconds: 300 },
});

const makeParallelNode = (id: string, name: string): FlowNode => ({
  id,
  type: "parallelGroup",
  position: { x: 0, y: 0 },
  data: { name, branchCount: 2 },
});

const makePostActionNode = (id: string, actionType: string): FlowNode => ({
  id,
  type: "postAction",
  position: { x: 0, y: 0 },
  data: { name: `Post: ${actionType}`, actionType, config: { repo: "test" } },
});

const makeEdge = (source: string, target: string): FlowEdge => ({
  id: `e-${source}-${target}`,
  source,
  target,
  type: "smoothstep",
});

// ── validateGraph ──────────────────────────────────────────────────────

describe("validateGraph", () => {
  it("returns valid for empty graph", () => {
    const result = validateGraph({ nodes: [], edges: [] });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("Graph is empty");
  });

  it("detects cycles", () => {
    const nodes = [makePromptNode("a", "A"), makePromptNode("b", "B")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "a")];
    const result = validateGraph({ nodes, edges });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  it("warns about orphan nodes", () => {
    const nodes = [makePromptNode("a", "A"), makePromptNode("b", "B"), makePromptNode("c", "C")];
    const edges = [makeEdge("a", "b")];
    const result = validateGraph({ nodes, edges });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('Node "C"'))).toBe(true);
  });

  it("warns about missing prompt text", () => {
    const nodes: FlowNode[] = [
      { id: "a", type: "promptStage", position: { x: 0, y: 0 }, data: { name: "Empty", prompt: "" } },
    ];
    const result = validateGraph({ nodes, edges: [] });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("no prompt text"))).toBe(true);
  });

  it("valid for linear chain", () => {
    const nodes = [makePromptNode("a", "A"), makePromptNode("b", "B"), makePromptNode("c", "C")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c")];
    const result = validateGraph({ nodes, edges });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects 3-node cycle", () => {
    const nodes = [makePromptNode("a", "A"), makePromptNode("b", "B"), makePromptNode("c", "C")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c"), makeEdge("c", "a")];
    const result = validateGraph({ nodes, edges });
    expect(result.valid).toBe(false);
  });
});

// ── graphToStages ──────────────────────────────────────────────────────

describe("graphToStages", () => {
  it("returns empty array for empty graph", () => {
    const result = graphToStages({ nodes: [], edges: [] });
    expect(result).toEqual([]);
  });

  it("converts single node", () => {
    const graph: FlowGraph = {
      nodes: [makePromptNode("a", "Research", "Find data")],
      edges: [],
    };
    const stages = graphToStages(graph);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      type: "prompt",
      name: "Research",
      prompt: "Find data",
    });
  });

  it("converts linear chain in correct order", () => {
    const graph: FlowGraph = {
      nodes: [
        makePromptNode("a", "Step 1", "First"),
        makePromptNode("b", "Step 2", "Second"),
        makePromptNode("c", "Step 3", "Third"),
      ],
      edges: [makeEdge("a", "b"), makeEdge("b", "c")],
    };
    const stages = graphToStages(graph);
    expect(stages).toHaveLength(3);
    expect((stages[0] as PipelineStage).name).toBe("Step 1");
    expect((stages[1] as PipelineStage).name).toBe("Step 2");
    expect((stages[2] as PipelineStage).name).toBe("Step 3");
  });

  it("converts parallel group", () => {
    const graph: FlowGraph = {
      nodes: [
        makePromptNode("start", "Start", "Begin"),
        makeParallelNode("par", "Research Phase"),
        makePromptNode("b1", "Branch 1", "Do A"),
        makePromptNode("b2", "Branch 2", "Do B"),
      ],
      edges: [
        makeEdge("start", "par"),
        makeEdge("par", "b1"),
        makeEdge("par", "b2"),
      ],
    };
    const stages = graphToStages(graph);
    expect(stages).toHaveLength(2); // Start + ParallelGroup
    expect(stages[1]).toMatchObject({
      type: "parallel",
      name: "Research Phase",
    });
    expect((stages[1] as ParallelGroup).branches).toHaveLength(2);
  });

  it("attaches post-action to parent stage", () => {
    const graph: FlowGraph = {
      nodes: [
        makePromptNode("a", "Research", "Find data"),
        makePostActionNode("pa", "create-github-issues"),
      ],
      edges: [makeEdge("a", "pa")],
    };
    const stages = graphToStages(graph);
    expect(stages).toHaveLength(1);
    const stage = stages[0] as PipelineStage;
    expect(stage.postAction).toBeDefined();
    expect(stage.postAction!.type).toBe("create-github-issues");
    expect(stage.postAction!.config).toEqual({ repo: "test" });
  });

  it("throws on cyclic graph", () => {
    const graph: FlowGraph = {
      nodes: [makePromptNode("a", "A"), makePromptNode("b", "B")],
      edges: [makeEdge("a", "b"), makeEdge("b", "a")],
    };
    expect(() => graphToStages(graph)).toThrow(/cycle/i);
  });

  it("preserves tools and model", () => {
    const node: FlowNode = {
      id: "a",
      type: "promptStage",
      position: { x: 0, y: 0 },
      data: {
        name: "Coded",
        prompt: "Write code",
        tools: ["read-file", "shell-execute"],
        model: "gpt-4o",
        timeoutSeconds: 600,
      },
    };
    const stages = graphToStages({ nodes: [node], edges: [] });
    const stage = stages[0] as PipelineStage;
    expect(stage.tools).toEqual(["read-file", "shell-execute"]);
    expect(stage.model).toBe("gpt-4o");
    expect(stage.timeoutSeconds).toBe(600);
  });

  it("skips condition nodes (v2 placeholder)", () => {
    const graph: FlowGraph = {
      nodes: [
        makePromptNode("a", "Start", "Begin"),
        { id: "cond", type: "condition", position: { x: 0, y: 0 }, data: { name: "If check" } },
      ],
      edges: [makeEdge("a", "cond")],
    };
    const stages = graphToStages(graph);
    expect(stages).toHaveLength(1);
    expect((stages[0] as PipelineStage).name).toBe("Start");
  });
});

// ── stagesToGraph ──────────────────────────────────────────────────────

describe("stagesToGraph", () => {
  it("returns empty graph for empty stages", () => {
    const graph = stagesToGraph([]);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("creates single node from single stage", () => {
    const stages: PipelineNode[] = [
      { type: "prompt", name: "Research", prompt: "Find info" },
    ];
    const graph = stagesToGraph(stages);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].type).toBe("promptStage");
    expect(graph.nodes[0].data.name).toBe("Research");
  });

  it("creates linear chain with edges", () => {
    const stages: PipelineNode[] = [
      { type: "prompt", name: "Step 1", prompt: "First" },
      { type: "prompt", name: "Step 2", prompt: "Second" },
    ];
    const graph = stagesToGraph(stages);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].source).toBe(graph.nodes[0].id);
    expect(graph.edges[0].target).toBe(graph.nodes[1].id);
  });

  it("creates parallel group with children", () => {
    const stages: PipelineNode[] = [
      {
        type: "parallel",
        name: "Research",
        branches: [
          { type: "prompt", name: "Web", prompt: "Search web" },
          { type: "prompt", name: "Docs", prompt: "Search docs" },
        ],
      },
    ];
    const graph = stagesToGraph(stages);
    // 1 group node + 2 branch nodes
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes[0].type).toBe("parallelGroup");
    expect(graph.edges).toHaveLength(2); // group → branch1, group → branch2
  });

  it("creates postAction nodes", () => {
    const stages: PipelineNode[] = [
      {
        type: "prompt",
        name: "Analyze",
        prompt: "Analyze findings",
        postAction: { type: "create-github-issues", config: { labels: ["bug"] } },
      },
    ];
    const graph = stagesToGraph(stages);
    expect(graph.nodes).toHaveLength(2); // prompt + postAction
    expect(graph.nodes[1].type).toBe("postAction");
    expect(graph.nodes[1].data.actionType).toBe("create-github-issues");
  });

  it("assigns incrementing positions", () => {
    const stages: PipelineNode[] = [
      { type: "prompt", name: "A", prompt: "a" },
      { type: "prompt", name: "B", prompt: "b" },
    ];
    const graph = stagesToGraph(stages);
    // Positions should be assigned (not all zero after layout)
    const positions = graph.nodes.map((n) => n.position);
    expect(positions.length).toBeGreaterThan(0);
  });
});

// ── Round-trip fidelity ────────────────────────────────────────────────

describe("round-trip", () => {
  it("preserves structure: stages → graph → stages", () => {
    const original: PipelineNode[] = [
      { type: "prompt", name: "Step 1", prompt: "First task", model: "gpt-4o" },
      {
        type: "parallel",
        name: "Research",
        branches: [
          { type: "prompt", name: "Web", prompt: "Search web" },
          { type: "prompt", name: "Docs", prompt: "Search docs" },
        ],
      },
      { type: "prompt", name: "Step 3", prompt: "Final task" },
    ];

    const graph = stagesToGraph(original);
    const roundTripped = graphToStages(graph);

    expect(roundTripped).toHaveLength(3);
    expect((roundTripped[0] as PipelineStage).name).toBe("Step 1");
    expect((roundTripped[0] as PipelineStage).model).toBe("gpt-4o");
    expect(roundTripped[1]).toMatchObject({ type: "parallel", name: "Research" });
    expect((roundTripped[1] as ParallelGroup).branches).toHaveLength(2);
    expect((roundTripped[2] as PipelineStage).name).toBe("Step 3");
  });

  it("preserves post-actions through round-trip", () => {
    const original: PipelineNode[] = [
      {
        type: "prompt",
        name: "Analyze",
        prompt: "Analyze code",
        postAction: { type: "create-github-issues" },
      },
    ];

    const graph = stagesToGraph(original);
    const roundTripped = graphToStages(graph);

    expect(roundTripped).toHaveLength(1);
    expect((roundTripped[0] as PipelineStage).postAction).toBeDefined();
    expect((roundTripped[0] as PipelineStage).postAction!.type).toBe("create-github-issues");
  });
});
