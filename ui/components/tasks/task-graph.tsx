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
import dagre from "@dagrejs/dagre";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { TaskNode } from "./task-node";

import "@xyflow/react/dist/style.css";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 120;

/** Apply dagre hierarchical layout (top-to-bottom) to nodes and edges. */
function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
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

    const laidOut = applyDagreLayout(data.nodes, data.edges);
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
