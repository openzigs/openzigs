"use client";

import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { TaskNode } from "./task-node";

import "@xyflow/react/dist/style.css";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 120;
const NODE_SEP_X = 60;
const RANK_SEP_Y = 80;

/**
 * Simple hierarchical (top-to-bottom) layout for a DAG.
 * Assigns ranks via BFS from root nodes, then spaces nodes within each rank.
 * No external dependency required — replaces dagre.
 */
function applyHierarchicalLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  // Build adjacency: parent → children
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const id of nodeIds) {
    children.set(id, []);
    parents.set(id, []);
  }
  for (const edge of edges) {
    children.get(edge.source)?.push(edge.target);
    parents.get(edge.target)?.push(edge.source);
  }

  // Assign ranks via BFS from roots (nodes with no incoming edges)
  const rank = new Map<string, number>();
  const roots = nodes.filter((n) => (parents.get(n.id)?.length ?? 0) === 0);
  const queue: { id: string; depth: number }[] = roots.map((n) => ({
    id: n.id,
    depth: 0,
  }));

  // If there are no roots (cycle), just use the first node
  if (queue.length === 0) {
    queue.push({ id: nodes[0].id, depth: 0 });
  }

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (rank.has(id)) continue;
    rank.set(id, depth);
    for (const child of children.get(id) ?? []) {
      if (!rank.has(child)) {
        queue.push({ id: child, depth: depth + 1 });
      }
    }
  }

  // Fallback: assign rank 0 to any unreached node
  for (const node of nodes) {
    if (!rank.has(node.id)) rank.set(node.id, 0);
  }

  // Group by rank
  const rankGroups = new Map<number, string[]>();
  for (const node of nodes) {
    const r = rank.get(node.id) ?? 0;
    if (!rankGroups.has(r)) rankGroups.set(r, []);
    rankGroups.get(r)!.push(node.id);
  }

  // Position nodes: center each rank horizontally
  const positions = new Map<string, { x: number; y: number }>();
  for (const [r, ids] of rankGroups) {
    const totalWidth = ids.length * NODE_WIDTH + (ids.length - 1) * NODE_SEP_X;
    const startX = -totalWidth / 2;
    ids.forEach((id, i) => {
      positions.set(id, {
        x: startX + i * (NODE_WIDTH + NODE_SEP_X),
        y: r * (NODE_HEIGHT + RANK_SEP_Y),
      });
    });
  }

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
  }));
}

const nodeTypes = { taskNode: TaskNode };

type TaskGraphProps = {
  /** The root task ID to visualise. */
  taskId: string;
  /** Optional height override. Default 500px. */
  height?: number;
};

/**
 * Interactive DAG visualisation of a task and its descendants.
 * Fetches data from GET /api/tasks/:id/tree, applies dagre layout,
 * and renders with React Flow.
 */
export const TaskGraph = ({ taskId, height = 500 }: TaskGraphProps) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ["taskTree", taskId],
    queryFn: () =>
      fetchJson<{ nodes: Node[]; edges: Edge[] }>(`/api/tasks/${taskId}/tree`),
    refetchInterval: 10_000,
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!data) return;

    const laidOut = applyHierarchicalLayout(data.nodes, data.edges);
    setNodes(laidOut);
    setEdges(data.edges);
  }, [data, setNodes, setEdges]);

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep" as const,
      style: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.5 },
    }),
    []
  );

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-border bg-card"
        style={{ height }}
      >
        <p className="text-sm text-muted-foreground">Loading task graph…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5"
        style={{ height }}
      >
        <p className="text-sm text-destructive">
          Failed to load task tree: {(error as Error).message}
        </p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-border bg-card"
        style={{ height }}
      >
        <p className="text-sm text-muted-foreground">No task data to display.</p>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      style={{ height }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={3}
          position="bottom-left"
          pannable
          zoomable
          className="!bg-card !border-border"
        />
      </ReactFlow>
    </div>
  );
};
