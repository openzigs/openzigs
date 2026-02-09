"use client";

import { useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type EdgeProps,
  BaseEdge,
  getSmoothStepPath,
  EdgeLabelRenderer,
  MarkerType,
} from "@xyflow/react";
import { fetchJson } from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TaskNode } from "./task-node";
import { useSocket } from "@/lib/socket-context";

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
  width: number;
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

  const roots = nodes.filter((n) => parentMap.get(n.id) === null);
  if (roots.length === 0) roots.push(nodes[0]);

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

/* ─── Status → edge style mapping ─── */

const EDGE_COLORS = {
  running:   { stroke: "hsl(217, 91%, 60%)", glow: "drop-shadow(0 0 4px rgba(59,130,246,0.5))" },
  completed: { stroke: "hsl(160, 84%, 39%)", glow: "" },
  failed:    { stroke: "hsl(0, 84%, 60%)",   glow: "drop-shadow(0 0 3px rgba(239,68,68,0.4))" },
  queued:    { stroke: "hsl(var(--muted-foreground))", glow: "" },
  cancelled: { stroke: "hsl(var(--muted-foreground))", glow: "" },
} as const;

function getEdgeLabel(status: string | undefined): string {
  switch (status) {
    case "running": return "executing";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return "spawned";
  }
}

/* ─── Animated edge with flowing particles ─── */

function AnimatedOrchestrationEdge({
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

  const edgeData = data as Record<string, unknown> | undefined;
  const label = edgeData?.label as string | undefined;
  const status = edgeData?.targetStatus as string | undefined;
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isFailed = status === "failed";

  const colors = EDGE_COLORS[status as keyof typeof EDGE_COLORS] ?? EDGE_COLORS.queued;

  return (
    <>
      {/* Glow layer for running edges */}
      {isRunning && (
        <BaseEdge
          id={`${id}-glow`}
          path={edgePath}
          style={{
            stroke: colors.stroke,
            strokeWidth: 6,
            opacity: 0.15,
            filter: "blur(4px)",
          }}
        />
      )}

      {/* Main edge path */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: colors.stroke,
          strokeWidth: isRunning ? 2.5 : 2,
          strokeDasharray: isRunning ? "8 4" : undefined,
          strokeDashoffset: 0,
          animation: isRunning ? "edge-dash-flow 0.6s linear infinite" : undefined,
          transition: "stroke 0.5s ease, stroke-width 0.3s ease",
        }}
        markerEnd={markerEnd}
      />

      {/* Flowing particles along running edges */}
      {isRunning && (
        <g>
          <circle r="3" fill={colors.stroke} opacity="0.8">
            <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} />
          </circle>
          <circle r="2" fill={colors.stroke} opacity="0.5">
            <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} begin="0.5s" />
          </circle>
          <circle r="1.5" fill={colors.stroke} opacity="0.3">
            <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} begin="1s" />
          </circle>
        </g>
      )}

      {/* Edge label */}
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`
              nodrag nopan pointer-events-none absolute rounded-full px-2 py-0.5
              text-[9px] font-medium shadow-sm border
              transition-all duration-500
              ${isRunning
                ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
                : isCompleted
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                : isFailed
                ? "bg-red-500/10 text-red-400 border-red-500/30"
                : "bg-card/90 text-muted-foreground border-border/50"
              }
            `}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {isRunning && (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 mr-1 status-dot-active" />
            )}
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { taskNode: TaskNode };
const edgeTypes = { orchestration: AnimatedOrchestrationEdge };

type TaskGraphProps = {
  taskId: string;
  height?: number;
};

type TaskStatusEvent = {
  event: string;
  task: {
    id: string;
    parentTaskId: string | null;
    status: string;
    goal: string;
    trigger: string;
    depth: number;
    model: string | null;
    result: string | null;
    error: string | null;
    spawnedBy: string | null;
    sessionId: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
};

/**
 * Interactive orchestration graph with real-time animated status updates.
 *
 * Features:
 * - Pulsing/flowing nodes for running agents
 * - Animated particle edges for active connections
 * - Green completion transitions, red failure states
 * - "Waiting" state for orchestrators with running children
 * - Socket.IO real-time updates + polling fallback
 */
function TaskGraphInner({ taskId, height = 500 }: TaskGraphProps) {
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const { fitView } = useReactFlow();
  const prevNodeCountRef = useRef(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ["taskTree", taskId],
    queryFn: () =>
      fetchJson<{ nodes: Node[]; edges: Edge[] }>(`/api/tasks/${taskId}/tree`),
    refetchInterval: 3_000, // faster polling for near-real-time feel
  });

  // Listen for Socket.IO task status events to trigger instant refetch
  useEffect(() => {
    if (!socket) return;

    const handleTaskStatus = (_payload: TaskStatusEvent) => {
      // Only refetch if this event is relevant to the current task tree
      // (the task itself, or a descendant)
      queryClient.invalidateQueries({ queryKey: ["taskTree", taskId] });
    };

    socket.on("task:status", handleTaskStatus);
    return () => {
      socket.off("task:status", handleTaskStatus);
    };
  }, [socket, taskId, queryClient]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!data) return;

    // Compute child counts so TaskNode can determine orchestrator role
    const childCounts = new Map<string, number>();
    for (const edge of data.edges) {
      childCounts.set(edge.source, (childCounts.get(edge.source) ?? 0) + 1);
    }

    // Determine which parents have running children (= waiting state)
    const runningChildParents = new Set<string>();
    for (const edge of data.edges) {
      const targetNode = data.nodes.find((n) => n.id === edge.target);
      const targetData = targetNode?.data as Record<string, unknown> | undefined;
      if (targetData?.status === "running" || targetData?.status === "queued") {
        runningChildParents.add(edge.source);
      }
    }

    // Inject enrichment into node data
    const enrichedNodes = data.nodes.map((node) => {
      const nodeData = node.data as Record<string, unknown>;
      const hasChildren = (childCounts.get(node.id) ?? 0) > 0;
      const isRunning = nodeData.status === "running";
      const hasRunningChildren = runningChildParents.has(node.id);

      return {
        ...node,
        data: {
          ...nodeData,
          childCount: childCounts.get(node.id) ?? 0,
          isWaiting: hasChildren && isRunning && hasRunningChildren,
        },
      };
    });

    // Build enriched edges with status-aware styling
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n.data as Record<string, unknown>]));
    const enrichedEdges: Edge[] = data.edges.map((edge) => {
      const target = nodeMap.get(edge.target);
      const targetStatus = (target?.status as string) ?? "queued";

      return {
        ...edge,
        type: "orchestration",
        animated: false, // handled by our custom edge
        data: {
          label: getEdgeLabel(targetStatus),
          targetStatus,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: (EDGE_COLORS[targetStatus as keyof typeof EDGE_COLORS] ?? EDGE_COLORS.queued).stroke,
        },
        style: {
          stroke: (EDGE_COLORS[targetStatus as keyof typeof EDGE_COLORS] ?? EDGE_COLORS.queued).stroke,
          strokeWidth: 2,
        },
      };
    });

    const laidOut = applyTreeLayout(enrichedNodes, enrichedEdges);
    setNodes(laidOut);
    setEdges(enrichedEdges);

    // Fit view when new nodes appear
    if (laidOut.length !== prevNodeCountRef.current) {
      prevNodeCountRef.current = laidOut.length;
      requestAnimationFrame(() => fitView({ padding: 0.3, duration: 300 }));
    }
  }, [data, setNodes, setEdges, fitView]);

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-border bg-card"
        style={{ height }}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-blue-500/30 border-t-blue-500 animate-spin" />
          <p className="text-sm text-muted-foreground">Loading orchestration graph…</p>
        </div>
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
}

/**
 * Wrapper component that provides ReactFlowProvider context.
 * Required for useReactFlow() hook to work inside TaskGraphInner.
 */
export const TaskGraph = ({ taskId, height = 500 }: TaskGraphProps) => {
  return (
    <ReactFlowProvider>
      <TaskGraphInner taskId={taskId} height={height} />
    </ReactFlowProvider>
  );
};
