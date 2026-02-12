"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type OnConnect,
  type NodeTypes,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Trash2, GitBranch, Save, ChevronDown, Search } from "lucide-react";
import { ToolMultiSelect, type ToolOption } from "./tool-multi-select";

/* ── Pipeline node types (matches backend PipelineNode) ── */

export type PromptStageData = {
  type: "prompt";
  name: string;
  prompt: string;
  tools: string[] | null;
  model?: string;
  timeoutSeconds?: number;
};

export type ParallelGroupData = {
  type: "parallel";
  name: string;
  branchCount: number;
};

export type PipelineNodeData = PromptStageData | ParallelGroupData;

/* ── Custom Node Components ── */

const PromptNode = ({ data, selected }: { data: PromptStageData; selected?: boolean }) => (
  <div
    className={`rounded-xl border-2 bg-card px-4 py-3 shadow-md min-w-[220px] max-w-[320px] transition-all ${
      selected ? "border-primary ring-2 ring-primary/30" : "border-border"
    }`}
  >
    <Handle type="target" position={Position.Top} className="!bg-primary !w-3 !h-3" />
    <div className="flex items-center gap-2 mb-2">
      <div className="h-2 w-2 rounded-full bg-emerald-500" />
      <span className="text-sm font-semibold text-card-foreground truncate">{data.name}</span>
    </div>
    <p className="text-xs text-muted-foreground line-clamp-2">{data.prompt || "No prompt set"}</p>
    {data.tools && (
      <div className="mt-2 flex flex-wrap gap-1">
        {data.tools.slice(0, 3).map((t) => (
          <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {t}
          </span>
        ))}
        {data.tools.length > 3 && (
          <span className="text-[10px] text-muted-foreground">+{data.tools.length - 3}</span>
        )}
      </div>
    )}
    <Handle type="source" position={Position.Bottom} className="!bg-primary !w-3 !h-3" />
  </div>
);

const ParallelNode = ({ data, selected }: { data: ParallelGroupData; selected?: boolean }) => (
  <div
    className={`rounded-xl border-2 border-dashed bg-card/50 px-4 py-3 shadow-md min-w-[200px] transition-all ${
      selected ? "border-sky-500 ring-2 ring-sky-500/30" : "border-sky-500/50"
    }`}
  >
    <Handle type="target" position={Position.Top} className="!bg-sky-500 !w-3 !h-3" />
    <div className="flex items-center gap-2 mb-1">
      <GitBranch className="h-4 w-4 text-sky-500" />
      <span className="text-sm font-semibold text-sky-600 dark:text-sky-400">{data.name}</span>
    </div>
    <p className="text-xs text-muted-foreground">
      {data.branchCount} parallel {data.branchCount === 1 ? "branch" : "branches"}
    </p>
    <Handle type="source" position={Position.Bottom} className="!bg-sky-500 !w-3 !h-3" />
  </div>
);

const nodeTypes: NodeTypes = {
  prompt: PromptNode,
  parallel: ParallelNode,
} as unknown as NodeTypes;

/* ── Conversion: PipelineNode[] ↔ React Flow nodes/edges ── */

type BackendPipelineNode = {
  type?: "prompt" | "parallel";
  name: string;
  prompt?: string;
  tools?: string[] | null;
  model?: string;
  timeoutSeconds?: number;
  branches?: BackendPipelineNode[];
};

let idCounter = 0;
const nextId = () => `pn-${++idCounter}`;

const pipelineToFlow = (
  stages: BackendPipelineNode[]
): { nodes: Node[]; edges: Edge[] } => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let yPos = 0;
  const yGap = 120;
  let prevId: string | null = null;

  for (const stage of stages) {
    const id = nextId();
    const isParallel = stage.type === "parallel";

    if (isParallel) {
      nodes.push({
        id,
        type: "parallel",
        position: { x: 250, y: yPos },
        data: {
          type: "parallel" as const,
          name: stage.name,
          branchCount: stage.branches?.length ?? 0,
        } satisfies ParallelGroupData,
      });
    } else {
      nodes.push({
        id,
        type: "prompt",
        position: { x: 250, y: yPos },
        data: {
          type: "prompt" as const,
          name: stage.name,
          prompt: stage.prompt ?? "",
          tools: stage.tools ?? null,
          model: stage.model,
          timeoutSeconds: stage.timeoutSeconds ?? 300,
        } satisfies PromptStageData,
      });
    }

    if (prevId) {
      edges.push({
        id: `e-${prevId}-${id}`,
        source: prevId,
        target: id,
        type: "smoothstep",
        animated: true,
      });
    }
    prevId = id;
    yPos += yGap;
  }

  return { nodes, edges };
};

const flowToPipeline = (nodes: Node[], edges: Edge[]): BackendPipelineNode[] => {
  // Topological sort based on edges
  const adj = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const node of nodes) {
    adj.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of edges) {
    adj.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const next of adj.get(current) ?? []) {
      const newDeg = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const stages: BackendPipelineNode[] = [];

  for (const id of sorted) {
    const node = nodeMap.get(id);
    if (!node) continue;
    const d = node.data as PipelineNodeData;

    if (d.type === "parallel") {
      stages.push({
        type: "parallel",
        name: d.name,
        branches: [],  // Branches are represented as child nodes in full implementation
      });
    } else {
      stages.push({
        type: "prompt",
        name: d.name,
        prompt: (d as PromptStageData).prompt,
        tools: (d as PromptStageData).tools,
        model: (d as PromptStageData).model,
        timeoutSeconds: (d as PromptStageData).timeoutSeconds,
      });
    }
  }

  return stages;
};

/* ── Stage Editor Sidebar ── */

export type AvailablePrompt = {
  id: string;
  name: string;
  description?: string;
  template?: string;
};

const PromptSelector = ({
  value,
  prompts,
  onChange,
}: {
  value: string;
  prompts: AvailablePrompt[];
  onChange: (prompt: string) => void;
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [search, setSearch] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const filteredPrompts = useMemo(() => {
    if (!search.trim()) return prompts;
    const q = search.toLowerCase();
    return prompts.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)
    );
  }, [prompts, search]);

  const handleTextChange = (text: string) => {
    onChange(text);
    // If user types "/" at the start or after whitespace, show prompt picker
    if (text.endsWith("/") || text === "/") {
      setShowDropdown(true);
      setSearch("");
    }
  };

  const selectPrompt = (prompt: AvailablePrompt) => {
    // Replace any trailing "/" with the prompt template or reference
    const base = value.replace(/\/\s*$/, "");
    const insertion = prompt.template || `{{prompt:${prompt.name}}}`;
    const newValue = base ? `${base}\n${insertion}` : insertion;
    onChange(newValue);
    setShowDropdown(false);
    setSearch("");
    textareaRef.current?.focus();
  };

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">Prompt</span>
        <button
          type="button"
          onClick={() => { setShowDropdown(!showDropdown); setSearch(""); }}
          className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
          title="Select from saved prompts"
        >
          <Search className="h-2.5 w-2.5" /> Browse prompts
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm min-h-[80px] resize-y"
        value={value}
        onChange={(e) => handleTextChange(e.target.value)}
        placeholder='Type a prompt or press "/" to select a saved prompt…'
      />
      {showDropdown && (
        <>
          <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
            <div className="sticky top-0 bg-card p-2 border-b border-border">
              <input
                type="text"
                placeholder="Search saved prompts…"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            {filteredPrompts.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {prompts.length === 0 ? "No saved prompts. Create one in the Library." : "No matches."}
              </p>
            ) : (
              filteredPrompts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectPrompt(p)}
                  className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-muted/50"
                >
                  <span className="text-xs font-medium text-primary">{p.name}</span>
                  {p.description && (
                    <span className="text-[10px] text-muted-foreground truncate">{p.description}</span>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="fixed inset-0 z-40" onClick={() => { setShowDropdown(false); setSearch(""); }} />
        </>
      )}
    </div>
  );
};

const StageEditor = ({
  node,
  onChange,
  onDelete,
  availableTools,
  availablePrompts,
}: {
  node: Node;
  onChange: (id: string, data: Partial<PipelineNodeData>) => void;
  onDelete: (id: string) => void;
  availableTools: ToolOption[];
  availablePrompts: AvailablePrompt[];
}) => {
  const data = node.data as PipelineNodeData;

  if (data.type === "parallel") {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Parallel Group</h3>
        <label className="block">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            value={data.name}
            onChange={(e) => onChange(node.id, { ...data, name: e.target.value })}
          />
        </label>
        <button
          onClick={() => onDelete(node.id)}
          className="flex items-center gap-1 text-xs text-destructive hover:underline"
        >
          <Trash2 className="h-3 w-3" /> Remove
        </button>
      </div>
    );
  }

  const promptData = data as PromptStageData;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Prompt Stage</h3>
      <label className="block">
        <span className="text-xs text-muted-foreground">Name</span>
        <input
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          value={promptData.name}
          onChange={(e) => onChange(node.id, { ...promptData, name: e.target.value })}
        />
      </label>
      <PromptSelector
        value={promptData.prompt}
        prompts={availablePrompts}
        onChange={(prompt) => onChange(node.id, { ...promptData, prompt })}
      />
      <ToolMultiSelect
        label="Tools"
        tools={availableTools}
        selected={promptData.tools}
        onChange={(tools) => onChange(node.id, { ...promptData, tools })}
        placeholder="All tools (no restriction)"
        allowAll
      />
      <label className="block">
        <span className="text-xs text-muted-foreground">Timeout (seconds)</span>
        <input
          type="number"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          value={promptData.timeoutSeconds ?? 300}
          onChange={(e) => onChange(node.id, { ...promptData, timeoutSeconds: Number(e.target.value) })}
        />
      </label>
      <button
        onClick={() => onDelete(node.id)}
        className="flex items-center gap-1 text-xs text-destructive hover:underline"
      >
        <Trash2 className="h-3 w-3" /> Remove Stage
      </button>
    </div>
  );
};

/* ── Main Pipeline Editor ── */

export type PipelineEditorProps = {
  /** Initial pipeline stages (from API or planner). */
  initialStages?: BackendPipelineNode[];
  /** Called when the user saves the pipeline. */
  onSave?: (stages: BackendPipelineNode[]) => void;
  /** Called when the pipeline changes (for controlled mode). */
  onChange?: (stages: BackendPipelineNode[]) => void;
  /** Height of the editor canvas. */
  height?: string;
  /** Whether the editor is read-only (e.g. during execution). */
  readOnly?: boolean;
  /** Available tools for the multi-select in stage editor. */
  availableTools?: ToolOption[];
  /** Available saved prompts for the prompt selector. */
  availablePrompts?: AvailablePrompt[];
};

export const PipelineEditor = ({
  initialStages = [],
  onSave,
  onChange,
  height = "500px",
  readOnly = false,
  availableTools = [],
  availablePrompts = [],
}: PipelineEditorProps) => {
  const initial = useMemo(() => pipelineToFlow(initialStages), []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  const onConnect: OnConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, type: "smoothstep", animated: true }, eds)),
    [setEdges]
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!readOnly) setSelectedNode(node);
    },
    [readOnly]
  );

  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  const addPromptStage = useCallback(() => {
    const id = nextId();
    const yMax = nodes.reduce((max, n) => Math.max(max, n.position.y), -120);
    const newNode: Node = {
      id,
      type: "prompt",
      position: { x: 250, y: yMax + 120 },
      data: {
        type: "prompt" as const,
        name: `stage-${nodes.filter((n) => (n.data as PipelineNodeData).type === "prompt").length + 1}`,
        prompt: "",
        tools: null,
        timeoutSeconds: 300,
      } satisfies PromptStageData,
    };

    // Auto-connect to last node
    const lastNode = nodes[nodes.length - 1];
    setNodes((ns) => [...ns, newNode]);
    if (lastNode) {
      setEdges((es) => [...es, {
        id: `e-${lastNode.id}-${id}`,
        source: lastNode.id,
        target: id,
        type: "smoothstep",
        animated: true,
      }]);
    }
  }, [nodes, setNodes, setEdges]);

  const addParallelGroup = useCallback(() => {
    const id = nextId();
    const yMax = nodes.reduce((max, n) => Math.max(max, n.position.y), -120);
    const newNode: Node = {
      id,
      type: "parallel",
      position: { x: 250, y: yMax + 120 },
      data: {
        type: "parallel" as const,
        name: `parallel-${nodes.filter((n) => (n.data as PipelineNodeData).type === "parallel").length + 1}`,
        branchCount: 2,
      } satisfies ParallelGroupData,
    };

    const lastNode = nodes[nodes.length - 1];
    setNodes((ns) => [...ns, newNode]);
    if (lastNode) {
      setEdges((es) => [...es, {
        id: `e-${lastNode.id}-${id}`,
        source: lastNode.id,
        target: id,
        type: "smoothstep",
        animated: true,
      }]);
    }
  }, [nodes, setNodes, setEdges]);

  const updateNodeData = useCallback(
    (id: string, data: Partial<PipelineNodeData>) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n))
      );
      setSelectedNode((prev) => (prev?.id === id ? { ...prev, data: { ...prev.data, ...data } } : prev));
    },
    [setNodes]
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setSelectedNode(null);
    },
    [setNodes, setEdges]
  );

  const handleSave = useCallback(() => {
    const stages = flowToPipeline(nodes, edges);
    onSave?.(stages);
    onChange?.(stages);
  }, [nodes, edges, onSave, onChange]);

  return (
    <div className="flex gap-4" style={{ height }}>
      {/* Canvas */}
      <div className="flex-1 rounded-xl border border-border overflow-hidden bg-background">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={readOnly ? undefined : onNodesChange}
          onEdgesChange={readOnly ? undefined : onEdgesChange}
          onConnect={readOnly ? undefined : onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          className="bg-background"
        >
          <Background gap={16} size={1} />
          <Controls position="bottom-right" />
          <MiniMap
            position="bottom-left"
            className="!bg-card/80 !border-border !rounded-lg"
            style={{ width: 120, height: 80 }}
            pannable
            zoomable
            nodeColor={(n) => {
              const d = n.data as PipelineNodeData;
              return d.type === "parallel" ? "#38bdf8" : "#10b981";
            }}
          />
          {!readOnly && (
            <Panel position="top-left" className="flex gap-2">
              <button
                onClick={addPromptStage}
                className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 transition"
              >
                <Plus className="h-3 w-3" /> Stage
              </button>
              <button
                onClick={addParallelGroup}
                className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-sky-700 transition"
              >
                <GitBranch className="h-3 w-3" /> Parallel
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 transition"
              >
                <Save className="h-3 w-3" /> Save
              </button>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* Editor Sidebar */}
      {selectedNode && !readOnly && (
        <div className="w-72 shrink-0 rounded-xl border border-border bg-card p-4 overflow-y-auto">
          <StageEditor
            node={selectedNode}
            onChange={updateNodeData}
            onDelete={deleteNode}
            availableTools={availableTools}
            availablePrompts={availablePrompts}
          />
        </div>
      )}
    </div>
  );
};
