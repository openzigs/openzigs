"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { ModelInfo, SavedPrompt, ScheduledJob, ToolInfo } from "@/lib/types";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { PipelineEditor } from "@/components/pipeline/pipeline-editor";
import { WorkflowWizard } from "@/components/pipeline/workflow-wizard";
import { ToolMultiSelect, type ToolOption } from "@/components/pipeline/tool-multi-select";

export default function SchedulerPage() {
  const queryClient = useQueryClient();
  const { socket } = useSocket();
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);
  const [showForm, setShowForm] = useState(false);

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

  const [dryRunResult, setDryRunResult] = useState<{ id: string; preview: string } | null>(null);

  const dryRunMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ preview: Record<string, unknown> }>(`/api/admin/jobs/${id}/run?dry_run=true`, { method: "POST" }),
    onSuccess: (data, id) => {
      setDryRunResult({ id, preview: JSON.stringify(data.preview ?? data, null, 2) });
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
      <header className="mb-8">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">Scheduler</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Schedule recurring prompts, shell commands, and custom actions.
        </p>
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
          <JobForm existing={editingJob} onClose={handleFormClose} />
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
                </div>
                {job.actionPayload && Object.keys(job.actionPayload).length > 0 && (
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                    {job.actionType === "prompt" && job.actionPayload.promptName
                      ? `Prompt: ${job.actionPayload.promptName}`
                      : JSON.stringify(job.actionPayload, null, 2).slice(0, 200)}
                  </pre>
                )}
                <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span>Runs: {job.runCount || 0}</span>
                  {job.lastRunAt && <span>Last: {new Date(job.lastRunAt).toLocaleString()}</span>}
                </div>
                {dryRunResult?.id === job.id && (
                  <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-50/5 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-amber-500">🧪 Dry Run Preview</span>
                      <button
                        onClick={() => setDryRunResult(null)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        ✕
                      </button>
                    </div>
                    <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                      {dryRunResult.preview}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <ToastContainer />
    </main>
  );
}

/* ── Job Form (create / edit) ── */

const JobForm = ({ existing, onClose }: { existing: ScheduledJob | null; onClose: () => void }) => {
  const queryClient = useQueryClient();
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantOutput, setAssistantOutput] = useState<string | null>(null);
  const [name, setName] = useState(existing?.name ?? "");
  const [actionType, setActionType] = useState(existing?.actionType ?? "prompt");
  const [promptName, setPromptName] = useState(
    existing?.actionType === "prompt" && existing?.actionPayload?.promptName
      ? String(existing.actionPayload.promptName)
      : ""
  );
  const [payloadText, setPayloadText] = useState(
    existing && existing.actionType !== "prompt" && existing.actionType !== "pipeline" && existing.actionPayload
      ? JSON.stringify(existing.actionPayload, null, 2)
      : ""
  );
  const [pipelineStages, setPipelineStages] = useState<Array<Record<string, unknown>>>(
    existing?.actionType === "pipeline" && existing?.actionPayload?.stages
      ? (existing.actionPayload.stages as Array<Record<string, unknown>>)
      : []
  );
  const [cronExpression, setCronExpression] = useState(existing?.cronExpression ?? "");
  const [timezone, setTimezone] = useState(existing?.timezone ?? "UTC");
  const [model, setModel] = useState(existing?.model ?? "");
  const [autoApproveTools, setAutoApproveTools] = useState<string[]>(
    existing?.autoApproveTools ?? []
  );

  // Fetch prompts for the dropdown
  const promptsQuery = useQuery({
    queryKey: ["prompts"],
    queryFn: () => fetchJson<{ prompts: SavedPrompt[] }>("/api/admin/prompts"),
  });
  const prompts = promptsQuery.data?.prompts ?? [];

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<{ models: ModelInfo[] }>("/api/models"),
  });
  const models = modelsQuery.data?.models ?? [];

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

  const assistMutation = useMutation({
    mutationFn: (message: string) =>
      fetchJson<{ suggestion: SchedulerSuggestion }>("/api/admin/scheduler/assist", {
        method: "POST",
        body: JSON.stringify({
          message,
          promptNames: prompts.map((p) => p.name),
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
      actionPayload = { promptName };
    } else if (actionType === "pipeline") {
      if (pipelineStages.length < 2) { showToast("Pipeline needs at least 2 stages.", "error"); return; }
      actionPayload = { stages: pipelineStages };
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

    if (actionType === "prompt") {
      const modelValue = model.trim();
      if (existing) {
        payload.model = modelValue || null;
      } else if (modelValue) {
        payload.model = modelValue;
      }
    }

    // Auto-approve tools
    if (autoApproveTools.length > 0) {
      payload.autoApproveTools = autoApproveTools;
    } else if (existing) {
      payload.autoApproveTools = null;
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
    } else if (suggestion.actionPayload) {
      setPromptName("");
      setPayloadText(JSON.stringify(suggestion.actionPayload, null, 2));
    }

    if (typeof suggestion.model === "string") {
      setModel(suggestion.model);
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

  // Cron preview
  const cronParts = useMemo(() => {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const labels = ["min", "hour", "day", "month", "weekday"];
    return parts.map((p, i) => ({ label: labels[i], value: p }));
  }, [cronExpression]);

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
          hint={`"Prompt" executes a saved prompt template. "Shell" runs a command. "Custom" sends raw payload.`}
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
          </select>
        </Field>

        {actionType === "prompt" ? (
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
        ) : actionType === "pipeline" ? (
          <PipelineSection
            pipelineStages={pipelineStages}
            setPipelineStages={setPipelineStages}
            availableTools={allTools}
            availablePrompts={availablePrompts}
          />
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

        {actionType === "prompt" && (
          <Field label="Model" hint="Optional — defaults to the system model.">
            <select
              className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
              value={model ?? ""}
              onChange={(e) => setModel(e.target.value)}
              disabled={modelsQuery.isLoading}
            >
              <option value="">Default (System)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Cron Expression"
          hint={`Standard 5-field cron. Examples: "0 9 * * *" (daily 9 AM), "*/30 * * * *" (every 30 min).`}
        >
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 font-mono text-sm"
            placeholder="*/5 * * * *"
            value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)}
          />
          {cronExpression.trim() && (
            <div className="mt-1 flex flex-wrap gap-1">
              {cronParts ? (
                cronParts.map((p) => (
                  <code key={p.label} className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
                    {p.label}={p.value}
                  </code>
                ))
              ) : (
                <span className="text-[11px] text-ember">
                  Expected 5 fields: minute hour day-of-month month day-of-week
                </span>
              )}
            </div>
          )}
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
          hint="Tools that skip approval gating for this job. Leave empty for normal approval flow."
        >
          <ToolMultiSelect
            tools={allTools}
            selected={autoApproveTools.length > 0 ? autoApproveTools : null}
            onChange={(selected) => setAutoApproveTools(selected ?? [])}
            placeholder="None (normal approval flow)"
            allowAll={false}
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
  pipelineStages: Array<Record<string, unknown>>;
  setPipelineStages: (stages: Array<Record<string, unknown>>) => void;
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
            setPipelineStages(pipeline.stages as unknown as Array<Record<string, unknown>>);
            setMode("manual");
            showToast("Pipeline created via wizard — review and save below.", "success");
          }}
          onCancel={() => setMode("choose")}
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
        initialStages={pipelineStages as never[]}
        onSave={(stages) => setPipelineStages(stages as unknown as Array<Record<string, unknown>>)}
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
  actionType: "prompt" | "shell" | "custom";
  cronExpression: string;
  timezone: string;
  promptName?: string;
  actionPayload?: Record<string, unknown>;
  model?: string;
};
