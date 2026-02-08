"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { SavedPrompt, ScheduledJob } from "@/lib/types";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";

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
        <p className="text-sm uppercase tracking-[0.3em] text-haze">OpenZigs</p>
        <h1 className="mt-1 text-3xl font-semibold text-ink">Scheduler</h1>
        <p className="mt-1 text-sm text-ink/50">
          Schedule recurring prompts, shell commands, and custom actions.
        </p>
      </header>

      <div className="mb-6 flex justify-end">
        <button
          onClick={handleNew}
          className="rounded-xl bg-tide px-5 py-2.5 text-sm font-semibold text-white"
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
          <p className="text-sm text-ink/50">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-ink/50">
            No scheduled jobs yet. Click &quot;+ New Job&quot; to create one.
          </p>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-2xl border border-ink/10 bg-white/60 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{job.name}</p>
                    <span className="rounded bg-tide/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-tide">
                      {job.actionType || "prompt"}
                    </span>
                    {!job.enabled && (
                      <span className="rounded bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-ink/50">
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
                      onClick={() => handleEdit(job)}
                      className="rounded-lg border border-tide px-3 py-1.5 text-xs font-semibold text-tide hover:bg-tide/5"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(job)}
                      className="rounded-lg border border-ember/30 px-3 py-1.5 text-xs font-semibold text-ember hover:bg-ember/5"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <code className="rounded bg-ink/5 px-2 py-1 font-mono text-xs text-ink/60">{job.cronExpression}</code>
                  <span className="text-xs text-ink/40">{job.timezone || "UTC"}</span>
                </div>
                {job.actionPayload && Object.keys(job.actionPayload).length > 0 && (
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-ink/40">
                    {job.actionType === "prompt" && job.actionPayload.promptName
                      ? `Prompt: ${job.actionPayload.promptName}`
                      : JSON.stringify(job.actionPayload, null, 2).slice(0, 200)}
                  </pre>
                )}
                <div className="mt-2 flex items-center gap-4 text-[11px] text-ink/30">
                  <span>Runs: {job.runCount || 0}</span>
                  {job.lastRunAt && <span>Last: {new Date(job.lastRunAt).toLocaleString()}</span>}
                </div>
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
  const [name, setName] = useState(existing?.name ?? "");
  const [actionType, setActionType] = useState(existing?.actionType ?? "prompt");
  const [promptName, setPromptName] = useState(
    existing?.actionType === "prompt" && existing?.actionPayload?.promptName
      ? String(existing.actionPayload.promptName)
      : ""
  );
  const [payloadText, setPayloadText] = useState(
    existing && existing.actionType !== "prompt" && existing.actionPayload
      ? JSON.stringify(existing.actionPayload, null, 2)
      : ""
  );
  const [cronExpression, setCronExpression] = useState(existing?.cronExpression ?? "");
  const [timezone, setTimezone] = useState(existing?.timezone ?? "UTC");

  // Fetch prompts for the dropdown
  const promptsQuery = useQuery({
    queryKey: ["prompts"],
    queryFn: () => fetchJson<{ prompts: SavedPrompt[] }>("/api/admin/prompts"),
  });
  const prompts = promptsQuery.data?.prompts ?? [];

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
    } else {
      try {
        actionPayload = JSON.parse(payloadText.trim() || "{}");
      } catch {
        showToast("Invalid JSON in payload field.", "error");
        return;
      }
    }

    saveMutation.mutate({
      name: name.trim(),
      cronExpression: cronExpression.trim(),
      timezone: timezone.trim() || "UTC",
      actionType,
      actionPayload,
    });
  };

  // Cron preview
  const cronParts = useMemo(() => {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const labels = ["min", "hour", "day", "month", "weekday"];
    return parts.map((p, i) => ({ label: labels[i], value: p }));
  }, [cronExpression]);

  return (
    <div className="rounded-2xl border border-tide/20 bg-white/60 p-5">
      <h3 className="mb-4 text-lg font-semibold text-ink">
        {existing ? "Edit Job" : "New Job"}
      </h3>

      <div className="space-y-3">
        <Field label="Name">
          <input
            type="text"
            className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
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
            className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
          >
            <option value="prompt">Prompt</option>
            <option value="shell">Shell</option>
            <option value="custom">Custom</option>
          </select>
        </Field>

        {actionType === "prompt" ? (
          <Field label="Linked Prompt" hint="The saved prompt to execute on each run.">
            <select
              className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
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
              <p className="mt-1 text-[11px] text-ink/40">
                No prompts saved yet.{" "}
                <a href="/library" className="text-tide hover:underline">Create one first</a>.
              </p>
            )}
          </Field>
        ) : (
          <Field
            label="Action Payload (JSON)"
            hint={actionType === "shell" ? '{"command": "echo hello"}' : "Any valid JSON object."}
          >
            <textarea
              className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 font-mono text-sm"
              rows={4}
              placeholder='{"command": "echo hello"}'
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
            />
          </Field>
        )}

        <Field
          label="Cron Expression"
          hint={`Standard 5-field cron. Examples: "0 9 * * *" (daily 9 AM), "*/30 * * * *" (every 30 min).`}
        >
          <input
            type="text"
            className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 font-mono text-sm"
            placeholder="*/5 * * * *"
            value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)}
          />
          {cronExpression.trim() && (
            <div className="mt-1 flex flex-wrap gap-1">
              {cronParts ? (
                cronParts.map((p) => (
                  <code key={p.label} className="rounded bg-tide/10 px-1.5 py-0.5 font-mono text-[11px] text-tide">
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
            className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
            placeholder="America/New_York"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-ink/10 px-4 py-2 text-xs font-semibold text-ink/60 hover:bg-ink/5"
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
    <label className="text-xs font-medium text-ink/50">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-ink/40">{hint}</p>}
  </div>
);

const ToggleSwitch = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-moss" : "bg-ink/20"}`}
    onClick={() => onChange(!checked)}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`}
    />
  </button>
);
