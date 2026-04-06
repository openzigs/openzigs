"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { InlineModelPicker } from "@/components/model-picker-select";
import {
  Plus,
  Pencil,
  Trash2,
  Search,
  Eye,
  X,
  FileText,
  Copy,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────

interface PostTemplate {
  id: string;
  name: string;
  description?: string;
  platform: string;
  layout: string;
  content_template: string;
  brand_kit_id?: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface BrandKit {
  id: string;
  name: string;
  primaryColor?: string;
  secondaryColor?: string;
}

const PLATFORMS = [
  "twitter",
  "instagram",
  "linkedin",
  "facebook",
  "pinterest",
  "youtube",
  "reddit",
] as const;

function extractVars(template: string): string[] {
  const matches = template.match(/\{\{(\w+)\}\}/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
}

// ── Page ──────────────────────────────────────────────────────

export default function TemplatesPage() {
  const queryClient = useQueryClient();

  // Filters
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");

  // Editor state
  const [editing, setEditing] = useState<PostTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPlatform, setFormPlatform] = useState("instagram");
  const [formContent, setFormContent] = useState("");
  const [formBrandKit, setFormBrandKit] = useState<string | null>(null);
  const [formTags, setFormTags] = useState("");

  // AI generate state
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiVarsInput, setAiVarsInput] = useState("");
  const [aiModel, setAiModel] = useState("");

  // Preview state
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewVars, setPreviewVars] = useState<Record<string, string>>({});
  const [previewResult, setPreviewResult] = useState<string | null>(null);

  // Confirm delete
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // ── Queries ────────────────────────────────────────────────

  const templatesQuery = useQuery({
    queryKey: ["post-templates", platformFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (platformFilter) params.set("platform", platformFilter);
      return fetchJson<{ templates: PostTemplate[] }>(
        `/api/admin/templates?${params}`,
      );
    },
  });

  const brandKitsQuery = useQuery({
    queryKey: ["brand-kits"],
    queryFn: () =>
      fetchJson<{ brandKits: BrandKit[] }>("/api/admin/director/brand-kits"),
  });

  const templates = (templatesQuery.data?.templates ?? []).filter(
    (t) =>
      !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.content_template.toLowerCase().includes(search.toLowerCase()),
  );

  const brandKits = brandKitsQuery.data?.brandKits ?? [];

  // ── Mutations ──────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson("/api/admin/templates", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      showToast("Template created", "success");
      queryClient.invalidateQueries({ queryKey: ["post-templates"] });
      resetForm();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Record<string, unknown>;
    }) =>
      fetchJson(`/api/admin/templates/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      showToast("Template updated", "success");
      queryClient.invalidateQueries({ queryKey: ["post-templates"] });
      resetForm();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      showToast("Template deleted", "success");
      queryClient.invalidateQueries({ queryKey: ["post-templates"] });
      setPendingDeleteId(null);
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const applyMutation = useMutation({
    mutationFn: ({
      id,
      variables,
    }: {
      id: string;
      variables: Record<string, string>;
    }) =>
      fetchJson<{ content: string }>(`/api/admin/templates/${id}/apply`, {
        method: "POST",
        body: JSON.stringify({ variables }),
      }),
    onSuccess: (data) => {
      setPreviewResult(data.content);
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const generateTemplateMutation = useMutation({
    mutationFn: (body: {
      prompt: string;
      platform: string;
      variables: string[];
      model?: string;
    }) =>
      fetchJson<{ template: string }>("/api/admin/creative/generate-template", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setFormContent(data.template);
      setAiPanelOpen(false);
      showToast("Template generated — review and save", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  // ── Helpers ────────────────────────────────────────────────

  function resetForm() {
    setCreating(false);
    setEditing(null);
    setFormName("");
    setFormDescription("");
    setFormPlatform("instagram");
    setFormContent("");
    setFormBrandKit(null);
    setFormTags("");
    setAiPanelOpen(false);
    setAiPrompt("");
    setAiVarsInput("");
    setAiModel("");
  }

  function openEditor(t?: PostTemplate) {
    if (t) {
      setEditing(t);
      setCreating(false);
      setFormName(t.name);
      setFormDescription(t.description ?? "");
      setFormPlatform(t.platform);
      setFormContent(t.content_template);
      setFormBrandKit(t.brand_kit_id ?? null);
      setFormTags(t.tags.join(", "));
    } else {
      setEditing(null);
      setCreating(true);
      setFormName("");
      setFormDescription("");
      setFormPlatform("instagram");
      setFormContent("");
      setFormBrandKit(null);
      setFormTags("");
    }
  }

  function handleSave() {
    if (!formName.trim()) {
      showToast("Name is required", "error");
      return;
    }
    const body = {
      name: formName.trim(),
      description: formDescription.trim() || undefined,
      platform: formPlatform,
      content_template: formContent,
      brand_kit_id: formBrandKit,
      tags: formTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
    if (editing) {
      updateMutation.mutate({ id: editing.id, body });
    } else {
      createMutation.mutate(body);
    }
  }

  const isEditorOpen = creating || editing !== null;
  const formVars = extractVars(formContent);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <ToastContainer />

      <SectionCard
        title={<span>Post Templates <span className="text-sm font-normal text-muted-foreground">— reusable social media post templates</span></span>}
      >
        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">All platforms</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
          <button
            onClick={() => openEditor()}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New Template
          </button>
        </div>

        {/* Template list */}
        {templatesQuery.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Loading...
          </p>
        ) : templates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No templates yet. Click &ldquo;New Template&rdquo; to create one.
          </p>
        ) : (
          <div className="space-y-2">
            {templates.map((t) => (
              <div
                key={t.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3"
              >
                <FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize text-muted-foreground">
                      {t.platform}
                    </span>
                    {t.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  {t.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t.description}
                    </p>
                  )}
                  <p className="mt-1 truncate text-xs text-muted-foreground/60">
                    {t.content_template}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    onClick={() => {
                      const vars = extractVars(t.content_template);
                      setPreviewId(t.id);
                      setPreviewVars(
                        Object.fromEntries(vars.map((v) => [v, ""])),
                      );
                      setPreviewResult(null);
                    }}
                    title="Preview"
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => openEditor(t)}
                    title="Edit"
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setPendingDeleteId(t.id)}
                    title="Delete"
                    className="rounded p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ── Editor Modal ──────────────────────────────────── */}
      {isEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            className="mx-4 w-full max-w-xl rounded-xl border border-border bg-card p-5 shadow-2xl"
            style={{ maxHeight: "90vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {editing ? "Edit Template" : "New Template"}
              </h3>
              <button
                onClick={resetForm}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Name
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm"
                  placeholder="Weekly promo post"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Description{" "}
                  <span className="text-muted-foreground/60">(optional)</span>
                </label>
                <input
                  type="text"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm"
                  placeholder="Standard promotional post for Instagram"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Platform
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p}
                      onClick={() => setFormPlatform(p)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition ${
                        formPlatform === p
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">
                    Content Template
                  </label>
                  <button
                    type="button"
                    onClick={() => setAiPanelOpen((v) => !v)}
                    className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
                  >
                    <Sparkles className="h-3 w-3" />
                    AI Generate
                    {aiPanelOpen ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                  </button>
                </div>

                {/* AI Generate Panel */}
                {aiPanelOpen && (
                  <div className="mb-3 space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <p className="text-xs font-medium text-primary">
                      Describe what you want — AI will write the template
                    </p>
                    <textarea
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      rows={3}
                      placeholder={`e.g. "A weekly promo post highlighting a sale item with a discount code and brand hashtag"`}
                      className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm"
                    />
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">
                        Variables to include{" "}
                        <span className="text-muted-foreground/60">
                          (comma-separated, optional — leave blank to let AI decide)
                        </span>
                      </label>
                      <input
                        type="text"
                        value={aiVarsInput}
                        onChange={(e) => setAiVarsInput(e.target.value)}
                        placeholder="product_name, discount_code, brand"
                        className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground">
                        Model:
                      </label>
                      <InlineModelPicker
                        value={aiModel}
                        onChange={setAiModel}
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (!aiPrompt.trim()) {
                            showToast("Enter a description first", "error");
                            return;
                          }
                          const vars = aiVarsInput
                            .split(",")
                            .map((v) => v.trim())
                            .filter(Boolean);
                          generateTemplateMutation.mutate({
                            prompt: aiPrompt.trim(),
                            platform: formPlatform,
                            variables: vars,
                            model: aiModel || undefined,
                          });
                        }}
                        disabled={generateTemplateMutation.isPending}
                        className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {generateTemplateMutation.isPending ? (
                          <span className="flex items-center justify-center gap-1.5">
                            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            Generating…
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5" />
                            Generate
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAiPanelOpen(false)}
                        className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                    {formContent && (
                      <p className="text-xs text-amber-500">
                        Generating will replace the current content template.
                      </p>
                    )}
                  </div>
                )}

                <textarea
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                  rows={5}
                  placeholder={"Check out our {{product_name}}!\n\n{{description}}\n\n#{{brand}} #sale"}
                  className="w-full rounded border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
                />
                {formVars.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Variables:{" "}
                    {formVars.map((v) => (
                      <code
                        key={v}
                        className="mx-0.5 rounded bg-primary/10 px-1 py-0.5 text-primary"
                      >
                        {`{{${v}}}`}
                      </code>
                    ))}
                  </p>
                )}
              </div>
              {brandKits.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Brand Kit{" "}
                    <span className="text-muted-foreground/60">(optional)</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setFormBrandKit(null)}
                      className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                        !formBrandKit
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      None
                    </button>
                    {brandKits.map((bk) => (
                      <button
                        key={bk.id}
                        onClick={() => setFormBrandKit(bk.id)}
                        className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition ${
                          formBrandKit === bk.id
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {bk.primaryColor && (
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: bk.primaryColor }}
                          />
                        )}
                        {bk.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Tags{" "}
                  <span className="text-muted-foreground/60">
                    (comma-separated)
                  </span>
                </label>
                <input
                  type="text"
                  value={formTags}
                  onChange={(e) => setFormTags(e.target.value)}
                  className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm"
                  placeholder="promo, weekly, sale"
                />
              </div>
              <button
                onClick={handleSave}
                disabled={
                  createMutation.isPending || updateMutation.isPending
                }
                className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createMutation.isPending || updateMutation.isPending
                  ? "Saving..."
                  : editing
                    ? "Update Template"
                    : "Create Template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Preview Modal ─────────────────────────────────── */}
      {previewId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Preview Template</h3>
              <button
                onClick={() => {
                  setPreviewId(null);
                  setPreviewResult(null);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {Object.keys(previewVars).length > 0 ? (
              <div className="space-y-3">
                {Object.entries(previewVars).map(([key, val]) => (
                  <div key={key}>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      {`{{${key}}}`}
                    </label>
                    <input
                      type="text"
                      value={val}
                      onChange={(e) =>
                        setPreviewVars((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm"
                      placeholder={key}
                    />
                  </div>
                ))}
                <button
                  onClick={() =>
                    applyMutation.mutate({
                      id: previewId,
                      variables: previewVars,
                    })
                  }
                  disabled={applyMutation.isPending}
                  className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {applyMutation.isPending
                    ? "Applying..."
                    : "Preview Result"}
                </button>
              </div>
            ) : (
              <button
                onClick={() =>
                  applyMutation.mutate({
                    id: previewId,
                    variables: {},
                  })
                }
                disabled={applyMutation.isPending}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {applyMutation.isPending
                  ? "Applying..."
                  : "Preview (no variables)"}
              </button>
            )}

            {previewResult && (
              <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Output
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(previewResult);
                      showToast("Copied", "success");
                    }}
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-sm">{previewResult}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Delete Confirmation ───────────────────────────── */}
      {pendingDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl">
            <h3 className="mb-2 text-sm font-semibold">Delete Template</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              Are you sure? This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingDeleteId(null)}
                className="flex-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(pendingDeleteId)}
                disabled={deleteMutation.isPending}
                className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
