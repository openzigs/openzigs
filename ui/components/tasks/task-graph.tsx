"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeProps,
  BaseEdge,
  getSmoothStepPath,
  EdgeLabelRenderer,
  MarkerType,
} from "@xyflow/react";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { TaskNode } from "./task-node";

import "@xyflow/react/dist/style.css";

/* ─── Layout constants ─── */
const NODE_WIDTH = 200;
const NODE_HEIGHT = 160;
const NODE_SEP_X = 80;
const RANK_SEP_Y = 120;

/* ─── Tree layout: centers children under their parent ─── */

type LayoutNode = {
  id: string;
  children: string[];
  width: number;        // subtree width
  x: number;
  y: number;
};

/**
 * Compute a proper tree layout that centers parents over their children.
 * Uses a bottom-up width calculation then top-down position assignment.
 */
function applyTreeLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const childrenMap = new Map<string, string[]>();
  const parentMap = new Map<string, string | null>();
  const nodeSet = new Set(nodes.map((n) => n.id));

  for (const id of nodeSet) {
    childrenMap.set(id, []);
    parentMap.set(id, null);
  }
  for (const edge of edges) {
    childrenMap.get(edge.source)?.push(edge.target);
    parentMap.set(edge.target, edge.source);
  }

  // Find roots
  const roots = nodes.filter((n) => parentMap.get(n.id) === null);
  if (roots.length === 0) roots.push(nodes[0]);

  // Bottom-up: compute subtree widths
  const layoutNodes = new Map<string, LayoutNode>();

  function computeWidth(id: string): number {
    const kids = childrenMap.get(id) ?? [];
    if (kids.length === 0) {
      const ln: LayoutNode = { id, children: kids, width: NODE_WIDTH, x: 0, y: 0 };
      layoutNodes.set(id, ln);
      return NODE_WIDTH;
    }
    const childWidths = kids.map(computeWidth);
    const totalWidth = childWidths.reduce((a, b) => a + b, 0) + (kids.length - 1) * NODE_SEP_X;
    const w = Math.max(NODE_WIDTH, totalWidth);
    const ln: LayoutNode = { id, children: kids, width: w, x: 0, y: 0 };
    layoutNodes.set(id, ln);
    return w;
  }

  // Top-down: assign positions
  function assignPositions(id: string, x: number, y: number) {
    const ln = layoutNodes.get(id)!;
    ln.x = x;
    ln.y = y;

    const kids = ln.children;
    if (kids.length === 0) return;

    const childWidths = kids.map((k) => layoutNodes.get(k)!.width);
    const totalChildWidth = childWidths.reduce((a, b) => a + b, 0) + (kids.length - 1) * NODE_SEP_X;
    let startX = x - totalChildWidth / 2;

    kids.forEach((kid, i) => {
      const cw = childWidths[i];
      const childCenterX = startX + cw / 2;
      assignPositions(kid, childCenterX, y + RANK_SEP_Y + NODE_HEIGHT);
      startX += cw + NODE_SEP_X;
    });
  }

  // Handle multiple roots side by side
  const rootWidths = roots.map((r) => computeWidth(r.id));
  const totalRootWidth = rootWidths.reduce((a, b) => a + b, 0) + (roots.length - 1) * NODE_SEP_X;
  let startX = -totalRootWidth / 2;

  roots.forEach((root, i) => {
    const rw = rootWidths[i];
    assignPositions(root.id, startX + rw / 2, 0);
    startX += rw + NODE_SEP_X;
  });

  return nodes.map((node) => {
    const ln = layoutNodes.get(node.id);
    return {
      ...node,
      position: ln ? { x: ln.x - NODE_WIDTH / 2, y: ln.y } : { x: 0, y: 0 },
    };
  });
}

/* ─── Custom edge with animated arrow + optional label ─── */

function OrchestrationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  const label = (data as Record<string, unknown> | undefined)?.label as string | undefined;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded-full bg-card/90 px-2 py-0.5 text-[9px] font-medium text-muted-foreground shadow-sm border border-border/50"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { taskNode: TaskNode };
const edgeTypes = { orchestration: OrchestrationEdge };

type TaskGraphProps = {
  taskId: string;
  height?: number;
};

/**
 * Interactive orchestration graph visualizing task → sub-agent relationships.
 * Shows the full task tree as a workflow diagram with role-based icons,
 * animated connections, and edge labels.
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

    // Compute child counts so TaskNode can determine orchestrator role
    const childCounts = new Map<string, number>();
    for (const edge of data.edges) {
      childCounts.set(edge.source, (childCounts.get(edge.source) ?? 0) + 1);
    }

    // Inject childCount into node data
    const enrichedNodes = data.nodes.map((node) => ({
      ...node,
      data: {
        ...(node.data as Record<string, unknown>),
        childCount: childCounts.get(node.id) ?? 0,
      },
    }));

    // Build relationship labels for edges
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n.data as Record<string, unknown>]));
    const enrichedEdges: Edge[] = data.edges.map((edge) => {
      const target = nodeMap.get(edge.target);
      const isRunning = target?.status === "running";
      return {
        ...edge,
        type: "orchestration",
        animated: isRunning,
        data: {
          label: isRunning ? "executing" : target?.status === "completed" ? "completed" : target?.status === "failed" ? "failed" : "spawned",
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: {
          stroke: isRunning ? "hsl(217, 91%, 60%)" :
            target?.status === "completed" ? "hsl(160, 84%, 39%)" :
            target?.status === "failed" ? "hsl(0, 84%, 60%)" :
            "hsl(var(--muted-foreground))",
          strokeWidth: 2,
        },
      };
    });

    const laidOut = applyTreeLayout(enrichedNodes, enrichedEdges);
    setNodes(laidOut);
    setEdges(enrichedEdges);
  }, [data, setNodes, setEdges]);

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-border bg-card"
        style={{ height }}
      >
        <p className="text-sm text-muted-foreground">Loading orchestration graph…</p>
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
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="hsl(var(--muted-foreground) / 0.08)" />
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
