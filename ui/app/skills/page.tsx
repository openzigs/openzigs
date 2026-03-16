"use client";

import { Suspense, useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AskAiPanel, AskAiButton } from "@/components/ask-ai/AskAiPanel";
import { PAGE_CONTEXTS } from "@/components/ask-ai/page-contexts";
import type { ToolInfo } from "@/lib/types";
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
  ExternalLink,
  Sparkles,
  Search,
  ChevronDown,
  ChevronUp,
  Minus,
  ShieldCheck,
} from "lucide-react";
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
/*  Tool Budget Limits                                                */
/*  The GitHub Copilot SDK has NO documented tool count limit.        */
/*  The values below are openzigs-internal and configurable via the   */
/*  admin panel (PUT /api/admin/tools/config).                        */
/* ------------------------------------------------------------------ */

/** ESSENTIAL_TOOLS always merged into every request at runtime (read-file, list-directory, etc.) */
const TOOL_ESSENTIAL_COUNT = 6;
/**
 * openzigs default for maxToolsPerRequest — configurable via admin panel.
 * NOT a GitHub Copilot SDK or CLI limit; those have no documented tool count cap.
 */
const TOOL_DEFAULT_CAP = 30;
/**
 * Absolute maximum accepted by setMaxToolsPerRequest() in copilot-wrapper.ts.
 * Also openzigs-internal; the GitHub Copilot SDK itself imposes no tool count cap.
 */
const TOOL_HARD_CAP = 128;
/** At or above the openzigs default cap — tools may be silently dropped unless cap is raised */
const TOOL_WARNING_THRESHOLD = TOOL_DEFAULT_CAP; // 30
/** OpenAI performance guideline: "aim for fewer than 20 functions at the start of a turn" */
const TOOL_ADVISORY_THRESHOLD = 20;

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
/*  Skills Page (unified gallery + editor)                            */
/* ------------------------------------------------------------------ */

export default function SkillsPage() {
  return (
    <Suspense>
      <SkillsPageContent />
    </Suspense>
  );
}

function SkillsPageContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { socket } = useSocket();

  const [view, setView] = useState<"gallery" | "detail" | "create">("gallery");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [skillName, setSkillName] = useState("");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"guided" | "advanced">("guided");
  const [skillDescription, setSkillDescription] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  // Tool budget level — derived from selectedTools count
  const toolBudgetLevel =
    selectedTools.length > TOOL_HARD_CAP ? "over" :
    selectedTools.length >= TOOL_WARNING_THRESHOLD ? "warning" :
    selectedTools.length >= TOOL_ADVISORY_THRESHOLD ? "advisory" : "ok";

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

  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => fetchJson<{ tools: Record<string, ToolInfo[]> }>("/api/admin/tools"),
    enabled: view === "create" && createMode === "guided",
  });

  // Grouped categories for the collapsible tool picker
  const toolCategories = toolsQuery.data
    ? Object.entries(toolsQuery.data.tools)
        .map(([category, tools]) => ({ category, tools: tools.filter((t) => t.enabled) }))
        .filter(({ tools }) => tools.length > 0)
    : [];

  const getMatchingTools = (tools: ToolInfo[]): ToolInfo[] => {
    if (!toolSearch) return tools;
    const q = toolSearch.toLowerCase();
    return tools.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  };

  const hasNoMatches =
    toolSearch.length > 0 && toolCategories.every(({ tools }) => getMatchingTools(tools).length === 0);

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

  const generateMutation = useMutation({
    mutationFn: (params: { description: string; tools: string[] }) =>
      fetchJson<{ content: string; generatedName: string }>("/api/admin/skills/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }),
    onSuccess: (data) => {
      setEditorContent(data.content);
      if (data.generatedName) setSkillName(data.generatedName);
      setGenerating(false);
      showToast("Skill generated — review and edit below before saving", "success");
    },
    onError: (err: Error) => {
      setGenerating(false);
      showToast(`Generation failed: ${err.message}`, "error");
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
    setSkillDescription("");
    setSelectedTools([]);
    setCreateMode("guided");
    setGenerating(false);
    setToolSearch("");
    setExpandedCategories({});
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

  const handleGenerate = useCallback(() => {
    if (!skillDescription.trim()) {
      showToast("Please describe what the skill should do", "error");
      return;
    }
    setGenerating(true);
    generateMutation.mutate({ description: skillDescription, tools: selectedTools });
  }, [skillDescription, selectedTools, generateMutation]);

  const handleSaveEdit = useCallback(() => {
    if (!selectedSkill) return;
    updateMutation.mutate({ name: selectedSkill, content: editorContent });
  }, [selectedSkill, editorContent, updateMutation]);

  const handleTryIt = (prompt: string) => {
    router.push(`/chat?prompt=${encodeURIComponent(prompt)}`);
  };

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
                  ? createMode === "guided"
                    ? "Describe what you need and let AI generate it"
                    : "Define a new skill with SKILL.md frontmatter"
                  : "View and edit skill definition"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AskAiButton onClick={() => setAskAiOpen(true)} />
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
        <>
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

                {/* Try It prompts */}
                {skill.examples.length > 0 && (
                  <div className="mt-3">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors"
                      onClick={() => handleTryIt(skill.examples[0])}
                    >
                      <ExternalLink className="h-3 w-3" />
                      Try It
                    </button>
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

          <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
            <h3 className="text-sm font-semibold text-white">How Skills Work</h3>
            <p className="mt-2 text-sm text-zinc-400">
              Skills are <code>SKILL.md</code> markdown files loaded via the Copilot SDK&apos;s{" "}
              <code>skillDirectories</code> configuration. They are injected into every session&apos;s
              context, giving the AI domain-specific rules, tool routing instructions, and behavioral
              constraints. Type <code>!</code> in the chat to browse skills, or just describe what you need.
            </p>
          </div>
        </>
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
          {/* Mode Toggle */}
          <div className="flex items-center gap-2 rounded-lg bg-zinc-900/50 border border-zinc-800 p-1 w-fit">
            <button
              onClick={() => setCreateMode("guided")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                createMode === "guided"
                  ? "bg-blue-600 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Guided
            </button>
            <button
              onClick={() => setCreateMode("advanced")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                createMode === "advanced"
                  ? "bg-blue-600 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              <Code className="h-3.5 w-3.5" />
              Advanced
            </button>
          </div>

          {/* Guided Mode */}
          {createMode === "guided" && (
            <SectionCard title="Describe Your Skill">
              <p className="mb-4 text-sm text-zinc-400">
                Tell us what your skill should do and we&apos;ll generate the SKILL.md for you.
                You can review and edit the result before saving.
              </p>

              <div className="mb-4">
                <label htmlFor="skill-description" className="mb-1.5 block text-xs font-medium text-zinc-500">
                  What should this skill do?
                </label>
                <textarea
                  id="skill-description"
                  value={skillDescription}
                  onChange={(e) => setSkillDescription(e.target.value)}
                  placeholder="Example: A social media manager that can search for trending topics, draft posts for Twitter and LinkedIn, schedule them, and analyze engagement metrics..."
                  className="w-full rounded-lg bg-zinc-900 border border-zinc-700 p-4 text-sm text-zinc-200 leading-relaxed resize-y min-h-[120px] focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  rows={4}
                />
              </div>

              {/* Tool Picker */}
              <div className="mb-4">
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-500">
                    Select Tools <span className="text-zinc-600">(optional — AI will suggest tools if none selected)</span>
                  </label>
                  {selectedTools.length > 0 && (
                    <span className={`text-xs font-mono tabular-nums ${
                      toolBudgetLevel === "over" ? "text-red-400" :
                      toolBudgetLevel === "warning" ? "text-orange-400" :
                      toolBudgetLevel === "advisory" ? "text-yellow-400" :
                      "text-zinc-500"
                    }`}>
                      {selectedTools.length} / {TOOL_DEFAULT_CAP}
                    </span>
                  )}
                </div>

                {/* Auto-approve info */}
                <div className="mb-3 flex items-center gap-1.5 text-xs text-emerald-500/80">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                  <span>Tools included in a skill&apos;s allowed list are auto-approved — no approval interrupts when the skill is active</span>
                </div>

                {/* Tool budget warning */}
                {toolBudgetLevel !== "ok" && (
                  <div className={`mb-3 flex items-start gap-1.5 rounded-lg border px-3 py-2 text-xs ${
                    toolBudgetLevel === "over"
                      ? "border-red-800/40 bg-red-900/20 text-red-400"
                      : toolBudgetLevel === "warning"
                        ? "border-orange-800/40 bg-orange-900/20 text-orange-400"
                        : "border-yellow-800/40 bg-yellow-900/20 text-yellow-400"
                  }`}>
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      {toolBudgetLevel === "over"
                        ? `${selectedTools.length} tools exceeds the maximum configurable cap of ${TOOL_HARD_CAP}. Reduce the tool list to continue.`
                        : toolBudgetLevel === "warning"
                          ? `${selectedTools.length} tools meets or exceeds the default cap of ${TOOL_DEFAULT_CAP}. At runtime, tools may be silently dropped unless the cap is raised in the admin panel. Total including the ${TOOL_ESSENTIAL_COUNT} always-on essentials: ${selectedTools.length + TOOL_ESSENTIAL_COUNT}.`
                          : `${selectedTools.length} tools is getting large. OpenAI recommends fewer than ${TOOL_ADVISORY_THRESHOLD} tools per turn for best performance, especially on smaller models.`
                      }
                    </span>
                  </div>
                )}

                {selectedTools.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {selectedTools.map((t) => (
                      <button
                        key={t}
                        onClick={() => setSelectedTools((prev) => prev.filter((x) => x !== t))}
                        className="flex items-center gap-1 rounded-full bg-blue-900/40 px-2.5 py-1 text-xs text-blue-300 hover:bg-blue-800/50 transition-colors"
                      >
                        {t}
                        <X className="h-3 w-3" />
                      </button>
                    ))}
                    <button
                      onClick={() => setSelectedTools([])}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                )}

                <div className="relative mb-2">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                  <input
                    type="text"
                    value={toolSearch}
                    onChange={(e) => setToolSearch(e.target.value)}
                    placeholder="Search tools..."
                    className="w-full rounded-lg bg-zinc-900 border border-zinc-700 pl-9 pr-4 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  />
                </div>

                <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/50">
                  {toolsQuery.isLoading && (
                    <div className="p-3 text-sm text-zinc-500">Loading tools…</div>
                  )}
                  {hasNoMatches && (
                    <div className="p-3 text-sm text-zinc-500">No matching tools</div>
                  )}
                  {toolCategories.map(({ category, tools }) => {
                    const matching = getMatchingTools(tools);
                    if (matching.length === 0) return null;

                    const selectedCount = matching.filter((t) => selectedTools.includes(t.name)).length;
                    const allChecked = selectedCount === matching.length;
                    const someChecked = selectedCount > 0 && !allChecked;
                    const isExpanded = toolSearch ? true : (expandedCategories[category] ?? false);

                    const toggleAllInCategory = (e: React.MouseEvent) => {
                      e.stopPropagation();
                      const names = matching.map((t) => t.name);
                      setSelectedTools((prev) =>
                        allChecked ? prev.filter((n) => !names.includes(n)) : [...new Set([...prev, ...names])],
                      );
                    };

                    return (
                      <div key={category} className="border-b border-zinc-800/60 last:border-b-0">
                        {/* Category header */}
                        <div
                          className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800/50 select-none transition-colors"
                          onClick={() =>
                            !toolSearch &&
                            setExpandedCategories((prev) => ({ ...prev, [category]: !prev[category] }))
                          }
                        >
                          {/* Select-all / partial indicator */}
                          <div
                            role="checkbox"
                            aria-checked={allChecked ? "true" : someChecked ? "mixed" : "false"}
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                              allChecked
                                ? "border-blue-500 bg-blue-500"
                                : someChecked
                                  ? "border-blue-400 bg-blue-900/50"
                                  : "border-zinc-600 bg-zinc-800"
                            }`}
                            onClick={toggleAllInCategory}
                          >
                            {allChecked && <Check className="h-2.5 w-2.5 text-white" />}
                            {someChecked && <Minus className="h-2.5 w-2.5 text-blue-300" />}
                          </div>

                          <span className="flex-1 text-sm font-medium text-zinc-300 capitalize">{category}</span>

                          {selectedCount > 0 && (
                            <span className="rounded-full bg-blue-900/40 px-1.5 py-0.5 text-xs text-blue-300">
                              {selectedCount}/{matching.length}
                            </span>
                          )}
                          {selectedCount === 0 && (
                            <span className="text-xs text-zinc-600">{matching.length}</span>
                          )}

                          {!toolSearch && (
                            isExpanded
                              ? <ChevronUp className="h-3.5 w-3.5 text-zinc-500" />
                              : <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
                          )}
                        </div>

                        {/* Individual tools (expanded) */}
                        {isExpanded &&
                          matching.map((tool) => {
                            const checked = selectedTools.includes(tool.name);
                            return (
                              <label
                                key={tool.name}
                                className={`flex items-start gap-3 pl-10 pr-3 py-2 text-sm cursor-pointer hover:bg-zinc-800/50 transition-colors ${
                                  checked ? "bg-blue-900/20" : ""
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() =>
                                    setSelectedTools((prev) =>
                                      checked
                                        ? prev.filter((x) => x !== tool.name)
                                        : [...prev, tool.name],
                                    )
                                  }
                                  className="mt-0.5 rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500/50"
                                />
                                <div className="min-w-0">
                                  <span className="font-mono text-zinc-200">{tool.name}</span>
                                  <p className="text-xs text-zinc-500 truncate">{tool.description}</p>
                                </div>
                              </label>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleGenerate}
                  disabled={generating || !skillDescription.trim() || toolBudgetLevel === "over"}
                  className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-5 py-2.5 text-sm font-medium text-white hover:from-blue-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  <Sparkles className="h-4 w-4" />
                  {generating ? "Generating…" : "Generate Skill"}
                </button>
                <button
                  onClick={() => { setView("gallery"); setValidation(null); }}
                  className="flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </SectionCard>
          )}

          {/* Editor — shown always in advanced mode, or after generation in guided mode */}
          {(createMode === "advanced" || editorContent !== DEFAULT_SKILL_TEMPLATE) && (
            <SectionCard title={createMode === "guided" ? "Review & Edit Generated Skill" : "New Skill"}>
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
          )}
        </div>
      )}

      <AskAiPanel pageContext={PAGE_CONTEXTS["skills"]} open={askAiOpen} onClose={() => setAskAiOpen(false)} />
    </main>
  );
}
