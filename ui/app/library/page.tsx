"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { PersonalityConfig, SavedPrompt, ToolInfo } from "@/lib/types";
import { buildUrl } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { PipelineEditor, type BackendPipelineNode, type AvailablePrompt } from "@/components/pipeline/pipeline-editor";
import { WorkflowWizard } from "@/components/pipeline/workflow-wizard";
import { ToolMultiSelect, type ToolOption } from "@/components/pipeline/tool-multi-select";
import { ImportWizard } from "@/components/library/import-wizard";
import { ChevronDown, ChevronUp, Download, FileUp, Zap, Wrench, PenTool, Sparkles, AlertTriangle, Calendar, LayoutTemplate } from "lucide-react";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";
import { TemplateAutocomplete, BUILT_IN_VARIABLES } from "@/components/template-autocomplete";

export default function LibraryPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [editingPrompt, setEditingPrompt] = useState<SavedPrompt | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const [tools, setTools] = useState<ToolInfo[]>([]);

  const promptsQuery = useQuery({
    queryKey: ["prompts", search],
    queryFn: () => {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      return fetchJson<{ prompts: SavedPrompt[] }>(`/api/admin/prompts${params}`);
    },
  });

  const prompts = promptsQuery.data?.prompts ?? [];

  type PipelineTemplate = {
    id: string; name: string; description: string; icon: string; tags: string[];
    suggestedSkill: string | null; template: string;
    stages: BackendPipelineNode[]; variables: { key: string; label: string; description: string; required: boolean; default?: string }[];
    builtIn: boolean;
  };

  const templatesQuery = useQuery({
    queryKey: ["pipeline-templates"],
    queryFn: () => fetchJson<PipelineTemplate[]>("/api/admin/pipeline-templates"),
    enabled: showTemplateGallery,
  });

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
    void loadTools();
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

  const handleExport = async (prompt: SavedPrompt) => {
    try {
      const response = await fetch(buildUrl(`/api/admin/prompts/${prompt.id}/export`), {
        headers: process.env.NEXT_PUBLIC_OPENZIGS_TOKEN
          ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENZIGS_TOKEN}` }
          : {},
      });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${prompt.name.toLowerCase().replace(/\s+/g, "-")}.openzigs-template.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Template exported", "success");
    } catch (err) {
      showToast(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    }
  };

  const handleFormClose = () => {
    setShowForm(false);
    setEditingPrompt(null);
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 lg:px-12">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">Prompt Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create, edit, and manage reusable prompt templates.
          </p>
        </div>
        <AskAiButton onClick={() => setAskAiOpen(true)} />
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
          onClick={() => setShowImportWizard(true)}
          className="rounded-xl border border-primary px-5 py-2.5 text-sm font-semibold text-primary hover:bg-primary/5"
        >
          <span className="flex items-center gap-1.5">
            <FileUp className="h-4 w-4" />
            Import
          </span>
        </button>
        <button
          onClick={() => setShowTemplateGallery(true)}
          className="rounded-xl border border-primary px-5 py-2.5 text-sm font-semibold text-primary hover:bg-primary/5"
        >
          <span className="flex items-center gap-1.5">
            <LayoutTemplate className="h-4 w-4" />
            From Template
          </span>
        </button>
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
                      onClick={() => router.push(`/scheduler?createFrom=${encodeURIComponent(prompt.name)}`)}
                      title="Create a scheduled job from this prompt"
                      className="rounded-lg border border-amber-500/30 px-3 py-1.5 text-xs font-semibold text-amber-600 hover:bg-amber-500/5 dark:text-amber-400"
                    >
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Schedule
                      </span>
                    </button>
                    <button
                      onClick={() => handleExport(prompt)}
                      title="Export as shareable template file"
                      className="rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5"
                    >
                      <span className="flex items-center gap-1">
                        <Download className="h-3 w-3" />
                        Export
                      </span>
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
                  {prompt.suggestedSkill && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
                      <Sparkles className="h-2.5 w-2.5" />
                      {prompt.suggestedSkill}
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
      {showImportWizard && <ImportWizard onClose={() => setShowImportWizard(false)} />}

      {/* Pipeline Template Gallery */}
      {showTemplateGallery && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowTemplateGallery(false)}>
          <div className="w-full max-w-3xl rounded-2xl bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Pipeline Templates</h2>
              <button onClick={() => setShowTemplateGallery(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            {templatesQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading templates…</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {(templatesQuery.data ?? []).map((t) => (
                  <button
                    key={t.id}
                    onClick={async () => {
                      try {
                        const created = await fetchJson<SavedPrompt>("/api/admin/prompts", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            name: t.name,
                            template: t.template,
                            description: t.description,
                            tags: t.tags,
                            stages: t.stages,
                            suggestedSkill: t.suggestedSkill,
                          }),
                        });
                        queryClient.invalidateQueries({ queryKey: ["prompts"] });
                        setShowTemplateGallery(false);
                        showToast(`Created "${created.name}" from template`, "success");
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : "Failed to create prompt", "error");
                      }
                    }}
                    className="flex flex-col items-start gap-2 rounded-xl border border-border bg-background p-4 text-left hover:border-primary hover:bg-primary/5 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{t.icon}</span>
                      <span className="font-semibold text-foreground">{t.name}</span>
                      {t.builtIn && <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Built-in</span>}
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {t.tags.map((tag) => (
                        <span key={tag} className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{tag}</span>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground">{t.stages.length} stage{t.stages.length !== 1 ? "s" : ""}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ToastContainer />
      <AskAiPanel pageContext={PAGE_CONTEXTS["library"]} open={askAiOpen} onClose={() => setAskAiOpen(false)} />
    </main>
  );
}

/* ── Prompt Form (create / edit) ── */

const PromptForm = ({
  existing,
  onClose,
  tools,
  prompts,
}: {
  existing: SavedPrompt | null;
  onClose: () => void;
  tools: ToolInfo[];
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

  // Suggested skill state
  const [suggestedSkill, setSuggestedSkill] = useState<string | null>(existing?.suggestedSkill ?? null);

  // Brand voice state
  const [brandVoiceId, setBrandVoiceId] = useState<string | null>(existing?.brandVoiceId ?? null);
  const voicesQuery = useQuery({
    queryKey: ["brand-voices"],
    queryFn: () => fetchJson<{ voices: Array<{ id: string; name: string; active: boolean }> }>("/api/admin/brand-voice"),
  });
  const voices = voicesQuery.data?.voices ?? [];

  // Skills list (dynamic from API)
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () => fetchJson<{ skills: Array<{ name: string }> }>("/api/admin/skills"),
  });
  const skillsList = skillsQuery.data?.skills ?? [];

  // Scheduler cross-reference: find jobs that use this prompt
  const linkedJobsQuery = useQuery({
    queryKey: ["linked-jobs", existing?.name],
    queryFn: () => fetchJson<{ jobs: Array<{ id: string; name: string; cronExpression: string; enabled: boolean }> }>(
      `/api/admin/jobs?promptName=${encodeURIComponent(existing?.name ?? "")}`
    ),
    enabled: !!existing?.name,
  });
  const linkedJobs = linkedJobsQuery.data?.jobs ?? [];

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
      brandVoiceId: brandVoiceId,
      suggestedSkill: suggestedSkill,
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

  // Unresolved variable validation: warn about variables not in built-in or presets
  const builtInNames = useMemo(() => new Set(BUILT_IN_VARIABLES.map((v) => v.name)), []);
  const unresolvedVars = useMemo(
    () => variables.filter((v) => !builtInNames.has(v)),
    [variables, builtInNames]
  );

  // Live preview with built-in defaults
  const [showPreview, setShowPreview] = useState(false);
  const [previewDefaults, setPreviewDefaults] = useState<Record<string, string>>({});
  const previewText = useMemo(() => {
    const now = new Date();
    const builtInDefaults: Record<string, string> = {
      today: now.toISOString().slice(0, 10),
      now: now.toISOString(),
      day_of_week: now.toLocaleDateString("en-US", { weekday: "long" }),
      month: now.toLocaleDateString("en-US", { month: "long" }),
      year: String(now.getFullYear()),
    };
    const merged = { ...builtInDefaults, ...previewDefaults };
    return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
      key in merged ? merged[key] : `{{${key}}}`
    );
  }, [template, previewDefaults]);

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
          <TemplateAutocomplete
            className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-foreground"
            rows={8}
            placeholder={"Write your prompt template here.\nUse {{variable}} for dynamic placeholders."}
            value={template}
            onChange={setTemplate}
            customVariables={variables}
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
          {/* Unresolved variable validation warning */}
          {unresolvedVars.length > 0 && (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-amber-300/30 bg-amber-50/50 dark:bg-amber-900/10 px-2.5 py-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
              <div className="text-[11px] text-amber-700 dark:text-amber-400">
                <span className="font-medium">Custom variables:</span>{" "}
                {unresolvedVars.map((v) => (
                  <code key={v} className="mx-0.5 rounded bg-amber-200/30 px-1 font-mono">{`{{${v}}}`}</code>
                ))}
                — will be left as literal text if not provided at execution time.
              </div>
            </div>
          )}
          {/* Live Preview toggle */}
          {template && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowPreview(!showPreview)}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                {showPreview ? "Hide Preview" : "Show Live Preview"}
              </button>
              {showPreview && (
                <div className="mt-1.5 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="mb-2 flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-muted-foreground">Preview (with defaults)</span>
                  </div>
                  {/* Editable default inputs for custom variables */}
                  {unresolvedVars.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {unresolvedVars.map((v) => (
                        <div key={v} className="flex items-center gap-1">
                          <label className="font-mono text-[10px] text-muted-foreground">{v}:</label>
                          <input
                            type="text"
                            className="w-28 rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground"
                            placeholder={`value for ${v}`}
                            value={previewDefaults[v] ?? ""}
                            onChange={(e) =>
                              setPreviewDefaults((d) => ({ ...d, [v]: e.target.value }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/80">
                    {previewText}
                  </pre>
                </div>
              )}
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

        {/* Brand Voice */}
        {voices.length > 0 && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <PenTool className="h-3.5 w-3.5" />
              Brand Voice
            </label>
            <select
              value={brandVoiceId ?? ""}
              onChange={(e) => setBrandVoiceId(e.target.value || null)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
            >
              <option value="">Default (active voice)</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.active ? " \u2713" : ""}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground/60">
              Apply a brand voice style when this prompt runs. Leave default to use the active voice.
            </p>
          </div>
        )}

        {/* Suggested Skill */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Suggested Skill
          </label>
          <select
            value={suggestedSkill ?? ""}
            onChange={(e) => setSuggestedSkill(e.target.value || null)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
          >
            <option value="">None</option>
            {skillsList.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground/60">
            When this prompt is used, the AI activates the selected skill for domain-specific expertise. Skills abstract away tool knowledge — you describe what you want, and the skill handles tool selection.
          </p>
        </div>

        {/* Scheduler Cross-References */}
        {existing && linkedJobs.length > 0 && (
          <div className="rounded-xl border border-amber-300/30 bg-amber-50/50 dark:bg-amber-900/10 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Calendar className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                Used by {linkedJobs.length} Scheduled Job{linkedJobs.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="space-y-1">
              {linkedJobs.map((job) => (
                <div key={job.id} className="flex items-center gap-2 text-[11px]">
                  <span className="font-medium text-foreground">{job.name}</span>
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-muted-foreground">{job.cronExpression}</code>
                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                    job.enabled
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {job.enabled ? "Active" : "Paused"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-500">
              Changes to this prompt will affect all linked jobs on next execution.
            </p>
          </div>
        )}

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
