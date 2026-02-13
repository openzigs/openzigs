"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ModelInfo, PersonalityConfig, SavedPrompt, ToolInfo } from "@/lib/types";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { SmartTextarea } from "@/components/smart-textarea";
import { PipelineEditor, type BackendPipelineNode, type AvailablePrompt } from "@/components/pipeline/pipeline-editor";
import { WorkflowWizard } from "@/components/pipeline/workflow-wizard";
import { ToolMultiSelect, type ToolOption } from "@/components/pipeline/tool-multi-select";
import { ChevronDown, ChevronUp, Zap, Wrench } from "lucide-react";

export default function LibraryPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [editingPrompt, setEditingPrompt] = useState<SavedPrompt | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);

  const promptsQuery = useQuery({
    queryKey: ["prompts", search],
    queryFn: () => {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      return fetchJson<{ prompts: SavedPrompt[] }>(`/api/admin/prompts${params}`);
    },
  });

  const prompts = promptsQuery.data?.prompts ?? [];

  useEffect(() => {
    const loadTools = async () => {
      try {
        const data = await fetchJson<{ tools: ToolInfo[] | Record<string, ToolInfo[]> }>("/api/tools");
        if (Array.isArray(data.tools)) {
          setTools(data.tools);
        } else if (data.tools && typeof data.tools === "object") {
          setTools(Object.values(data.tools).flat());
        } else {
          setTools([]);
        }
      } catch {
        // Tools not available
      }
    };
    const loadModels = async () => {
      try {
        const data = await fetchJson<{ models: ModelInfo[] }>("/api/models");
        setModels(data.models ?? []);
      } catch {
        // Models not available
      }
    };
    void loadTools();
    void loadModels();
  }, []);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/admin/prompts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      showToast("Prompt deleted", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const applyAsSystemPromptMutation = useMutation({
    mutationFn: (template: string) =>
      fetchJson<PersonalityConfig>("/api/admin/personality", {
        method: "PUT",
        body: JSON.stringify({ systemInstruction: template }),
      }),
    onSuccess: () => {
      showToast("Applied as active system prompt", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleApplyAsSystemPrompt = (prompt: SavedPrompt) => {
    if (!confirm(`Set "${prompt.name}" as the active system prompt? This replaces the current personality system instruction.`)) return;
    applyAsSystemPromptMutation.mutate(prompt.template);
  };

  const handleDelete = (prompt: SavedPrompt) => {
    if (!confirm(`Delete prompt "${prompt.name}"? This cannot be undone.`)) return;
    deleteMutation.mutate(prompt.id);
  };

  const handleEdit = (prompt: SavedPrompt) => {
    setEditingPrompt(prompt);
    setShowForm(true);
  };

  const handleNew = () => {
    setEditingPrompt(null);
    setShowForm(true);
  };

  const handleFormClose = () => {
    setShowForm(false);
    setEditingPrompt(null);
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 lg:px-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">Prompt Library</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create, edit, and manage reusable prompt templates.
        </p>
      </header>

      {/* Search + New */}
      <div className="mb-6 flex items-center gap-3">
        <input
          type="text"
          placeholder="Search prompts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground"
        />
        <button
          onClick={handleNew}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          + New Prompt
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="mb-6">
          <PromptForm
            existing={editingPrompt}
            onClose={handleFormClose}
            tools={tools}
            models={models}
            prompts={prompts}
          />
        </div>
      )}

      {/* List */}
      <SectionCard title="Saved Prompts">
        {promptsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : prompts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? "No prompts match your search." : 'No prompts saved yet. Click "+ New Prompt" to create one.'}
          </p>
        ) : (
          <div className="space-y-3">
            {prompts.map((prompt) => (
              <div key={prompt.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{prompt.name}</p>
                    {prompt.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{prompt.description}</p>
                    )}
                    <pre className="mt-2 line-clamp-3 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                      {prompt.template.length > 300
                        ? prompt.template.slice(0, 300) + "…"
                        : prompt.template}
                    </pre>
                  </div>
                  <div className="ml-3 flex shrink-0 gap-2">
                    <button
                      onClick={() => handleApplyAsSystemPrompt(prompt)}
                      title="Use this prompt as the active system instruction in AI Personality"
                      className="rounded-lg border border-moss/30 px-3 py-1.5 text-xs font-semibold text-moss hover:bg-moss/5"
                    >
                      Use as System Prompt
                    </button>
                    <button
                      onClick={() => handleEdit(prompt)}
                      className="rounded-lg border border-primary px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(prompt)}
                      className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {prompt.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {prompt.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-2">
                  {prompt.stages && prompt.stages.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                      <Zap className="h-2.5 w-2.5" />
                      {prompt.stages.length} stage{prompt.stages.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {prompt.preferredTools && prompt.preferredTools.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                      <Wrench className="h-2.5 w-2.5" />
                      {prompt.preferredTools.length} tool{prompt.preferredTools.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Updated {new Date(prompt.updatedAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <ToastContainer />
    </main>
  );
}

/* ── Prompt Form (create / edit) ── */

const PromptForm = ({
  existing,
  onClose,
  tools,
  models,
  prompts,
}: {
  existing: SavedPrompt | null;
  onClose: () => void;
  tools: ToolInfo[];
  models: ModelInfo[];
  prompts: SavedPrompt[];
}) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [template, setTemplate] = useState(existing?.template ?? "");
  const [tagsInput, setTagsInput] = useState(existing?.tags.join(", ") ?? "");

  // Pipeline stages state
  const [showPipeline, setShowPipeline] = useState(
    () => !!(existing?.stages && existing.stages.length > 0)
  );
  const [pipelineStages, setPipelineStages] = useState<BackendPipelineNode[]>(
    () => (existing?.stages as BackendPipelineNode[] | null) ?? []
  );
  const [pipelineMode, setPipelineMode] = useState<"wizard" | "manual">("manual");

  // Preferred tools state
  const [preferredTools, setPreferredTools] = useState<string[] | null>(
    existing?.preferredTools ?? null
  );

  // Build ToolOption[] and AvailablePrompt[] for sub-components
  const toolOptions: ToolOption[] = useMemo(
    () => tools.map((t) => ({ name: t.name, description: t.description, category: t.category, enabled: t.enabled })),
    [tools]
  );
  const availablePrompts: AvailablePrompt[] = useMemo(
    () => prompts.map((p) => ({ id: p.id, name: p.name, description: p.description, template: p.template })),
    [prompts]
  );

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => {
      const url = existing ? `/api/admin/prompts/${existing.id}` : "/api/admin/prompts";
      const method = existing ? "PUT" : "POST";
      return fetchJson(url, { method, body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      showToast(existing ? "Prompt updated" : "Prompt saved", "success");
      onClose();
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleSave = () => {
    if (!name.trim() || !template.trim()) {
      showToast("Name and template are required.", "error");
      return;
    }
    saveMutation.mutate({
      name: name.trim(),
      template: template.trim(),
      description: description.trim(),
      tags: tagsInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      stages: pipelineStages.length > 0 ? pipelineStages : null,
      preferredTools: preferredTools,
    });
  };

  const handlePipelineChange = (stages: BackendPipelineNode[]) => {
    setPipelineStages(stages);
  };

  const handleWizardComplete = (pipeline: { stages: BackendPipelineNode[] }) => {
    setPipelineStages(pipeline.stages);
    setPipelineMode("manual"); // Switch to manual view to see the result
  };

  // Variable preview
  const variables = useMemo(() => {
    const matches = template.match(/\{\{(\w+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.replace(/[{}]/g, "")))];
  }, [template]);

  return (
    <div className="rounded-2xl border border-primary/20 bg-card p-5">
      <h3 className="mb-4 text-lg font-semibold text-foreground">
        {existing ? "Edit Prompt" : "New Prompt"}
      </h3>

      <div className="space-y-3">
        <Field label="Name">
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
            placeholder="e.g., daily-summary"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>

        <Field label="Description" hint="Optional — helps you remember what it's for.">
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
            placeholder="What this prompt does…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field label="Template">
          <SmartTextarea
            className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-foreground"
            rows={8}
            placeholder={"Write your prompt template here.\nUse {{variable}} for dynamic placeholders."}
            value={template}
            onValueChange={setTemplate}
            tools={tools}
            models={models}
            prompts={prompts}
          />
          {variables.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-ink/40">Variables:</span>
              {variables.map((v) => (
                <code key={v} className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
                  {`{{${v}}}`}
                </code>
              ))}
            </div>
          )}
        </Field>

        <Field label="Tags" hint="Comma-separated. Used for filtering.">
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
            placeholder="marketing, daily, report"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />
        </Field>

        {/* Preferred Tools */}
        <div className="space-y-1">
          <ToolMultiSelect
            tools={toolOptions}
            selected={preferredTools}
            onChange={setPreferredTools}
            label="Preferred Tools"
            placeholder="Default (all tools available)"
            allowAll
          />
          <p className="text-[11px] text-muted-foreground/60">
            Restrict which tools this prompt can use. Leave empty for all tools.
          </p>
        </div>

        {/* Pipeline Stages — collapsible progressive disclosure */}
        <div className="rounded-xl border border-primary/20 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowPipeline(!showPipeline)}
            className="w-full flex items-center justify-between px-4 py-3 bg-card hover:bg-muted/50 transition-colors"
          >
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Zap className="h-4 w-4 text-emerald-500" />
              Pipeline Stages
              {pipelineStages.length > 0 && (
                <span className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold">
                  {pipelineStages.length} stage{pipelineStages.length !== 1 ? "s" : ""}
                </span>
              )}
            </span>
            <span className="text-muted-foreground">
              {showPipeline ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>
          </button>

          {showPipeline && (
            <div className="p-4 border-t border-primary/10 space-y-3">
              <p className="text-xs text-muted-foreground">
                When triggered by the scheduler, this prompt executes as a multi-stage pipeline.
                Each stage runs sequentially with its own instructions, tool access, and optional post-actions.
              </p>

              {/* Mode chooser */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPipelineMode("wizard")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                    pipelineMode === "wizard"
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  🧙 Workflow Wizard
                </button>
                <button
                  type="button"
                  onClick={() => setPipelineMode("manual")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                    pipelineMode === "manual"
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  🔧 Manual Editor
                </button>
              </div>

              {/* Editor content */}
              {pipelineMode === "wizard" ? (
                <WorkflowWizard
                  onComplete={handleWizardComplete}
                  onCancel={() => setPipelineMode("manual")}
                  availableTools={toolOptions}
                  availablePrompts={availablePrompts}
                />
              ) : (
                <PipelineEditor
                  initialStages={pipelineStages}
                  onSave={handlePipelineChange}
                  onChange={handlePipelineChange}
                  height="400px"
                  availableTools={toolOptions}
                  availablePrompts={availablePrompts}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {saveMutation.isPending ? "Saving…" : existing ? "Update Prompt" : "Save Prompt"}
          </button>
        </div>
      </div>
    </div>
  );
};

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="space-y-1">
    <label className="text-xs font-medium text-muted-foreground">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-muted-foreground/60">{hint}</p>}
  </div>
);
