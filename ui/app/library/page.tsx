"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { PersonalityConfig, SavedPrompt } from "@/lib/types";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";

export default function LibraryPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [editingPrompt, setEditingPrompt] = useState<SavedPrompt | null>(null);
  const [showForm, setShowForm] = useState(false);

  const promptsQuery = useQuery({
    queryKey: ["prompts", search],
    queryFn: () => {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      return fetchJson<{ prompts: SavedPrompt[] }>(`/api/admin/prompts${params}`);
    },
  });

  const prompts = promptsQuery.data?.prompts ?? [];

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
          <PromptForm existing={editingPrompt} onClose={handleFormClose} />
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

const PromptForm = ({ existing, onClose }: { existing: SavedPrompt | null; onClose: () => void }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [template, setTemplate] = useState(existing?.template ?? "");
  const [tagsInput, setTagsInput] = useState(existing?.tags.join(", ") ?? "");

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
    });
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
          <textarea
            className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-foreground"
            rows={8}
            placeholder={"Write your prompt template here.\nUse {{variable}} for dynamic placeholders."}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
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
