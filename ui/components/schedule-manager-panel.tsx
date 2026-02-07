"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type ScheduledJob = {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
};

const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

const buildUrl = (path: string) => (API_BASE ? `${API_BASE}${path}` : path);

const fetchJson = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (AUTH_TOKEN) headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  const response = await fetch(buildUrl(path), { ...options, headers });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
};

export const ScheduleManagerPanel = () => {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCron, setNewCron] = useState("");
  const [newTimezone, setNewTimezone] = useState("UTC");
  const [newPayload, setNewPayload] = useState("");

  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: () => fetchJson<{ jobs: ScheduledJob[] }>("/api/jobs"),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson("/api/jobs", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setShowCreate(false);
      setNewName("");
      setNewCron("");
      setNewPayload("");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      fetchJson(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const jobs = jobsQuery.data?.jobs ?? [];

  const handleCreate = () => {
    let payload: Record<string, unknown> = {};
    try {
      payload = newPayload ? (JSON.parse(newPayload) as Record<string, unknown>) : {};
    } catch {
      // ignore bad JSON
    }
    createMutation.mutate({
      name: newName,
      cronExpression: newCron,
      timezone: newTimezone,
      actionPayload: payload,
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-tide">
          Scheduled Jobs
        </h3>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-full bg-tide px-3 py-1 text-xs font-semibold text-white"
        >
          {showCreate ? "Cancel" : "+ New Job"}
        </button>
      </div>

      {showCreate && (
        <div className="rounded-2xl border border-tide/20 bg-white/60 p-4 space-y-3">
          <input
            type="text"
            placeholder="Job name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Cron expression (e.g. 0 9 * * *)"
              value={newCron}
              onChange={(e) => setNewCron(e.target.value)}
              className="rounded-lg border border-ink/10 px-3 py-2 text-sm"
            />
            <input
              type="text"
              placeholder="Timezone (e.g. America/New_York)"
              value={newTimezone}
              onChange={(e) => setNewTimezone(e.target.value)}
              className="rounded-lg border border-ink/10 px-3 py-2 text-sm"
            />
          </div>
          <textarea
            placeholder='Action payload (JSON, e.g. {"promptName": "daily-summary"})'
            value={newPayload}
            onChange={(e) => setNewPayload(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm font-mono"
          />
          <button
            onClick={handleCreate}
            disabled={!newName || !newCron}
            className="w-full rounded-xl bg-moss px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Create Job
          </button>
        </div>
      )}

      {jobs.length === 0 ? (
        <p className="text-sm text-ink/60">No scheduled jobs yet.</p>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <div key={job.id} className="rounded-2xl border border-ink/10 bg-white/60 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-ink">{job.name}</p>
                  <p className="text-xs text-ink/60 font-mono mt-1">
                    {job.cronExpression} ({job.timezone})
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleMutation.mutate({ id: job.id, enabled: !job.enabled })}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                      job.enabled ? "bg-moss text-white" : "bg-ink/10 text-ink"
                    }`}
                  >
                    {job.enabled ? "Enabled" : "Disabled"}
                  </button>
                  <button
                    onClick={() => deleteMutation.mutate(job.id)}
                    className="text-xs text-ember hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-4 text-xs text-ink/50">
                <span>Runs: {job.runCount}</span>
                {job.lastRunAt && (
                  <span>Last: {new Date(job.lastRunAt).toLocaleString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
