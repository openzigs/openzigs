"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type OnConnect,
  type NodeTypes,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Save, Upload, Download, Trash2, CheckCircle, Loader2 } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { PromptStageNode } from "./components/nodes/prompt-stage-node";
import { ParallelGroupNode } from "./components/nodes/parallel-group-node";
import { PostActionNode } from "./components/nodes/post-action-node";
import { ConditionNode } from "./components/nodes/condition-node";
import { NodePalette } from "./components/sidebar/node-palette";
import { NodeConfigPanel } from "./components/sidebar/node-config-panel";
import { useWorkflowExecution } from "./hooks/use-workflow-execution";

// ── Node type registry ─────────────────────────────────────────────

const nodeTypes: NodeTypes = {
  promptStage: PromptStageNode,
  parallelGroup: ParallelGroupNode,
  postAction: PostActionNode,
  condition: ConditionNode,
} as unknown as NodeTypes;

// ── Inner canvas (needs ReactFlowProvider above) ───────────────────

let idCounter = 0;
const nextNodeId = () => `wfn-${Date.now()}-${++idCounter}`;

function WorkflowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [workflowName, setWorkflowName] = useState("Untitled Workflow");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, toObject } = useReactFlow();
  const queryClient = useQueryClient();

  const { runWorkflow, stopWorkflow, isRunning } = useWorkflowExecution(setNodes);

  // ── Connection handling ─────────────────────────────────────────

  const onConnect: OnConnect = useCallback(
    (connection) => {
      // Prevent self-loops
      if (connection.source === connection.target) return;
      setEdges((eds) => addEdge({ ...connection, type: "smoothstep", animated: true }, eds));
    },
    [setEdges],
  );

  // ── Drag and drop from palette ──────────────────────────────────

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData("application/reactflow");
      if (!nodeType) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const defaultData: Record<string, Record<string, unknown>> = {
        promptStage: { name: "New Stage", prompt: "", tools: null, model: null, timeoutSeconds: 300 },
        parallelGroup: { name: "Parallel Group", branchCount: 0 },
        postAction: { name: "Post-Action", actionType: "", config: {} },
        condition: { name: "Condition", expression: "", comingSoon: true },
      };

      const newNode: Node = {
        id: nextNodeId(),
        type: nodeType,
        position,
        data: defaultData[nodeType] ?? { name: "Node" },
      };

      setNodes((nds) => [...nds, newNode]);
    },
    [screenToFlowPosition, setNodes],
  );

  // ── Node selection ──────────────────────────────────────────────

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setSelectedNode(node);
    },
    [],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // ── Node config update ──────────────────────────────────────────

  const onNodeDataChange = useCallback(
    (nodeId: string, newData: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...newData } } : n)),
      );
      setSelectedNode((prev) =>
        prev && prev.id === nodeId ? { ...prev, data: { ...prev.data, ...newData } } : prev,
      );
    },
    [setNodes],
  );

  // ── Delete selected node ────────────────────────────────────────

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNode) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
    setEdges((eds) =>
      eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id),
    );
    setSelectedNode(null);
  }, [selectedNode, setNodes, setEdges]);

  // ── Save workflow ───────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: async () => {
      const graph = toObject();
      await fetchJson("/api/admin/prompts", {
        method: "POST",
        body: JSON.stringify({
          name: workflowName,
          template: `Workflow: ${workflowName}`,
          description: `Visual workflow with ${nodes.length} nodes`,
          tags: ["workflow"],
          stages: graphToBasicStages(nodes, edges),
          graphLayout: JSON.stringify(graph),
        }),
      });
    },
    onSuccess: () => {
      setSaveStatus("saved");
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      setTimeout(() => setSaveStatus("idle"), 2000);
    },
    onError: () => setSaveStatus("error"),
  });

  // ── Run workflow ────────────────────────────────────────────────

  const handleRunWorkflow = useCallback(() => {
    const stages = graphToBasicStages(nodes, edges);
    if (stages.length === 0) return;
    runWorkflow(stages, workflowName);
  }, [nodes, edges, runWorkflow, workflowName]);

  // ── Export ──────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const graph = toObject();
    const data = {
      name: workflowName,
      stages: graphToBasicStages(nodes, edges),
      graphLayout: graph,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflowName.toLowerCase().replace(/\s+/g, "-")}.openzigs-template.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, edges, toObject, workflowName]);

  // ── Import ──────────────────────────────────────────────────────

  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const data = JSON.parse(text);
        if (data.graphLayout) {
          const layout = typeof data.graphLayout === "string" ? JSON.parse(data.graphLayout) : data.graphLayout;
          if (layout.nodes) setNodes(layout.nodes);
          if (layout.edges) setEdges(layout.edges);
        }
        if (data.name) setWorkflowName(data.name);
      } catch {
        // Invalid file
      }
    };
    input.click();
  }, [setNodes, setEdges]);

  return (
    <div className="flex h-full">
      {/* Left: Node palette */}
      <NodePalette />

      {/* Center: Canvas */}
      <div className="flex-1 relative" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode="Backspace"
          className="bg-background"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="opacity-30" />
          <Controls className="!bg-card !border-border !shadow-md" />
          <MiniMap
            className="!bg-card !border-border"
            nodeColor={(n) => {
              if (n.type === "parallelGroup") return "#38bdf8";
              if (n.type === "postAction") return "#f59e0b";
              if (n.type === "condition") return "#a78bfa";
              return "#10b981";
            }}
          />

          {/* Toolbar panel */}
          <Panel position="top-center" className="flex items-center gap-2">
            <input
              type="text"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-card-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
            >
              {saveStatus === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
            <button
              onClick={handleRunWorkflow}
              disabled={isRunning || nodes.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            >
              {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {isRunning ? "Running..." : "Run"}
            </button>
            {isRunning && (
              <button
                onClick={stopWorkflow}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700"
              >
                Stop
              </button>
            )}
            <button
              onClick={handleImport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-card-foreground shadow-sm hover:bg-accent/10"
            >
              <Upload className="h-3.5 w-3.5" />
              Import
            </button>
            <button
              onClick={handleExport}
              disabled={nodes.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-card-foreground shadow-sm hover:bg-accent/10 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
            {selectedNode && (
              <button
                onClick={deleteSelectedNode}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )}
            {saveStatus === "saved" && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle className="h-3.5 w-3.5" /> Saved
              </span>
            )}
          </Panel>

          {/* Empty state */}
          {nodes.length === 0 && (
            <Panel position="top-center" className="mt-32">
              <div className="text-center text-muted-foreground">
                <p className="text-lg font-medium">Drag nodes here to start building</p>
                <p className="text-sm mt-1">Use the palette on the left to add workflow stages</p>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* Right: Config panel */}
      <NodeConfigPanel
        selectedNode={selectedNode}
        onDataChange={onNodeDataChange}
        onDelete={deleteSelectedNode}
      />
    </div>
  );
}

// ── Main export with provider ──────────────────────────────────────

export function WorkflowBuilder() {
  return (
    <div className="h-[calc(100dvh-8rem)]">
      <ReactFlowProvider>
        <WorkflowCanvas />
      </ReactFlowProvider>
    </div>
  );
}

// ── Utility: basic graph → stages conversion (client-side) ─────────

function graphToBasicStages(
  nodes: Node[],
  edges: Edge[],
): Array<{ type: string; name: string; prompt?: string; tools?: string[] | null; model?: string }> {
  // Simplified topological sort for execution
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sorted.push(cur);
    for (const nb of adj.get(cur) ?? []) {
      const d = (inDegree.get(nb) ?? 1) - 1;
      inDegree.set(nb, d);
      if (d === 0) queue.push(nb);
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return sorted
    .map((id) => nodeMap.get(id)!)
    .filter((n) => n.type === "promptStage")
    .map((n) => ({
      type: "prompt",
      name: String(n.data.name ?? ""),
      prompt: String(n.data.prompt ?? ""),
      tools: n.data.tools as string[] | null,
      model: n.data.model as string | undefined,
    }));
}
