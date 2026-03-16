"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { ModelInfo, ReasoningEffort, SavedPrompt, ScheduledJob, ToolInfo } from "@/lib/types";

type SkillMetadata = {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  tools: string[];
};
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { PipelineEditor, type BackendPipelineNode } from "@/components/pipeline/pipeline-editor";
import { WorkflowWizard } from "@/components/pipeline/workflow-wizard";
import { ToolMultiSelect, type ToolOption } from "@/components/pipeline/tool-multi-select";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";
import { CronBuilder } from "@/components/cron-builder";
import { DryRunPreview, type DryRunData } from "@/components/dry-run-preview";
import { ChevronDown, ChevronUp, History } from "lucide-react";

const FALLBACK_MODEL_IDS = [
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4.1-mini",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "o3-mini",
];

const REASONING_EFFORT_LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

const supportsReasoningModel = (modelId: string, modelCapabilities?: { supports?: { reasoningEffort?: boolean } }) => {
  if (modelCapabilities?.supports?.reasoningEffort !== undefined) {
    return modelCapabilities.supports.reasoningEffort;
  }
  const lower = modelId.toLowerCase();
  return lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4");
};

export default function SchedulerPage() {
  return (
    <Suspense>
      <SchedulerContent />
    </Suspense>
  );
}

function SchedulerContent() {
  const queryClient = useQueryClient();
  const { socket } = useSocket();
  const searchParams = useSearchParams();
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const [createFromPrompt, setCreateFromPrompt] = useState<string | null>(null);

  // Auto-open form when createFrom query param is present
  useEffect(() => {
    const fromParam = searchParams.get("createFrom");
    if (fromParam) {
      setCreateFromPrompt(fromParam);
      setEditingJob(null);
      setShowForm(true);
    }
  }, [searchParams]);

  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: () => fetchJson<{ jobs: ScheduledJob[] }>("/api/admin/jobs"),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      fetchJson(`/api/admin/jobs/${id}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      showToast("Job toggled", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/admin/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      showToast("Job deleted", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const runNowMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/jobs/${id}/run`, { method: "POST" }),
    onSuccess: (_data, _id) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      showToast("Job triggered", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const [dryRunResult, setDryRunResult] = useState<{ id: string; data: DryRunData } | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);

  const dryRunMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ preview: DryRunData }>(`/api/admin/jobs/${id}/run?dry_run=true`, { method: "POST" }),
    onSuccess: (data, id) => {
      setDryRunResult({ id, data: data.preview ?? data });
      showToast("Dry run complete — preview below", "success");
    },
    onError: (err) => showToast(`Dry run error: ${err.message}`, "error"),
  });

  useEffect(() => {
    if (!socket) return;
    const onExecuted = (data: { jobName?: string; success?: boolean }) => {
      const name = data.jobName ?? "Job";
      showToast(`${name} ${data.success ? "executed" : "failed"}`, data.success ? "success" : "error");
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    };
    socket.on("job:executed", onExecuted);
    return () => { socket.off("job:executed", onExecuted); };
  }, [socket, queryClient]);

  const jobs = jobsQuery.data?.jobs ?? [];

  const handleDelete = (job: ScheduledJob) => {
    if (!confirm(`Delete job "${job.name}"? This cannot be undone.`)) return;
    deleteMutation.mutate(job.id);
  };

  const handleEdit = (job: ScheduledJob) => {
    setEditingJob(job);
    setShowForm(true);
  };

  const handleNew = () => {
    setEditingJob(null);
    setShowForm(true);
  };

  const handleFormClose = () => {
    setShowForm(false);
    setEditingJob(null);
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 lg:px-12">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">Scheduler</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Schedule recurring prompts, shell commands, and custom actions.
          </p>
        </div>
        <AskAiButton onClick={() => setAskAiOpen(true)} />
      </header>

      <div className="mb-6 flex justify-end">
        <button
          onClick={handleNew}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          + New Job
        </button>
      </div>

      {showForm && (
        <div className="mb-6">
          <JobForm existing={editingJob} onClose={handleFormClose} createFromPrompt={createFromPrompt} />
        </div>
      )}

      <SectionCard title="Scheduled Jobs">
        {jobsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scheduled jobs yet. Click &quot;+ New Job&quot; to create one.
          </p>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{job.name}</p>
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
                      {job.actionType || "prompt"}
                    </span>
                    {!job.enabled && (
                      <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                        Disabled
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <ToggleSwitch
                      checked={job.enabled}
                      onChange={(v) => toggleMutation.mutate({ id: job.id, enabled: v })}
                    />
                    <button
                      onClick={() => runNowMutation.mutate(job.id)}
                      disabled={runNowMutation.isPending}
                      title="Run this job now"
                      className="rounded-lg border border-moss/30 px-3 py-1.5 text-xs font-semibold text-moss hover:bg-moss/5 disabled:opacity-40"
                    >
                      ▶ Run
                    </button>
                    <button
                      onClick={() => dryRunMutation.mutate(job.id)}
                      disabled={dryRunMutation.isPending}
                      title="Preview what this job would do without executing"
                      className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-500 hover:bg-amber-500/5 disabled:opacity-40"
                    >
                      🧪 Dry Run
                    </button>
                    <button
                      onClick={() => handleEdit(job)}
                      className="rounded-lg border border-primary px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(job)}
                      className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{job.cronExpression}</code>
                  <span className="text-xs text-muted-foreground">{job.timezone || "UTC"}</span>
                  {job.model && (
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      Model: {job.model}
                    </span>
                  )}
                  {typeof job.actionPayload?.skillName === "string" && (
                    <a href={`/admin/skills?view=${encodeURIComponent(job.actionPayload.skillName)}`} className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400">
                      ★ {job.actionPayload.skillName}
                    </a>
                  )}
                </div>
                {job.actionPayload && Object.keys(job.actionPayload).length > 0 && (
                  <div className="mt-2 font-mono text-xs text-muted-foreground">
                    {job.actionType === "prompt" && job.actionPayload.promptName ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span>Prompt:</span>
                        <a href={`/library?search=${encodeURIComponent(String(job.actionPayload.promptName))}`} className="text-primary hover:underline">
                          {String(job.actionPayload.promptName)}
                        </a>
                        {(() => {
                          const vars = job.actionPayload?.variables;
                          if (!vars || typeof vars !== "object") return null;
                          const entries = Object.entries(vars as Record<string, string>);
                          if (entries.length === 0) return null;
                          return (
                            <span className="text-muted-foreground">
                              ({entries.map(([k, v]) => `${k}=${v}`).join(", ")})
                            </span>
                          );
                        })()}
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap break-words">{JSON.stringify(job.actionPayload, null, 2).slice(0, 200)}</pre>
                    )}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span>Runs: {job.runCount || 0}</span>
                  {job.lastRunAt && <span>Last: {new Date(job.lastRunAt).toLocaleString()}</span>}
                </div>
                {/* Execution History toggle */}
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setExpandedHistory(expandedHistory === job.id ? null : job.id)}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <History className="h-3 w-3" />
                    History
                    {expandedHistory === job.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                  {expandedHistory === job.id && (
                    <ExecutionHistory jobId={job.id} />
                  )}
                </div>
                {dryRunResult?.id === job.id && (
                  <div className="mt-3">
                    <DryRunPreview
                      data={dryRunResult.data}
                      onExecute={() => { setDryRunResult(null); runNowMutation.mutate(job.id); }}
                      onClose={() => setDryRunResult(null)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <ToastContainer />
      <AskAiPanel pageContext={PAGE_CONTEXTS["scheduler"]} open={askAiOpen} onClose={() => setAskAiOpen(false)} />
    </main>
  );
}

/* ── Job Form (create / edit) ── */

const JobForm = ({ existing, onClose, createFromPrompt }: { existing: ScheduledJob | null; onClose: () => void; createFromPrompt?: string | null }) => {
  const queryClient = useQueryClient();
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantOutput, setAssistantOutput] = useState<string | null>(null);
  const [name, setName] = useState(existing?.name ?? "");
  const [actionType, setActionType] = useState(existing?.actionType ?? "prompt");
  const [promptName, setPromptName] = useState(
    createFromPrompt
      ? createFromPrompt
      : existing?.actionType === "prompt" && existing?.actionPayload?.promptName
        ? String(existing.actionPayload.promptName)
        : ""
  );
  const [payloadText, setPayloadText] = useState(
    existing && existing.actionType !== "prompt" && existing.actionType !== "pipeline" && existing.actionPayload
      ? JSON.stringify(existing.actionPayload, null, 2)
      : ""
  );
  const [pipelineStages, setPipelineStages] = useState<BackendPipelineNode[]>(
    existing?.actionType === "pipeline" && existing?.actionPayload?.stages
      ? (existing.actionPayload.stages as BackendPipelineNode[])
      : []
  );
  const [cronExpression, setCronExpression] = useState(existing?.cronExpression ?? "");
  const [timezone, setTimezone] = useState(existing?.timezone ?? "UTC");
  const [model, setModel] = useState(existing?.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(existing?.reasoningEffort ?? "medium");
  const [autoApproveTools, setAutoApproveTools] = useState<string[]>(
    existing?.autoApproveTools ?? []
  );
  const [templateVars, setTemplateVars] = useState<Record<string, string>>(
    (existing?.actionType === "prompt" && existing?.actionPayload?.variables
      ? (existing.actionPayload.variables as Record<string, string>)
      : {})
  );
  const [skillName, setSkillName] = useState(
    existing?.actionPayload?.skillName ? String(existing.actionPayload.skillName) : ""
  );
  const [skillAutoPopulated, setSkillAutoPopulated] = useState(false);

  // Outbox action type state
  const [outboxPlatforms, setOutboxPlatforms] = useState<string[]>(
    existing?.actionType === "outbox" && existing?.actionPayload?.platforms
      ? (existing.actionPayload.platforms as string[])
      : existing?.actionType === "outbox" && existing?.actionPayload?.platform
        ? [String(existing.actionPayload.platform)]
        : []
  );
  const [contentTemplate, setContentTemplate] = useState(
    existing?.actionType === "outbox" && existing?.actionPayload?.contentTemplate
      ? String(existing.actionPayload.contentTemplate)
      : ""
  );
  const [reviewRequired, setReviewRequired] = useState(
    existing?.actionType === "outbox" && existing?.actionPayload?.reviewRequired === true
  );

  // Notification channels state (applicable to all action types)
  const [notifyChannels, setNotifyChannels] = useState<string[]>(
    existing?.notifyChannels ?? []
  );

  // Fetch connected outbox platforms
  const platformsQuery = useQuery({
    queryKey: ["outbox-connected-platforms"],
    queryFn: () => fetchJson<{ platforms: { platform: string; connected: boolean }[] }>("/api/admin/outbox/connected-platforms"),
    enabled: actionType === "outbox",
  });
  const connectedPlatforms = useMemo(
    () => (platformsQuery.data?.platforms ?? []).filter((p) => p.connected).map((p) => p.platform),
    [platformsQuery.data]
  );

  // Fetch channel config for notification checkboxes
  const channelsQuery = useQuery({
    queryKey: ["channels"],
    queryFn: () => fetchJson<{ channels: { telegram: { enabled: boolean }; discord: { enabled: boolean } } }>("/api/admin/channels"),
  });
  const enabledChannels = useMemo(() => {
    const ch = channelsQuery.data?.channels;
    if (!ch) return [];
    const result: string[] = [];
    if (ch.telegram?.enabled) result.push("telegram");
    if (ch.discord?.enabled) result.push("discord");
    return result;
  }, [channelsQuery.data]);

  // Fetch prompts for the dropdown
  const promptsQuery = useQuery({
    queryKey: ["prompts"],
    queryFn: () => fetchJson<{ prompts: SavedPrompt[] }>("/api/admin/prompts"),
  });
  const prompts = promptsQuery.data?.prompts ?? [];

  // Fetch skills for the skill selector
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () => fetchJson<{ skills: SkillMetadata[] }>("/api/admin/skills"),
  });
  const skills = skillsQuery.data?.skills ?? [];
  const selectedSkill = useMemo(
    () => skills.find((s) => s.name === skillName) ?? null,
    [skills, skillName]
  );

  // Extract {{variable}} names from the selected prompt template
  const BUILTIN_VARS = ["today", "now", "day_of_week", "month", "year"];
  const detectedVars = useMemo(() => {
    if (actionType !== "prompt" || !promptName) return [];
    const selected = prompts.find((p) => p.name === promptName);
    if (!selected?.template) return [];
    const names = new Set<string>();
    for (const match of selected.template.matchAll(/\{\{(\w+)\}\}/g)) {
      names.add(match[1]);
    }
    return Array.from(names);
  }, [actionType, promptName, prompts]);

  // When prompt changes, preserve existing variable values and add empty entries for new ones
  useEffect(() => {
    if (detectedVars.length === 0) return;
    setTemplateVars((prev) => {
      const next = { ...prev };
      for (const v of detectedVars) {
        if (!(v in next)) next[v] = "";
      }
      return next;
    });
  }, [detectedVars]);

  // Auto-populate skill from linked prompt's suggestedSkill
  useEffect(() => {
    if (actionType !== "prompt" || !promptName) return;
    const selected = prompts.find((p) => p.name === promptName);
    if (selected?.suggestedSkill && !skillName) {
      setSkillName(selected.suggestedSkill);
      setSkillAutoPopulated(true);
    } else {
      setSkillAutoPopulated(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptName, prompts, actionType]);

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<{ models: ModelInfo[]; selectedModel?: string | null }>("/api/models"),
  });
  const modelOptions = useMemo(() => {
    const ids = new Set<string>();
    const models = modelsQuery.data?.models ?? [];
    for (const model of models) {
      if (typeof model?.id === "string" && model.id.trim()) {
        ids.add(model.id.trim());
      }
    }
    for (const fallback of FALLBACK_MODEL_IDS) {
      ids.add(fallback);
    }
    const selectedModel = modelsQuery.data?.selectedModel;
    if (typeof selectedModel === "string" && selectedModel.trim()) {
      ids.add(selectedModel.trim());
    }
    if (typeof existing?.model === "string" && existing.model.trim()) {
      ids.add(existing.model.trim());
    }
    if (typeof model === "string" && model.trim()) {
      ids.add(model.trim());
    }
    return Array.from(ids).sort((a, b) => a.localeCompare(b));
  }, [existing?.model, model, modelsQuery.data]);

  const selectedModelMeta = useMemo(() => {
    const selected = model.trim();
    if (!selected) return null;
    const models = modelsQuery.data?.models ?? [];
    return models.find((m) => m.id === selected) ?? null;
  }, [model, modelsQuery.data?.models]);

  const modelSupportsReasoning = useMemo(() => {
    const selected = model.trim();
    if (!selected) return false;
    return supportsReasoningModel(selected, selectedModelMeta?.capabilities);
  }, [model, selectedModelMeta?.capabilities]);

  const availableReasoningEfforts = useMemo(() => {
    const supported = selectedModelMeta?.supportedReasoningEfforts;
    if (supported && supported.length > 0) {
      return supported;
    }
    return REASONING_EFFORT_LEVELS;
  }, [selectedModelMeta?.supportedReasoningEfforts]);

  useEffect(() => {
    if (!modelSupportsReasoning) return;
    if (!availableReasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort(availableReasoningEfforts[0] ?? "medium");
    }
  }, [availableReasoningEfforts, modelSupportsReasoning, reasoningEffort]);

  useEffect(() => {
    if (existing) return;
    if (model.trim()) return;
    const selectedModel = modelsQuery.data?.selectedModel;
    if (typeof selectedModel === "string" && selectedModel.trim()) {
      setModel(selectedModel.trim());
    }
  }, [existing, model, modelsQuery.data?.selectedModel]);

  // Fetch tools for multi-select (stage tools + auto-approve tools)
  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => fetchJson<{ tools: Record<string, ToolInfo[]> }>("/api/admin/tools"),
  });
  const allTools: ToolOption[] = useMemo(() => {
    if (!toolsQuery.data?.tools) return [];
    return Object.entries(toolsQuery.data.tools).flatMap(([category, categoryTools]) =>
      categoryTools.map((t) => ({
        name: t.name,
        description: t.description,
        category,
        enabled: t.enabled,
      }))
    );
  }, [toolsQuery.data]);

  // Convert prompts for PipelineEditor
  const availablePrompts = useMemo(
    () => prompts.map((p) => ({ id: p.id, name: p.name, description: p.description, template: p.template })),
    [prompts]
  );

  // For pipeline jobs, auto-derive auto-approve from the union of all stage tools.
  // If a stage uses specific tools, those must be auto-approved (no human to approve during scheduled runs).
  const derivedAutoApproveTools = useMemo(() => {
    if (actionType !== "pipeline") return null;
    const toolSet = new Set<string>();
    for (const stage of pipelineStages) {
      const tools = stage.tools;
      if (tools && Array.isArray(tools)) {
        for (const t of tools) toolSet.add(t);
      }
    }
    return toolSet.size > 0 ? Array.from(toolSet).sort() : null;
  }, [actionType, pipelineStages]);

  const assistMutation = useMutation({
    mutationFn: (message: string) =>
      fetchJson<{ suggestion: SchedulerSuggestion }>("/api/admin/scheduler/assist", {
        method: "POST",
        body: JSON.stringify({
          message,
          promptNames: prompts.map((p) => p.name),
          ...(model ? { model } : {}),
        }),
      }),
    onSuccess: ({ suggestion }) => {
      applySuggestion(suggestion);
      setAssistantOutput(JSON.stringify(suggestion, null, 2));
      showToast("Fields updated from AI suggestion", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => {
      const url = existing ? `/api/admin/jobs/${existing.id}` : "/api/admin/jobs";
      const method = existing ? "PUT" : "POST";
      return fetchJson(url, { method, body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      showToast(existing ? "Job updated" : "Job created", "success");
      onClose();
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleSave = () => {
    if (!name.trim()) { showToast("Name is required.", "error"); return; }
    if (!cronExpression.trim()) { showToast("Cron expression is required.", "error"); return; }

    let actionPayload: Record<string, unknown>;
    if (actionType === "prompt") {
      if (!promptName) { showToast("Select a prompt for this job.", "error"); return; }
      // Include only non-empty variable values
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(templateVars)) {
        if (v.trim()) vars[k] = v.trim();
      }
      actionPayload = {
        promptName,
        ...(skillName ? { skillName } : {}),
        ...(Object.keys(vars).length > 0 ? { variables: vars } : {}),
      };
    } else if (actionType === "pipeline") {
      if (pipelineStages.length < 2) { showToast("Pipeline needs at least 2 stages.", "error"); return; }
      actionPayload = { stages: pipelineStages };
    } else if (actionType === "outbox") {
      if (outboxPlatforms.length === 0) { showToast("Select at least one platform.", "error"); return; }
      if (!contentTemplate.trim()) { showToast("Content template is required.", "error"); return; }
      actionPayload = {
        platforms: outboxPlatforms,
        contentTemplate: contentTemplate.trim(),
        reviewRequired,
      };
    } else {
      try {
        actionPayload = JSON.parse(payloadText.trim() || "{}");
      } catch {
        showToast("Invalid JSON in payload field.", "error");
        return;
      }
    }

    const payload: Record<string, unknown> = {
      name: name.trim(),
      cronExpression: cronExpression.trim(),
      timezone: timezone.trim() || "UTC",
      actionType,
      actionPayload,
    };

    const modelValue = model.trim();
    if (existing) {
      payload.model = modelValue || null;
    } else if (modelValue) {
      payload.model = modelValue;
    }

    if (modelValue && modelSupportsReasoning) {
      payload.reasoningEffort = reasoningEffort;
    } else if (existing) {
      payload.reasoningEffort = null;
    }

    // Auto-approve tools: for pipelines, derived from stage tools; for others, manual selection
    if (actionType === "pipeline") {
      if (derivedAutoApproveTools && derivedAutoApproveTools.length > 0) {
        payload.autoApproveTools = derivedAutoApproveTools;
      } else if (existing) {
        payload.autoApproveTools = null;
      }
    } else if (autoApproveTools.length > 0) {
      payload.autoApproveTools = autoApproveTools;
    } else if (existing) {
      payload.autoApproveTools = null;
    }

    // Notification channels
    if (notifyChannels.length > 0) {
      payload.notifyChannels = notifyChannels;
    } else if (existing) {
      payload.notifyChannels = null;
    }

    saveMutation.mutate(payload);
  };

  const applySuggestion = (suggestion: SchedulerSuggestion) => {
    if (suggestion.name) setName(suggestion.name);
    if (suggestion.cronExpression) setCronExpression(suggestion.cronExpression);
    if (suggestion.timezone) setTimezone(suggestion.timezone);
    if (suggestion.actionType) setActionType(suggestion.actionType);

    if (suggestion.actionType === "prompt") {
      if (suggestion.promptName) {
        setPromptName(suggestion.promptName);
      } else if (prompts.length > 0) {
        showToast("AI suggested a prompt job but no matching prompt was found.", "error");
        setPromptName("");
      }
      setPayloadText("");
    } else if (suggestion.actionType === "outbox") {
      if (suggestion.actionPayload) {
        const p = suggestion.actionPayload;
        if (Array.isArray(p.platforms)) setOutboxPlatforms(p.platforms as string[]);
        else if (typeof p.platform === "string") setOutboxPlatforms([p.platform]);
        if (typeof p.contentTemplate === "string") setContentTemplate(p.contentTemplate);
        if (typeof p.reviewRequired === "boolean") setReviewRequired(p.reviewRequired);
      }
      setPayloadText("");
      setPromptName("");
    } else if (suggestion.actionPayload) {
      setPromptName("");
      setPayloadText(JSON.stringify(suggestion.actionPayload, null, 2));
    }

    if (typeof suggestion.model === "string") {
      setModel(suggestion.model);
    }

    if (suggestion.notifyChannels) {
      setNotifyChannels(suggestion.notifyChannels);
    }
  };

  const handleAssist = () => {
    const message = assistantInput.trim();
    if (!message) {
      showToast("Describe the schedule you want first.", "error");
      return;
    }
    assistMutation.mutate(message);
  };

  return (
    <div className="rounded-2xl border border-primary/20 bg-card p-5">
      <h3 className="mb-4 text-lg font-semibold text-foreground">
        {existing ? "Edit Job" : "New Job"}
      </h3>

      <div className="space-y-3">
        <Field label="AI Scheduler Assistant" hint="Describe the schedule and let GPT-5-mini fill the fields.">
          <textarea
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            rows={3}
            placeholder="e.g., Every weekday at 9am, run the daily-summary prompt in America/New_York"
            value={assistantInput}
            onChange={(e) => setAssistantInput(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Model: gpt-5-mini</span>
            <button
              onClick={handleAssist}
              disabled={assistMutation.isPending}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
            >
              {assistMutation.isPending ? "Generating…" : "Generate Fields"}
            </button>
          </div>
          {assistantOutput && (
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
              {assistantOutput}
            </pre>
          )}
        </Field>

        <Field label="Name">
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            placeholder="e.g., daily-report"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>

        <Field
          label="Action Type"
          hint={`"Prompt" executes a saved prompt template. "Pipeline" runs a multi-stage workflow. "Shell" runs a command. "Outbox" queues content for social publishing.`}
        >
          <select
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
          >
            <option value="prompt">Prompt</option>
            <option value="pipeline">Pipeline</option>
            <option value="shell">Shell</option>
            <option value="custom">Custom</option>
            <option value="outbox">Outbox (Publish)</option>
          </select>
        </Field>

        {actionType === "prompt" ? (
          <>
          <Field label="Linked Prompt" hint="The saved prompt to execute on each run.">
            <select
              className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
              value={promptName}
              onChange={(e) => setPromptName(e.target.value)}
            >
              <option value="">— Select a saved prompt —</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}{p.description ? ` — ${p.description}` : ""}
                </option>
              ))}
            </select>
            {prompts.length === 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                No prompts saved yet.{" "}
                <a href="/library" className="text-primary hover:underline">Create one first</a>.
              </p>
            )}
          </Field>
          {detectedVars.length > 0 && (
            <Field
              label="Template Variables"
              hint={`Set values for {{variables}} in this prompt. Built-in dynamic variables (${BUILTIN_VARS.join(", ")}) auto-resolve at run time if left empty.`}
            >
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                {detectedVars.map((varName) => (
                  <div key={varName} className="flex items-center gap-2">
                    <code className="min-w-[120px] shrink-0 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary">
                      {`{{${varName}}}`}
                    </code>
                    <input
                      type="text"
                      className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-1.5 text-sm"
                      placeholder={BUILTIN_VARS.includes(varName) ? `(auto: resolved at run time)` : `Value for ${varName}`}
                      value={templateVars[varName] ?? ""}
                      onChange={(e) =>
                        setTemplateVars((prev) => ({ ...prev, [varName]: e.target.value }))
                      }
                    />
                    {BUILTIN_VARS.includes(varName) && (
                      <span className="shrink-0 text-[10px] text-emerald-500">dynamic</span>
                    )}
                  </div>
                ))}
              </div>
            </Field>
          )}
          <Field label="Skill" hint="Skills inject domain expertise and restrict tools to the skill's allowed set.">
            <select
              className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
              value={skillName}
              onChange={(e) => { setSkillName(e.target.value); setSkillAutoPopulated(false); }}
            >
              <option value="">— No skill (generic execution) —</option>
              {skills.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.icon} {s.displayName}
                </option>
              ))}
            </select>
            {skillAutoPopulated && (
              <p className="mt-1 text-[10px] text-emerald-500">Auto-suggested by linked prompt</p>
            )}
            {selectedSkill && selectedSkill.tools.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="text-[10px] text-muted-foreground mr-1">Skill tools:</span>
                {selectedSkill.tools.slice(0, 10).map((t) => (
                  <span key={t} className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                    {t}
                  </span>
                ))}
                {selectedSkill.tools.length > 10 && (
                  <span className="text-[10px] text-muted-foreground">+{selectedSkill.tools.length - 10} more</span>
                )}
              </div>
            )}
          </Field>
          </>
        ) : actionType === "pipeline" ? (
          <PipelineSection
            pipelineStages={pipelineStages}
            setPipelineStages={setPipelineStages}
            availableTools={allTools}
            availablePrompts={availablePrompts}
          />
        ) : actionType === "outbox" ? (
          <>
            <Field label="Platforms" hint="Select one or more social platforms to publish to.">
              {connectedPlatforms.length === 0 && !platformsQuery.isLoading ? (
                <p className="text-[11px] text-muted-foreground">
                  No connected platforms found.{" "}
                  <a href="/admin" className="text-primary hover:underline">Configure credentials first</a>.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {connectedPlatforms.map((p) => (
                    <label key={p} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={outboxPlatforms.includes(p)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setOutboxPlatforms((prev) => [...prev, p]);
                          } else {
                            setOutboxPlatforms((prev) => prev.filter((x) => x !== p));
                          }
                        }}
                        className="rounded border-border"
                      />
                      <span className="text-sm capitalize text-foreground">{p}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Content Template" hint="Template for the post content. Use {{today}}, {{now}}, {{day_of_week}}, {{month}}, {{year}} for dynamic values.">
              <textarea
                className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
                rows={4}
                placeholder="e.g., 🚀 Weekly update for {{day_of_week}}, {{today}} — here's what's new..."
                value={contentTemplate}
                onChange={(e) => setContentTemplate(e.target.value)}
              />
            </Field>
            <Field label="Review Required" hint="When enabled, items are queued for human review before publishing.">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewRequired}
                  onChange={(e) => setReviewRequired(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-sm text-foreground">Require manual review before publishing</span>
              </label>
            </Field>
          </>
        ) : (
          <Field
            label="Action Payload (JSON)"
            hint={actionType === "shell" ? '{"command": "echo hello"}' : "Any valid JSON object."}
          >
            <textarea
              className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 font-mono text-sm"
              rows={4}
              placeholder='{"command": "echo hello"}'
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
            />
          </Field>
        )}

        {enabledChannels.length > 0 && (
          <Field label="Notifications" hint="Send a notification when this job completes or fails.">
            <div className="flex flex-wrap gap-3">
              {enabledChannels.map((ch) => (
                <label key={ch} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifyChannels.includes(ch)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setNotifyChannels((prev) => [...prev, ch]);
                      } else {
                        setNotifyChannels((prev) => prev.filter((x) => x !== ch));
                      }
                    }}
                    className="rounded border-border"
                  />
                  <span className="text-sm capitalize text-foreground">{ch}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <Field label="Model" hint="Optional — defaults to the system model.">
          <select
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            value={model ?? ""}
            onChange={(e) => setModel(e.target.value)}
            disabled={modelsQuery.isLoading && modelOptions.length === 0}
          >
            <option value="">Default (System)</option>
            {modelOptions.map((modelId) => (
              <option key={modelId} value={modelId}>{modelId}</option>
            ))}
          </select>
        </Field>

        {model.trim() && modelSupportsReasoning && (
          <Field label="Reasoning Effort" hint="Used only for reasoning-capable models.">
            <select
              className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
            >
              {availableReasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Schedule"
          hint="When should this job run? Use Simple mode for common patterns or Advanced for raw cron."
        >
          <CronBuilder
            value={cronExpression}
            onChange={setCronExpression}
            timezone={timezone}
          />
        </Field>

        <Field label="Timezone" hint="IANA timezone identifier.">
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            placeholder="America/New_York"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </Field>

        <Field
          label="Auto-Approve Tools"
          hint={actionType === "pipeline"
            ? "Automatically derived from your pipeline stages. Any tool a stage uses is auto-approved during scheduled runs."
            : "Tools that skip approval gating for this job. Leave empty for normal approval flow."}
        >
          {actionType === "pipeline" ? (
            <div className="mt-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
              {derivedAutoApproveTools && derivedAutoApproveTools.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                    {derivedAutoApproveTools.length} tool{derivedAutoApproveTools.length !== 1 ? "s" : ""} auto-approved from stage configuration
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {derivedAutoApproveTools.slice(0, 8).map((t) => (
                      <span key={t} className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                        {t}
                      </span>
                    ))}
                    {derivedAutoApproveTools.length > 8 && (
                      <span className="text-[10px] text-muted-foreground">+{derivedAutoApproveTools.length - 8} more</span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No stage-specific tools configured — all tools available, normal approval flow applies.
                  Set tools on individual stages to auto-approve them.
                </p>
              )}
            </div>
          ) : (
            <ToolMultiSelect
              tools={allTools}
              selected={autoApproveTools.length > 0 ? autoApproveTools : null}
              onChange={(selected) => setAutoApproveTools(selected ?? [])}
              placeholder="None (normal approval flow)"
              allowAll={false}
            />
          )}
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
            {saveMutation.isPending ? "Saving…" : existing ? "Update Job" : "Create Job"}
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

/* ── Pipeline Section: wizard vs. manual toggle ── */

const PipelineSection = ({
  pipelineStages,
  setPipelineStages,
  availableTools,
  availablePrompts,
}: {
  pipelineStages: BackendPipelineNode[];
  setPipelineStages: (stages: BackendPipelineNode[]) => void;
  availableTools: ToolOption[];
  availablePrompts: { id: string; name: string; description?: string; template?: string }[];
}) => {
  const [mode, setMode] = useState<"choose" | "wizard" | "manual">(
    pipelineStages.length > 0 ? "manual" : "choose"
  );

  if (mode === "choose") {
    return (
      <div className="space-y-3">
        <label className="text-xs font-medium text-muted-foreground">Pipeline Stages</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setMode("wizard")}
            className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 p-4 hover:border-primary hover:bg-primary/10 transition"
          >
            <span className="text-2xl">🧙</span>
            <span className="text-sm font-semibold text-foreground">Workflow Wizard</span>
            <span className="text-[11px] text-muted-foreground text-center">
              Describe your goal and let AI auto-plan the pipeline stages for you.
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/30 p-4 hover:border-primary hover:bg-muted/50 transition"
          >
            <span className="text-2xl">🔧</span>
            <span className="text-sm font-semibold text-foreground">Manual Editor</span>
            <span className="text-[11px] text-muted-foreground text-center">
              Build the pipeline yourself using the visual drag-and-drop editor.
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (mode === "wizard") {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">Workflow Wizard</label>
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            ← Back to options
          </button>
        </div>
        <WorkflowWizard
          onComplete={(pipeline) => {
            setPipelineStages(pipeline.stages as BackendPipelineNode[]);
            setMode("manual");
            showToast("Pipeline created via wizard — review and save below.", "success");
          }}
          onCancel={() => setMode("choose")}
          availableTools={availableTools}
          availablePrompts={availablePrompts}
        />
      </div>
    );
  }

  // Manual editor mode
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Pipeline Stages</label>
        {pipelineStages.length === 0 && (
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            ← Back to options
          </button>
        )}
      </div>
      <PipelineEditor
        initialStages={pipelineStages}
        onChange={(stages) => setPipelineStages(stages)}
        height="350px"
        availableTools={availableTools}
        availablePrompts={availablePrompts}
      />
      {pipelineStages.length > 0 && (
        <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
          {pipelineStages.length} stage{pipelineStages.length !== 1 ? "s" : ""} configured
        </p>
      )}
      <p className="text-[11px] text-muted-foreground/60">
        Design a multi-stage pipeline using the visual editor. Click Save in the editor when done.
      </p>
    </div>
  );
};

const ToggleSwitch = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-moss" : "bg-muted"}`}
    onClick={() => onChange(!checked)}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`}
    />
  </button>
);

type SchedulerSuggestion = {
  name: string;
  actionType: "prompt" | "shell" | "custom" | "outbox";
  cronExpression: string;
  timezone: string;
  promptName?: string;
  actionPayload?: Record<string, unknown>;
  model?: string;
  notifyChannels?: string[];
};

/* ── Execution History ── */

type TaskSummary = {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  goal: string;
};

const ExecutionHistory = ({ jobId }: { jobId: string }) => {
  const historyQuery = useQuery({
    queryKey: ["job-history", jobId],
    queryFn: () => fetchJson<{ executions: TaskSummary[] }>(`/api/admin/jobs/${jobId}/history?limit=5`),
  });
  const executions = historyQuery.data?.executions ?? [];

  if (historyQuery.isLoading) return <p className="mt-1 text-[11px] text-muted-foreground">Loading…</p>;
  if (executions.length === 0) return <p className="mt-1 text-[11px] text-muted-foreground">No executions yet.</p>;

  return (
    <div className="mt-1.5 space-y-1">
      {executions.map((ex) => {
        const duration = ex.completedAt
          ? Math.round((new Date(ex.completedAt).getTime() - new Date(ex.createdAt).getTime()) / 1000)
          : null;
        return (
          <div key={ex.id} className="flex items-center gap-2 text-[11px]">
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
              ex.status === "completed" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400" :
              ex.status === "failed" ? "bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400" :
              "bg-muted text-muted-foreground"
            }`}>
              {ex.status}
            </span>
            <span className="text-muted-foreground">
              {new Date(ex.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            {duration !== null && (
              <span className="text-muted-foreground">{duration}s</span>
            )}
            <a
              href={`/tasks?id=${ex.id}`}
              className="text-primary hover:underline"
            >
              View →
            </a>
          </div>
        );
      })}
    </div>
  );
};
