"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { Memory, MemoryCategory, MemoryConfig, MemoryRepoStatus } from "@/lib/types";
import { showToast } from "@/components/toast";
import {
  Brain,
  Plus,
  Trash2,
  Edit3,
  Save,
  X,
  RefreshCw,
  GitBranch,
  CheckCircle2,
  XCircle,
  Folder,
} from "lucide-react";

const CATEGORIES: { value: MemoryCategory; label: string; desc: string }[] = [
  { value: "conventions", label: "Conventions", desc: "Coding standards & project rules" },
  { value: "patterns", label: "Patterns", desc: "Recurring architectural patterns" },
  { value: "decisions", label: "Decisions", desc: "Key technical decisions & rationale" },
  { value: "preferences", label: "Preferences", desc: "User preferences & defaults" },
  { value: "context", label: "Context", desc: "Project context & domain knowledge" },
];

type ConfigStatusResponse = {
  config: MemoryConfig;
  status: MemoryRepoStatus;
};

export function MemoryPanel() {
  const queryClient = useQueryClient();

  // ── State ──────────────────────────────────────────────────────────
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newCategory, setNewCategory] = useState<MemoryCategory>("conventions");
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [filterCategory, setFilterCategory] = useState<MemoryCategory | "all">("all");

  // ── Queries ────────────────────────────────────────────────────────
  const configQuery = useQuery({
    queryKey: ["memory-config"],
    queryFn: () => fetchJson<ConfigStatusResponse>("/api/admin/memory/config"),
  });

  const memoriesQuery = useQuery({
    queryKey: ["memory-list"],
    queryFn: () => fetchJson<{ memories: Memory[] }>("/api/admin/memory/memories"),
    enabled: configQuery.data?.config.enabled === true && configQuery.data?.status.connected === true,
  });

  const config = configQuery.data?.config;
  const status = configQuery.data?.status;
  const memories = memoriesQuery.data?.memories ?? [];
  const filtered = filterCategory === "all" ? memories : memories.filter((m) => m.category === filterCategory);

  // ── Mutations ──────────────────────────────────────────────────────
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      fetchJson("/api/admin/memory/config", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      showToast("Memory configuration updated", "success");
      void queryClient.invalidateQueries({ queryKey: ["memory-config"] });
      void queryClient.invalidateQueries({ queryKey: ["memory-list"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const setupMutation = useMutation({
    mutationFn: () =>
      fetchJson("/api/admin/memory/setup", { method: "POST" }),
    onSuccess: () => {
      showToast("Memory repository created successfully", "success");
      void queryClient.invalidateQueries({ queryKey: ["memory-config"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const createMutation = useMutation({
    mutationFn: (data: { category: MemoryCategory; title: string; content: string }) =>
      fetchJson("/api/admin/memory/memories", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      showToast("Memory created", "success");
      setShowCreateForm(false);
      setNewTitle("");
      setNewContent("");
      void queryClient.invalidateQueries({ queryKey: ["memory-list"] });
      void queryClient.invalidateQueries({ queryKey: ["memory-config"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, title, content }: { id: string; title?: string; content?: string }) =>
      fetchJson(`/api/admin/memory/memories/${id}`, {
        method: "PUT",
        body: JSON.stringify({ title, content }),
      }),
    onSuccess: () => {
      showToast("Memory updated", "success");
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ["memory-list"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/memory/memories/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      showToast("Memory deleted", "success");
      void queryClient.invalidateQueries({ queryKey: ["memory-list"] });
      void queryClient.invalidateQueries({ queryKey: ["memory-config"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  // ── Handlers ───────────────────────────────────────────────────────
  const handleCreate = () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    createMutation.mutate({ category: newCategory, title: newTitle.trim(), content: newContent.trim() });
  };

  const startEdit = (memory: Memory) => {
    setEditingId(memory.id);
    setEditTitle(memory.title);
    setEditContent(memory.content);
  };

  const handleUpdate = () => {
    if (!editingId) return;
    updateMutation.mutate({ id: editingId, title: editTitle, content: editContent });
  };

  // ── Loading state ──────────────────────────────────────────────────
  if (configQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading memory configuration…</p>;
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Status banner */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">
              Agent Memory
              {config?.enabled ? (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-600">
                  <CheckCircle2 className="h-3 w-3" /> Enabled
                </span>
              ) : (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-xs text-muted-foreground">
                  Disabled
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {status?.connected
                ? `Connected to ${status.owner}/${status.repo} · ${status.memoryCount} memories`
                : "GitHub repository-backed persistent memory for the agent"}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["memory-config"] });
              void queryClient.invalidateQueries({ queryKey: ["memory-list"] });
            }}
            className="rounded-lg border border-border p-2 text-muted-foreground transition hover:bg-accent"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={() => toggleMutation.mutate(!config?.enabled)}
            disabled={toggleMutation.isPending}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              config?.enabled
                ? "border border-border text-foreground hover:bg-accent"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
          >
            {config?.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </div>

      {/* Setup section — show when enabled but not connected */}
      {config?.enabled && !status?.connected && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-amber-600" />
            <p className="text-sm font-medium text-foreground">Repository Setup Required</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Create a private GitHub repository to store agent memories. Requires a{" "}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">GITHUB_PERSONAL_ACCESS_TOKEN</code>{" "}
            with <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">repo</code> scope.
          </p>
          {status?.error && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <XCircle className="h-3.5 w-3.5" />
              {status.error}
            </div>
          )}
          <button
            onClick={() => setupMutation.mutate()}
            disabled={setupMutation.isPending}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          >
            {setupMutation.isPending ? "Creating…" : "Create Memory Repository"}
          </button>
        </div>
      )}

      {/* Memory list — show when enabled and connected */}
      {config?.enabled && status?.connected && (
        <>
          {/* Category filter + create button */}
          <div className="flex items-center justify-between">
            <div className="flex gap-1.5">
              <button
                onClick={() => setFilterCategory("all")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  filterCategory === "all"
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:bg-accent"
                }`}
              >
                All
              </button>
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setFilterCategory(c.value)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    filterCategory === c.value
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              New Memory
            </button>
          </div>

          {/* Create form */}
          {showCreateForm && (
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label} — {c.desc}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-[2]">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. ESM import conventions"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Content</label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Memory content in markdown…"
                  rows={4}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowCreateForm(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={createMutation.isPending || !newTitle.trim() || !newContent.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                >
                  <Save className="h-3.5 w-3.5" />
                  {createMutation.isPending ? "Creating…" : "Create"}
                </button>
              </div>
            </div>
          )}

          {/* Memory items */}
          {memoriesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading memories…</p>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Folder className="mx-auto h-8 w-8 text-muted-foreground/50" />
              <p className="mt-2 text-sm text-muted-foreground">
                {memories.length === 0
                  ? "No memories yet. Create your first memory to get started."
                  : "No memories in this category."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((memory) => (
                <div
                  key={memory.id}
                  className="rounded-lg border border-border bg-card p-4 transition hover:border-primary/20"
                >
                  {editingId === memory.id ? (
                    /* Inline edit form */
                    <div className="space-y-3">
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground"
                      />
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={4}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={handleUpdate}
                          disabled={updateMutation.isPending}
                          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                        >
                          <Save className="h-3.5 w-3.5" />
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Read view */
                    <div>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                              {memory.category}
                            </span>
                            <h3 className="text-sm font-medium text-foreground">{memory.title}</h3>
                          </div>
                          <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground line-clamp-3">
                            {memory.content}
                          </p>
                          <p className="mt-2 text-[10px] text-muted-foreground/60">
                            Updated {new Date(memory.updatedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="ml-3 flex gap-1">
                          <button
                            onClick={() => startEdit(memory)}
                            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                            title="Edit"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => deleteMutation.mutate(memory.id)}
                            disabled={deleteMutation.isPending}
                            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-red-500/10 hover:text-red-500"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
