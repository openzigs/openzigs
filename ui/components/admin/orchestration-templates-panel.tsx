"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { OrchestrationTemplate, OrchestrationStage, StageAgent, TemplateVariable } from "@/lib/types";
import { Play, Pencil, Trash2, Plus, X, GripVertical, Lock } from "lucide-react";

const CATEGORIES = ["research", "analysis", "content", "dev", "custom"] as const;
const ARCHETYPES = ["researcher", "coder", "writer", "analyst", "assistant"] as const;

/* ── Template Card ── */
function TemplateCard({
  template,
  onEdit,
  onDelete,
  onExecute,
}: {
  template: OrchestrationTemplate;
  onEdit: () => void;
  onDelete: () => void;
  onExecute: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-foreground truncate">{template.name}</h3>
            {template.isBuiltIn && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                <Lock className="h-3 w-3" /> Built-in
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{template.description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          {template.category}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{template.stages.length} stage{template.stages.length !== 1 ? "s" : ""}</span>
        <span>{template.variables.length} variable{template.variables.length !== 1 ? "s" : ""}</span>
        <span>{template.stages.reduce((n, s) => n + s.agents.length, 0)} agent{template.stages.reduce((n, s) => n + s.agents.length, 0) !== 1 ? "s" : ""}</span>
      </div>
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <button onClick={onExecute} className="flex items-center gap-1 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition">
          <Play className="h-3 w-3" /> Execute
        </button>
        <button onClick={onEdit} className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/80 transition">
          <Pencil className="h-3 w-3" /> Edit
        </button>
        {!template.isBuiltIn && (
          <button onClick={onDelete} className="flex items-center gap-1 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 transition ml-auto">
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Stage Builder ── */
function StageBuilder({
  stages,
  onChange,
}: {
  stages: OrchestrationStage[];
  onChange: (stages: OrchestrationStage[]) => void;
}) {
  const addStage = () => {
    onChange([
      ...stages,
      {
        name: `stage-${stages.length + 1}`,
        type: "sequential",
        agents: [{ archetype: "researcher", goal: "", model: null, allowedTools: [], autoApproveTools: [] }],
        dependsOn: [],
      },
    ]);
  };

  const removeStage = (idx: number) => {
    onChange(stages.filter((_, i) => i !== idx));
  };

  const updateStage = (idx: number, patch: Partial<OrchestrationStage>) => {
    onChange(stages.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const addAgent = (stageIdx: number) => {
    const stage = stages[stageIdx];
    updateStage(stageIdx, {
      agents: [...stage.agents, { archetype: "researcher", goal: "", model: null, allowedTools: [], autoApproveTools: [] }],
    });
  };

  const removeAgent = (stageIdx: number, agentIdx: number) => {
    const stage = stages[stageIdx];
    updateStage(stageIdx, { agents: stage.agents.filter((_, i) => i !== agentIdx) });
  };

  const updateAgent = (stageIdx: number, agentIdx: number, patch: Partial<StageAgent>) => {
    const stage = stages[stageIdx];
    updateStage(stageIdx, {
      agents: stage.agents.map((a, i) => (i === agentIdx ? { ...a, ...patch } : a)),
    });
  };

  return (
    <div className="space-y-3">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Stages</label>
      {stages.map((stage, si) => (
        <div key={si} className="rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <GripVertical className="h-4 w-4 text-muted-foreground" />
            <input
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={stage.name}
              onChange={(e) => updateStage(si, { name: e.target.value })}
              placeholder="Stage name"
            />
            <select
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={stage.type}
              onChange={(e) => updateStage(si, { type: e.target.value as "parallel" | "sequential" })}
            >
              <option value="sequential">Sequential</option>
              <option value="parallel">Parallel</option>
            </select>
            <button onClick={() => removeStage(si)} className="text-destructive hover:text-destructive/80">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="pl-6 space-y-2">
            {stage.agents.map((agent, ai) => (
              <div key={ai} className="flex items-start gap-2 rounded-md border border-dashed border-border p-2">
                <select
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs w-28"
                  value={agent.archetype}
                  onChange={(e) => updateAgent(si, ai, { archetype: e.target.value })}
                >
                  {ARCHETYPES.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
                <input
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
                  value={agent.goal}
                  onChange={(e) => updateAgent(si, ai, { goal: e.target.value })}
                  placeholder="Agent goal (use {{variable}} for templates)"
                />
                <button onClick={() => removeAgent(si, ai)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button onClick={() => addAgent(si)} className="text-xs text-primary hover:underline flex items-center gap-1">
              <Plus className="h-3 w-3" /> Add Agent
            </button>
          </div>
        </div>
      ))}
      <button onClick={addStage} className="text-xs text-primary hover:underline flex items-center gap-1">
        <Plus className="h-3 w-3" /> Add Stage
      </button>
    </div>
  );
}

/* ── Variable Preview ── */
function VariablePreview({ stages }: { stages: OrchestrationStage[] }) {
  const vars = new Set<string>();
  for (const stage of stages) {
    for (const agent of stage.agents) {
      const matches = agent.goal.matchAll(/\{\{(\w+)\}\}/g);
      for (const m of matches) vars.add(m[1]);
    }
  }
  if (vars.size === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/50 p-3">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Detected Variables</label>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {[...vars].map((v) => (
          <span key={v} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {`{{${v}}}`}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Execute Modal ── */
function TemplateExecuteModal({
  template,
  onClose,
}: {
  template: OrchestrationTemplate;
  onClose: () => void;
}) {
  const [vars, setVars] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of template.variables) {
      init[v.name] = v.defaultValue ?? "";
    }
    return init;
  });
  const [taskIds, setTaskIds] = useState<string[] | null>(null);

  const executeMut = useMutation({
    mutationFn: () =>
      fetchJson<{ taskIds: string[] }>(`/api/admin/orchestration/${template.id}/execute`, {
        method: "POST",
        body: JSON.stringify({ variables: vars }),
      }),
    onSuccess: (data) => {
      setTaskIds(data.taskIds);
      showToast(`Spawned ${data.taskIds.length} task(s)`, "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">Execute: {template.name}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
        </div>
        {template.variables.length > 0 && (
          <div className="space-y-3">
            {template.variables.map((v) => (
              <div key={v.name}>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {v.name} {v.required && <span className="text-destructive">*</span>}
                </label>
                {v.description && <p className="text-[10px] text-muted-foreground mb-1">{v.description}</p>}
                <input
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={vars[v.name] ?? ""}
                  onChange={(e) => setVars({ ...vars, [v.name]: e.target.value })}
                  placeholder={v.defaultValue ?? undefined}
                />
              </div>
            ))}
          </div>
        )}
        {taskIds ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Spawned {taskIds.length} task(s):</p>
            <div className="flex flex-wrap gap-1.5">
              {taskIds.map((id) => (
                <a key={id} href={`/tasks`} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-mono text-primary hover:underline">
                  {id.slice(0, 8)}…
                </a>
              ))}
            </div>
          </div>
        ) : (
          <button
            onClick={() => executeMut.mutate()}
            disabled={executeMut.isPending}
            className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition"
          >
            {executeMut.isPending ? "Executing…" : "Execute Template"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Template Form ── */
function TemplateForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: OrchestrationTemplate;
  onSave: (data: {
    name: string;
    description: string;
    category: string;
    stages: OrchestrationStage[];
    variables: TemplateVariable[];
    aggregationPrompt: string | null;
  }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? "custom");
  const [stages, setStages] = useState<OrchestrationStage[]>(
    initial?.stages ?? [
      {
        name: "stage-1",
        type: "sequential",
        agents: [{ archetype: "researcher", goal: "", model: null, allowedTools: [], autoApproveTools: [] }],
        dependsOn: [],
      },
    ]
  );
  const [aggregationPrompt, setAggregationPrompt] = useState(initial?.aggregationPrompt ?? "");

  // Auto-detect variables from stage goals
  const detectedVars = new Set<string>();
  for (const stage of stages) {
    for (const agent of stage.agents) {
      const matches = agent.goal.matchAll(/\{\{(\w+)\}\}/g);
      for (const m of matches) detectedVars.add(m[1]);
    }
  }

  const variables: TemplateVariable[] = [...detectedVars].map((v) => {
    const existing = initial?.variables.find((iv) => iv.name === v);
    return existing ?? { name: v, description: "", required: true, defaultValue: null };
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ name, description, category, stages, variables, aggregationPrompt: aggregationPrompt || null });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
          <input className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Category</label>
          <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
        <textarea className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <StageBuilder stages={stages} onChange={setStages} />
      <VariablePreview stages={stages} />
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">Aggregation Prompt (optional)</label>
        <textarea className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" rows={2} value={aggregationPrompt} onChange={(e) => setAggregationPrompt(e.target.value)} placeholder="Combine the agent outputs into…" />
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <button type="submit" disabled={saving || !name || stages.length === 0} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition">
          {saving ? "Saving…" : initial ? "Update Template" : "Create Template"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition">Cancel</button>
      </div>
    </form>
  );
}

/* ── Main Panel ── */
export function OrchestrationTemplatesPanel() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [executingTemplate, setExecutingTemplate] = useState<OrchestrationTemplate | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const templatesQuery = useQuery({
    queryKey: ["orchestration-templates"],
    queryFn: () => fetchJson<{ templates: OrchestrationTemplate[] }>("/api/admin/orchestration"),
  });

  const createMut = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetchJson("/api/admin/orchestration", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orchestration-templates"] });
      setCreating(false);
      showToast("Template created", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      fetchJson(`/api/admin/orchestration/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orchestration-templates"] });
      setEditingId(null);
      showToast("Template updated", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/orchestration/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orchestration-templates"] });
      setConfirmDelete(null);
      showToast("Template deleted", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const templates = templatesQuery.data?.templates ?? [];
  const editingTemplate = templates.find((t) => t.id === editingId);

  if (creating) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">New Orchestration Template</h3>
        <TemplateForm
          onSave={(data) => createMut.mutate(data)}
          onCancel={() => setCreating(false)}
          saving={createMut.isPending}
        />
      </div>
    );
  }

  if (editingTemplate) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Edit: {editingTemplate.name}</h3>
        <TemplateForm
          initial={editingTemplate}
          onSave={(data) => updateMut.mutate({ id: editingTemplate.id, data })}
          onCancel={() => setEditingId(null)}
          saving={updateMut.isPending}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {templates.length} template{templates.length !== 1 ? "s" : ""} configured
        </p>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition"
        >
          <Plus className="h-3.5 w-3.5" /> New Template
        </button>
      </div>

      {templatesQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {templates.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            onEdit={() => setEditingId(t.id)}
            onDelete={() => setConfirmDelete(t.id)}
            onExecute={() => setExecutingTemplate(t)}
          />
        ))}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmDelete(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-xl p-6 space-y-3 max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-foreground">Delete Template?</h3>
            <p className="text-xs text-muted-foreground">This action cannot be undone.</p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => deleteMut.mutate(confirmDelete)} className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 transition">Delete</button>
              <button onClick={() => setConfirmDelete(null)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted transition">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Execute modal */}
      {executingTemplate && (
        <TemplateExecuteModal template={executingTemplate} onClose={() => setExecutingTemplate(null)} />
      )}
    </div>
  );
}
