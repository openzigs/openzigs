"use client";

import { useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { CustomAgentDefinition, ToolInfo } from "@/lib/types";
import { showToast } from "@/components/toast";
import { Plus, Edit, Trash2, Bot, Zap, RotateCw, X } from "lucide-react";

const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export const AgentsPanel = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["agents"],
    queryFn: () => fetchJson<{ agents: CustomAgentDefinition[] }>("/api/admin/agents"),
  });

  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => fetchJson<{ tools: Record<string, ToolInfo[]> }>("/api/admin/tools"),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<CustomAgentDefinition | null>(null);

  const saveMutation = useMutation({
    mutationFn: (payload: { agents: CustomAgentDefinition[] }) =>
      fetchJson("/api/admin/agents", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      fetchJson(`/api/admin/agents/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      showToast("Agent deleted", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleDelete = (name: string) => {
    if (!confirm(`Delete agent "${name}"? This action cannot be undone.`)) return;
    deleteMutation.mutate(name);
  };

  const handleEdit = (agent: CustomAgentDefinition) => {
    setEditingAgent(agent);
    setDialogOpen(true);
  };

  const handleCreate = () => {
    setEditingAgent(null);
    setDialogOpen(true);
  };

  const handleSave = (agent: CustomAgentDefinition) => {
    const existingAgents = query.data?.agents ?? [];
    const isEdit = !!editingAgent;
    let nextAgents: CustomAgentDefinition[];

    if (isEdit) {
      // Replace existing agent by name (invariant: name cannot change in edit mode)
      nextAgents = existingAgents.map((a) => (a.name === agent.name ? agent : a));
    } else {
      // Append new agent
      nextAgents = [...existingAgents, agent];
    }

    saveMutation.mutate(
      { agents: nextAgents },
      {
        onSuccess: () => {
          showToast(isEdit ? "Agent updated" : "Agent created", "success");
          setDialogOpen(false);
        },
      }
    );
  };

  const agents = query.data?.agents ?? [];
  const allTools = Object.values(toolsQuery.data?.tools ?? {}).flat();

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading agents…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{agents.length} agent{agents.length !== 1 ? "s" : ""} defined</p>
        <button
          onClick={handleCreate}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          New Agent
        </button>
      </div>

      {agents.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No custom agents defined. Click &ldquo;New Agent&rdquo; to create one.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              onEdit={() => handleEdit(agent)}
              onDelete={() => handleDelete(agent.name)}
            />
          ))}
        </div>
      )}

      {dialogOpen && (
        <AgentEditorDialog
          agent={editingAgent}
          allTools={allTools}
          onSave={handleSave}
          isSaving={saveMutation.isPending}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
};

/* ── Agent Card ── */

const AgentCard = ({
  agent,
  onEdit,
  onDelete,
}: {
  agent: CustomAgentDefinition;
  onEdit: () => void;
  onDelete: () => void;
}) => (
  <div className="rounded-2xl border border-border bg-card p-4">
    <div className="mb-2 flex items-start justify-between">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">{agent.displayName}</span>
      </div>
      {agent.infer && (
        <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
          <Zap className="h-3 w-3" />
          Auto-invoke
        </span>
      )}
    </div>
    {agent.description && (
      <p className="mb-2 text-xs text-muted-foreground">{agent.description}</p>
    )}
    {agent.tools && agent.tools.length > 0 && (
      <div className="mb-3 flex flex-wrap gap-1">
        {agent.tools.slice(0, 5).map((tool) => (
          <span key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {tool}
          </span>
        ))}
        {agent.tools.length > 5 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            +{agent.tools.length - 5} more
          </span>
        )}
      </div>
    )}
    <div className="flex gap-2">
      <button
        onClick={onEdit}
        className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:border-primary/30"
      >
        <Edit className="h-3 w-3" />
        Edit
      </button>
      <button
        onClick={onDelete}
        className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-destructive hover:border-destructive/30"
      >
        <Trash2 className="h-3 w-3" />
        Delete
      </button>
    </div>
  </div>
);

/* ── Agent Editor Dialog ── */

const AgentEditorDialog = ({
  agent,
  allTools,
  onSave,
  isSaving,
  onClose,
}: {
  agent: CustomAgentDefinition | null;
  allTools: ToolInfo[];
  onSave: (agent: CustomAgentDefinition) => void;
  isSaving: boolean;
  onClose: () => void;
}) => {
  const isEdit = !!agent;

  const [name, setName] = useState(agent?.name ?? "");
  const [displayName, setDisplayName] = useState(agent?.displayName ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools ?? []);
  const [infer, setInfer] = useState(agent?.infer ?? true);
  const [errors, setErrors] = useState<string[]>([]);

  const validate = useCallback((): string[] => {
    const errs: string[] = [];
    if (!name) errs.push("Name is required");
    else if (!NAME_REGEX.test(name)) errs.push("Name must be lowercase alphanumeric with hyphens");
    if (!displayName.trim()) errs.push("Display name is required");
    if (!prompt.trim()) errs.push("System prompt is required");
    if (selectedTools.length === 0) errs.push("At least one tool must be selected");
    return errs;
  }, [name, displayName, prompt, selectedTools]);

  const handleSave = () => {
    const errs = validate();
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    onSave({
      name,
      displayName: displayName.trim(),
      description: description.trim() || undefined,
      prompt: prompt.trim(),
      tools: selectedTools,
      infer,
    });
  };

  const toggleTool = (toolName: string) => {
    setSelectedTools((prev) =>
      prev.includes(toolName)
        ? prev.filter((t) => t !== toolName)
        : [...prev, toolName]
    );
  };

  // Group tools by category
  const toolsByCategory = allTools.reduce<Record<string, ToolInfo[]>>((acc, tool) => {
    const cat = tool.category || "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(tool);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={isEdit ? "Edit Custom Agent" : "Create Custom Agent"}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        <h3 className="mb-4 text-lg font-semibold text-foreground">
          {isEdit ? "Edit Custom Agent" : "Create Custom Agent"}
        </h3>

        {errors.length > 0 && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            {errors.map((e, i) => (
              <p key={i} className="text-xs text-destructive">{e}</p>
            ))}
          </div>
        )}

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name (identifier)</label>
            <input
              type="text"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground disabled:opacity-40"
              placeholder="researcher"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              disabled={isEdit}
            />
          </div>

          {/* Display Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Display Name</label>
            <input
              type="text"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Research Agent"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <input
              type="text"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Web research, data gathering, summarization"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* System Prompt */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">System Prompt</label>
            <textarea
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
              rows={4}
              placeholder="You are a research specialist. Focus on gathering accurate information…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          {/* Tool Selector */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Allowed Tools ({selectedTools.length} selected)
            </label>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted/30 p-2">
              {Object.entries(toolsByCategory).sort(([a], [b]) => a.localeCompare(b)).map(([category, tools]) => (
                <div key={category} className="mb-2 last:mb-0">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{category}</p>
                  <div className="flex flex-wrap gap-1">
                    {tools.map((tool) => (
                      <button
                        key={tool.name}
                        onClick={() => toggleTool(tool.name)}
                        className={`rounded px-2 py-0.5 font-mono text-[10px] transition ${
                          selectedTools.includes(tool.name)
                            ? "bg-primary/15 text-primary"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                      >
                        {selectedTools.includes(tool.name) ? "☑" : "☐"} {tool.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {allTools.length === 0 && (
                <p className="text-xs text-muted-foreground">No tools available</p>
              )}
            </div>
          </div>

          {/* Auto-invoke */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-foreground">Auto-invoke (infer)</p>
              <p className="text-[11px] text-muted-foreground/60">
                When enabled, the model can delegate to this agent automatically.
              </p>
            </div>
            <button
              onClick={() => setInfer(!infer)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                infer ? "bg-moss" : "bg-muted"
              }`}
              role="switch"
              aria-checked={infer}
              aria-label="Auto-invoke"
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  infer ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Dialog Actions */}
        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {isSaving ? (
              <><RotateCw className="h-3.5 w-3.5 animate-spin" />Saving…</>
            ) : (
              isEdit ? "Save Agent" : "Create Agent"
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
