"use client";

import { Suspense, useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Plus,
  ArrowLeft,
  Edit,
  Trash2,
  Save,
  Eye,
  Code,
  Wrench,
  AlertTriangle,
  Check,
  BookOpen,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSocket } from "@/lib/socket-context";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface SkillMetadata {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  tools: string[];
  rulesCount: number;
  loaded: boolean;
  examples: string[];
  skillMdPath: string;
  allowedTools: string[];
  content?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  parsedName?: string;
}

/* ------------------------------------------------------------------ */
/*  Default SKILL.md Template                                         */
/* ------------------------------------------------------------------ */

const DEFAULT_SKILL_TEMPLATE = `---
name: my-skill
description: A custom skill for OpenZigs
allowed-tools: web-search read-file
---

# My Custom Skill

## Description
Describe what this skill does and when it should be used.

## Rules
- Rule 1: Be specific about the skill's purpose
- Rule 2: Define clear boundaries for the skill's scope

## Examples
- "Example prompt that would trigger this skill"
`;

/* ------------------------------------------------------------------ */
/*  Skill Editor Page                                                 */
/* ------------------------------------------------------------------ */

export default function SkillEditorPage() {
  return (
    <Suspense>
      <SkillEditorContent />
    </Suspense>
  );
}

function SkillEditorContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const { socket } = useSocket();

  const [view, setView] = useState<"gallery" | "detail" | "create">("gallery");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [skillName, setSkillName] = useState("");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Listen for real-time skill updates
  useEffect(() => {
    if (!socket) return;
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    };
    socket.on("skills:updated", handler);
    return () => { socket.off("skills:updated", handler); };
  }, [socket, queryClient]);

  // Handle ?view= search param for deep linking
  useEffect(() => {
    const viewParam = searchParams.get("view");
    if (viewParam) {
      setSelectedSkill(viewParam);
      setView("detail");
    }
  }, [searchParams]);

  /* ---- Queries ---- */

  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () => fetchJson<{ skills: SkillMetadata[] }>("/api/admin/skills"),
  });

  const skills = skillsQuery.data?.skills ?? [];

  const detailQuery = useQuery({
    queryKey: ["skill-detail", selectedSkill],
    queryFn: () => fetchJson<SkillMetadata>(`/api/admin/skills/${encodeURIComponent(selectedSkill!)}`),
    enabled: !!selectedSkill && view === "detail",
  });

  // Sync editor content when detail loads
  useEffect(() => {
    if (detailQuery.data?.content) {
      setEditorContent(detailQuery.data.content);
    }
  }, [detailQuery.data?.content]);

  /* ---- Mutations ---- */

  const validateMutation = useMutation({
    mutationFn: (content: string) =>
      fetchJson<ValidationResult>("/api/admin/skills/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    onSuccess: (data) => {
      setValidation(data);
      setValidating(false);
    },
    onError: () => {
      setValidation({ valid: false, errors: ["Validation request failed"] });
      setValidating(false);
    },
  });

  const createMutation = useMutation({
    mutationFn: (params: { name: string; content: string }) =>
      fetchJson<{ success: boolean; skill: SkillMetadata | null }>("/api/admin/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }),
    onSuccess: () => {
      showToast("Skill created successfully", "success");
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      setView("gallery");
      setSkillName("");
      setEditorContent("");
      setValidation(null);
    },
    onError: (err: Error) => {
      showToast(`Failed to create skill: ${err.message}`, "error");
    },
  });

  const updateMutation = useMutation({
    mutationFn: (params: { name: string; content: string }) =>
      fetchJson<{ success: boolean; skill: SkillMetadata | null }>(`/api/admin/skills/${encodeURIComponent(params.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: params.content }),
      }),
    onSuccess: () => {
      showToast("Skill updated successfully", "success");
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["skill-detail", selectedSkill] });
    },
    onError: (err: Error) => {
      showToast(`Failed to update skill: ${err.message}`, "error");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      fetchJson<{ success: boolean }>(`/api/admin/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      showToast("Skill deleted", "success");
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      setView("gallery");
      setSelectedSkill(null);
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      showToast(`Failed to delete skill: ${err.message}`, "error");
      setDeleteTarget(null);
    },
  });

  /* ---- Handlers ---- */

  const handleValidate = useCallback(() => {
    setValidating(true);
    validateMutation.mutate(editorContent);
  }, [editorContent, validateMutation]);

  const isBuiltIn = useCallback(
    (skill: SkillMetadata) => skill.skillMdPath.includes("src/skills"),
    [],
  );

  const handleOpenCreate = useCallback(() => {
    setEditorContent(DEFAULT_SKILL_TEMPLATE);
    setSkillName("");
    setValidation(null);
    setView("create");
  }, []);

  const handleSaveNew = useCallback(() => {
    if (!skillName.trim()) {
      showToast("Skill name is required", "error");
      return;
    }
    if (/[/\\.]/.test(skillName)) {
      showToast("Skill name cannot contain path characters", "error");
      return;
    }
    createMutation.mutate({ name: skillName.trim(), content: editorContent });
  }, [skillName, editorContent, createMutation]);

  const handleSaveEdit = useCallback(() => {
    if (!selectedSkill) return;
    updateMutation.mutate({ name: selectedSkill, content: editorContent });
  }, [selectedSkill, editorContent, updateMutation]);

  /* ---- Render ---- */

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-12">
      <ToastContainer />

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Skill"
          message={`Are you sure you want to delete the skill "${deleteTarget}"? This action cannot be undone.`}
          onConfirm={() => deleteMutation.mutate(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
          confirmLabel="Delete"
          variant="danger"
        />
      )}

      {/* ── Header ── */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {view !== "gallery" && (
            <button
              onClick={() => { setView("gallery"); setSelectedSkill(null); setValidation(null); }}
              className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div>
            <h1 className="text-2xl font-bold text-white">
              {view === "gallery" ? "Skills" : view === "create" ? "Create Skill" : selectedSkill}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              {view === "gallery"
                ? "Manage built-in and custom SKILL.md skill files"
                : view === "create"
                  ? "Define a new skill with SKILL.md frontmatter"
                  : "View and edit skill definition"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin"
            className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            ← Admin
          </Link>
          {view === "gallery" && (
            <button
              onClick={handleOpenCreate}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Skill
            </button>
          )}
        </div>
      </div>

      {/* ── Gallery View ── */}
      {view === "gallery" && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skillsQuery.isLoading && (
            <div className="col-span-full text-center text-zinc-500 py-12">Loading skills…</div>
          )}
          {skills.map((skill) => (
            <div key={skill.name} className="group relative rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{skill.icon}</span>
                  <div>
                    <h3 className="font-semibold text-white">{skill.displayName}</h3>
                    <p className="text-xs text-zinc-500">{skill.name}</p>
                  </div>
                </div>
                {isBuiltIn(skill) ? (
                  <span className="rounded-full bg-zinc-700 px-2 py-0.5 text-xs text-zinc-400">Built-in</span>
                ) : (
                  <span className="rounded-full bg-blue-900/50 px-2 py-0.5 text-xs text-blue-400">Custom</span>
                )}
              </div>

              <p className="mt-3 text-sm text-zinc-400 line-clamp-2">{skill.description}</p>

              {skill.allowedTools.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {skill.allowedTools.slice(0, 4).map((t) => (
                    <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">
                      {t}
                    </span>
                  ))}
                  {skill.allowedTools.length > 4 && (
                    <span className="text-xs text-zinc-600">+{skill.allowedTools.length - 4} more</span>
                  )}
                </div>
              )}

              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={() => { setSelectedSkill(skill.name); setView("detail"); }}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                >
                  <Eye className="h-3.5 w-3.5" />
                  View
                </button>
                {!isBuiltIn(skill) && (
                  <>
                    <button
                      onClick={() => { setSelectedSkill(skill.name); setView("detail"); }}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                    >
                      <Edit className="h-3.5 w-3.5" />
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleteTarget(skill.name)}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}

          {!skillsQuery.isLoading && skills.length === 0 && (
            <div className="col-span-full text-center text-zinc-500 py-12">
              <BookOpen className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p>No skills found. Create your first skill to get started.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Detail / Edit View ── */}
      {view === "detail" && selectedSkill && (
        <div className="space-y-6">
          {detailQuery.isLoading && (
            <div className="text-center text-zinc-500 py-12">Loading skill…</div>
          )}
          {detailQuery.data && (
            <>
              {/* Metadata Header */}
              <SectionCard title="Skill Details">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{detailQuery.data.icon}</span>
                    <div>
                      <h2 className="text-xl font-bold text-white">{detailQuery.data.displayName}</h2>
                      <p className="text-sm text-zinc-400">{detailQuery.data.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isBuiltIn(detailQuery.data) ? (
                      <span className="rounded-full bg-zinc-700 px-3 py-1 text-xs text-zinc-400">Read-only (Built-in)</span>
                    ) : (
                      <>
                        <button
                          onClick={handleSaveEdit}
                          disabled={updateMutation.isPending}
                          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                        >
                          <Save className="h-4 w-4" />
                          {updateMutation.isPending ? "Saving…" : "Save"}
                        </button>
                        <button
                          onClick={() => setDeleteTarget(selectedSkill)}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-red-900/30 transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Metadata pills */}
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="flex items-center gap-1 rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
                    <Wrench className="h-3 w-3" />
                    {detailQuery.data.allowedTools.length} tools
                  </span>
                  <span className="flex items-center gap-1 rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
                    <Code className="h-3 w-3" />
                    {detailQuery.data.rulesCount} rules
                  </span>
                </div>

                {/* Tools list */}
                {detailQuery.data.allowedTools.length > 0 && (
                  <div className="mt-4">
                    <h4 className="mb-2 text-xs font-medium text-zinc-500 uppercase tracking-wider">Allowed Tools</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {detailQuery.data.allowedTools.map((t) => (
                        <span key={t} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 font-mono">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Examples */}
                {detailQuery.data.examples.length > 0 && (
                  <div className="mt-4">
                    <h4 className="mb-2 text-xs font-medium text-zinc-500 uppercase tracking-wider">Example Prompts</h4>
                    <ul className="space-y-1">
                      {detailQuery.data.examples.map((ex, i) => (
                        <li key={i} className="text-sm text-zinc-400 italic">&ldquo;{ex}&rdquo;</li>
                      ))}
                    </ul>
                  </div>
                )}
              </SectionCard>

              {/* Editor */}
              <SectionCard title="SKILL.md Editor">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-zinc-300">SKILL.md Content</h3>
                  <button
                    onClick={handleValidate}
                    disabled={validating}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {validating ? "Validating…" : "Validate"}
                  </button>
                </div>

                {validation && (
                  <div className={`mb-3 rounded-lg p-3 text-sm ${validation.valid ? "bg-green-900/20 text-green-400 border border-green-800/30" : "bg-red-900/20 text-red-400 border border-red-800/30"}`}>
                    {validation.valid ? (
                      <div className="flex items-center gap-2">
                        <Check className="h-4 w-4" />
                        Valid SKILL.md{validation.parsedName ? ` — name: ${validation.parsedName}` : ""}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4" />
                          Validation errors:
                        </div>
                        <ul className="ml-6 list-disc">
                          {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                <textarea
                  value={editorContent}
                  onChange={(e) => { setEditorContent(e.target.value); setValidation(null); }}
                  readOnly={isBuiltIn(detailQuery.data)}
                  className="w-full rounded-lg bg-zinc-900 border border-zinc-700 p-4 text-sm text-zinc-200 font-mono leading-relaxed resize-y min-h-[400px] focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50"
                  spellCheck={false}
                />
              </SectionCard>
            </>
          )}
        </div>
      )}

      {/* ── Create View ── */}
      {view === "create" && (
        <div className="space-y-6">
          <SectionCard title="New Skill">

            <div className="mb-4">
              <label htmlFor="skill-name" className="mb-1.5 block text-xs font-medium text-zinc-500">
                Skill Name
              </label>
              <input
                id="skill-name"
                type="text"
                value={skillName}
                onChange={(e) => setSkillName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                placeholder="my-custom-skill"
                className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-4 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              />
              <p className="mt-1 text-xs text-zinc-600">Lowercase letters, numbers, and hyphens only</p>
            </div>

            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-medium text-zinc-500">SKILL.md Content</label>
              <button
                onClick={handleValidate}
                disabled={validating}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <Check className="h-3.5 w-3.5" />
                {validating ? "Validating…" : "Validate"}
              </button>
            </div>

            {validation && (
              <div className={`mb-3 rounded-lg p-3 text-sm ${validation.valid ? "bg-green-900/20 text-green-400 border border-green-800/30" : "bg-red-900/20 text-red-400 border border-red-800/30"}`}>
                {validation.valid ? (
                  <div className="flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    Valid SKILL.md{validation.parsedName ? ` — name: ${validation.parsedName}` : ""}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4" />
                      Validation errors:
                    </div>
                    <ul className="ml-6 list-disc">
                      {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <textarea
              value={editorContent}
              onChange={(e) => { setEditorContent(e.target.value); setValidation(null); }}
              className="w-full rounded-lg bg-zinc-900 border border-zinc-700 p-4 text-sm text-zinc-200 font-mono leading-relaxed resize-y min-h-[400px] focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              spellCheck={false}
            />

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => { setView("gallery"); setValidation(null); }}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800 transition-colors"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
              <button
                onClick={handleSaveNew}
                disabled={createMutation.isPending || !skillName.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Save className="h-4 w-4" />
                {createMutation.isPending ? "Creating…" : "Create Skill"}
              </button>
            </div>
          </SectionCard>
        </div>
      )}
    </main>
  );
}
