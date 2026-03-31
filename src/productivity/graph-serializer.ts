/**
 * Bidirectional serialization between React Flow graph JSON and PipelineDefinition.
 *
 * graphToStages() — converts React Flow nodes/edges → PipelineNode[]
 * stagesToGraph() — converts PipelineNode[] → positioned nodes/edges (dagre layout)
 * validateGraph() — cycle detection + orphan detection
 */

import type { PipelineNode, PipelineStage, ParallelGroup } from "../tasks/types.js";

// ── Types ──────────────────────────────────────────────────────────────

export type FlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  animated?: boolean;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: { x: number; y: number; zoom: number };
};

// ── Shared topological sort (Kahn's algorithm) ────────────────────────

export type TopoSortResult = {
  sorted: string[];
  hasCycle: boolean;
};

/**
 * Kahn's algorithm topological sort.
 * Returns the sorted node IDs and whether a cycle was detected.
 */
export function topologicalSort(
  nodeIds: string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): TopoSortResult {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const edge of edges) {
    if (adj.has(edge.source) && inDegree.has(edge.target)) {
      adj.get(edge.source)!.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return { sorted, hasCycle: sorted.length !== nodeIds.length };
}

// ── Validation ─────────────────────────────────────────────────────────

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * Validate a React Flow graph for cycles, orphan nodes, and missing data.
 */
export function validateGraph(graph: FlowGraph): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (graph.nodes.length === 0) {
    return { valid: true, errors: [], warnings: ["Graph is empty"] };
  }

  // Check for cycles via Kahn's algorithm
  const hasCycle = detectCycle(graph.nodes, graph.edges);
  if (hasCycle) {
    errors.push("Graph contains a cycle — pipelines must be acyclic");
  }

  // Check for orphan nodes (no incoming or outgoing edges, and not the only node)
  if (graph.nodes.length > 1) {
    const connectedIds = new Set<string>();
    for (const edge of graph.edges) {
      connectedIds.add(edge.source);
      connectedIds.add(edge.target);
    }
    for (const node of graph.nodes) {
      if (!connectedIds.has(node.id)) {
        warnings.push(`Node "${node.data.name || node.id}" is disconnected`);
      }
    }
  }

  // Check for missing prompt data on prompt nodes
  for (const node of graph.nodes) {
    if (node.type === "promptStage" && !node.data.prompt) {
      warnings.push(`Node "${node.data.name || node.id}" has no prompt text`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Detect cycles in a directed graph using Kahn's algorithm.
 * Returns true if a cycle exists.
 */
function detectCycle(nodes: FlowNode[], edges: FlowEdge[]): boolean {
  const ids = nodes.map((n) => n.id);
  return topologicalSort(ids, edges).hasCycle;
}

// ── graphToStages ──────────────────────────────────────────────────────

/**
 * Convert a React Flow graph to PipelineNode[].
 *
 * Uses Kahn's algorithm (topological sort) for ordering.
 * - promptStage nodes → PipelineStage
 * - parallelGroup nodes → ParallelGroup (children are nodes whose only incoming edge is from a fork)
 * - postAction nodes → attached to parent stage's postAction field
 */
export function graphToStages(graph: FlowGraph): PipelineNode[] {
  if (graph.nodes.length === 0) return [];

  const validation = validateGraph(graph);
  if (!validation.valid) {
    throw new Error(`Invalid graph: ${validation.errors.join("; ")}`);
  }

  // Topological sort + reverse adjacency for postAction attachment
  const ids = graph.nodes.map((n) => n.id);
  const { sorted } = topologicalSort(ids, graph.edges);

  const adj = new Map<string, string[]>();
  const reverseAdj = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adj.set(node.id, []);
    reverseAdj.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (adj.has(edge.source) && adj.has(edge.target)) {
      adj.get(edge.source)!.push(edge.target);
      reverseAdj.get(edge.target)!.push(edge.source);
    }
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // Collect postAction attachments: postAction node → parent via incoming edge
  const postActionAttachments = new Map<string, string>(); // parentId → postActionNodeId
  for (const nodeId of sorted) {
    const node = nodeMap.get(nodeId)!;
    if (node.type === "postAction") {
      const parents = reverseAdj.get(nodeId) ?? [];
      if (parents.length > 0) {
        postActionAttachments.set(parents[0], nodeId);
      }
    }
  }

  // Identify which promptStage nodes are direct children of a parallel group
  const parallelBranchChildren = new Set<string>();
  for (const nodeId of sorted) {
    const node = nodeMap.get(nodeId)!;
    if (node.type === "parallelGroup") {
      for (const childId of adj.get(nodeId) ?? []) {
        const childNode = nodeMap.get(childId);
        if (childNode && childNode.type === "promptStage") {
          parallelBranchChildren.add(childId);
        }
      }
    }
  }

  const stages: PipelineNode[] = [];

  for (const nodeId of sorted) {
    const node = nodeMap.get(nodeId)!;

    if (node.type === "postAction" || node.type === "condition") {
      // postAction nodes are attached to parent; condition nodes are v2
      continue;
    }

    if (node.type === "parallelGroup") {
      // Only include direct promptStage children as branches
      const children = (adj.get(nodeId) ?? [])
        .map((cid) => nodeMap.get(cid))
        .filter((n): n is FlowNode => n != null && n.type === "promptStage");

      const branches: PipelineNode[] = children.map((child) => nodeToStage(child, postActionAttachments, nodeMap));

      const group: ParallelGroup = {
        type: "parallel",
        name: String(node.data.name ?? "Parallel Group"),
        branches,
      };
      stages.push(group);
    } else if (node.type === "promptStage") {
      // Skip if this node is a branch child of a parallel group
      if (parallelBranchChildren.has(nodeId)) continue;

      stages.push(nodeToStage(node, postActionAttachments, nodeMap));
    }
  }

  return stages;
}

function nodeToStage(
  node: FlowNode,
  postActionAttachments: Map<string, string>,
  nodeMap: Map<string, FlowNode>,
): PipelineStage {
  const d = node.data;
  const stage: PipelineStage = {
    type: "prompt",
    name: String(d.name ?? ""),
    prompt: String(d.prompt ?? ""),
  };

  if (d.tools && Array.isArray(d.tools) && d.tools.length > 0) {
    stage.tools = d.tools as string[];
  }
  if (d.model) stage.model = String(d.model);
  if (d.timeoutSeconds && Number(d.timeoutSeconds) !== 300) {
    stage.timeoutSeconds = Number(d.timeoutSeconds);
  }
  if (d.autoApproveTools && Array.isArray(d.autoApproveTools) && d.autoApproveTools.length > 0) {
    stage.autoApproveTools = d.autoApproveTools as string[];
  }
  if (d.enableInSessionSubagents) stage.enableInSessionSubagents = true;

  // Attach post-action if present
  const paNodeId = postActionAttachments.get(node.id);
  if (paNodeId) {
    const paNode = nodeMap.get(paNodeId);
    if (paNode) {
      stage.postAction = {
        type: String(paNode.data.actionType ?? ""),
        config: (paNode.data.config as Record<string, unknown>) ?? undefined,
      };
    }
  }

  return stage;
}

// ── stagesToGraph ──────────────────────────────────────────────────────

/**
 * Convert PipelineNode[] to a React Flow graph with auto-layout positions.
 */
export function stagesToGraph(stages: PipelineNode[]): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let idCounter = 0;
  const nextId = () => `wf-${++idCounter}`;

  // prevIds tracks which node(s) should connect to the next sequential node.
  // For linear flow it's a single ID; after a parallel group it's the branch-end IDs.
  let prevIds: string[] = [];

  for (const stage of stages) {
    if (stage.type === "parallel") {
      const groupId = nextId();
      nodes.push({
        id: groupId,
        type: "parallelGroup",
        position: { x: 0, y: 0 },
        data: {
          name: stage.name,
          branchCount: stage.branches.length,
        },
      });

      for (const pid of prevIds) {
        edges.push({
          id: `e-${pid}-${groupId}`,
          source: pid,
          target: groupId,
          type: "smoothstep",
          animated: true,
        });
      }

      // Create child nodes for each branch
      const branchEndIds: string[] = [];
      for (const branch of stage.branches) {
        if (branch.type === "parallel") continue; // nested parallel not supported in v1
        const branchStage = branch as PipelineStage;
        const childId = nextId();
        nodes.push({
          id: childId,
          type: "promptStage",
          position: { x: 0, y: 0 },
          data: stageToNodeData(branchStage),
        });
        edges.push({
          id: `e-${groupId}-${childId}`,
          source: groupId,
          target: childId,
          type: "smoothstep",
          animated: true,
        });

        let branchEndId = childId;

        // Add postAction node if present
        if (branchStage.postAction) {
          const paId = nextId();
          nodes.push({
            id: paId,
            type: "postAction",
            position: { x: 0, y: 0 },
            data: {
              name: `Post: ${branchStage.postAction.type}`,
              actionType: branchStage.postAction.type,
              config: branchStage.postAction.config ?? {},
            },
          });
          edges.push({
            id: `e-${childId}-${paId}`,
            source: childId,
            target: paId,
            type: "smoothstep",
          });
          branchEndId = paId;
        }

        branchEndIds.push(branchEndId);
      }

      // Next sequential node connects from all branch ends (fan-in)
      prevIds = branchEndIds;
    } else {
      const promptStage = stage as PipelineStage;
      const nodeId = nextId();
      nodes.push({
        id: nodeId,
        type: "promptStage",
        position: { x: 0, y: 0 },
        data: stageToNodeData(promptStage),
      });

      for (const pid of prevIds) {
        edges.push({
          id: `e-${pid}-${nodeId}`,
          source: pid,
          target: nodeId,
          type: "smoothstep",
          animated: true,
        });
      }

      // Add postAction node if present
      if (promptStage.postAction) {
        const paId = nextId();
        nodes.push({
          id: paId,
          type: "postAction",
          position: { x: 0, y: 0 },
          data: {
            name: `Post: ${promptStage.postAction.type}`,
            actionType: promptStage.postAction.type,
            config: promptStage.postAction.config ?? {},
          },
        });
        edges.push({
          id: `e-${nodeId}-${paId}`,
          source: nodeId,
          target: paId,
          type: "smoothstep",
        });
      }

      prevIds = [nodeId];
    }
  }

  // Apply simple left-to-right layout (dagre is UI-side only; server uses linear layout)
  applySimpleLayout(nodes, edges);

  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function stageToNodeData(stage: PipelineStage): Record<string, unknown> {
  return {
    name: stage.name,
    prompt: stage.prompt,
    tools: stage.tools ?? null,
    autoApproveTools: stage.autoApproveTools ?? null,
    model: stage.model ?? null,
    timeoutSeconds: stage.timeoutSeconds ?? 300,
    enableInSessionSubagents: stage.enableInSessionSubagents ?? false,
  };
}

/**
 * Simple top-down layout for server-side graph generation.
 * The UI applies dagre for more sophisticated positioning.
 */
function applySimpleLayout(nodes: FlowNode[], edges: FlowEdge[]): void {
  const ids = nodes.map((n) => n.id);
  const { sorted } = topologicalSort(ids, edges);

  // O(n) lookup instead of O(n²) find()
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const yGap = 120;
  let y = 0;
  for (const id of sorted) {
    const node = nodeMap.get(id);
    if (node) {
      node.position = { x: 250, y };
      y += yGap;
    }
  }
}
