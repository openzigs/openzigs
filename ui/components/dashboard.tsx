"use client";

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "./section-card";
import { PromptLibraryDrawer } from "./prompt-library-drawer";
import { ScheduleManagerPanel } from "./schedule-manager-panel";
import { ToastContainer, showToast } from "./toast";

type ToolInfo = {
  name: string;
  description: string;
  category: string;
  riskLevel: string;
  enabled: boolean;
};

type Approval = {
  id: string;
  tool: string;
  riskLevel: string;
  status: string;
  createdAt: string;
  explanation: string;
  preview?: string;
  decidedVia?: string;
};

type AuditEntry = {
  id: string;
  timestamp: string;
  level: string;
  category: string;
  event: string;
  details: Record<string, unknown>;
};

const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
const SOCKET_URL = process.env.NEXT_PUBLIC_OPENZIGS_SOCKET_URL ?? API_BASE;
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

const buildUrl = (path: string) => {
  if (!API_BASE) {
    return path;
  }
  return `${API_BASE}${path}`;
};

const fetchJson = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (AUTH_TOKEN) {
    headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  }

  const response = await fetch(buildUrl(path), {
    ...options,
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
};

export const Dashboard = () => {
  const queryClient = useQueryClient();
  const [logCategory, setLogCategory] = useState("all");
  const [logLevel, setLogLevel] = useState("all");
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false);

  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => fetchJson<{ tools: Record<string, ToolInfo[]> }>("/api/tools")
  });

  const approvalsQuery = useQuery({
    queryKey: ["approvals"],
    queryFn: () => fetchJson<{ approvals: Approval[] }>("/api/approvals?status=pending")
  });

  const logsQuery = useQuery({
    queryKey: ["logs", logCategory, logLevel],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "8" });
      if (logCategory !== "all") {
        params.set("category", logCategory);
      }
      if (logLevel !== "all") {
        params.set("level", logLevel);
      }
      return fetchJson<{ entries: AuditEntry[] }>(`/api/logs?${params.toString()}`);
    }
  });

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchJson<{ status: string }>("/api/health")
  });

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      fetchJson(`/api/tools/${name}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled })
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tools"] })
  });

  const decisionMutation = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) =>
      fetchJson(`/api/approvals/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ approved, decidedBy: "web-ui", decidedVia: "web" })
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["approvals"] })
  });

  useEffect(() => {
    if (!SOCKET_URL) {
      return;
    }
    const socket: Socket = io(SOCKET_URL, {
      transports: ["websocket"],
      withCredentials: true
    });

    socket.on("approval:request", () => {
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    });

    socket.on("approval:decided", () => {
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    });

    socket.on("tool:toggled", () => {
      queryClient.invalidateQueries({ queryKey: ["tools"] });
    });

    socket.on("job:executed", (data: { jobName?: string; success?: boolean }) => {
      const name = data.jobName ?? "Job";
      if (data.success) {
        showToast(`${name} completed`, "success");
      } else {
        showToast(`${name} failed`, "error");
      }
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    });

    return () => {
      socket.disconnect();
    };
  }, [queryClient]);

  const toolGroups = toolsQuery.data?.tools ?? {};
  const pendingApprovals = approvalsQuery.data?.approvals ?? [];
  const recentLogs = logsQuery.data?.entries ?? [];

  const statusText = healthQuery.isSuccess ? "Connected" : healthQuery.isError ? "Needs auth" : "Connecting";

  const toolCount = useMemo(() => {
    return Object.values(toolGroups).reduce((acc, group) => acc + group.length, 0);
  }, [toolGroups]);

  const handleExport = () => {
    const payload = JSON.stringify(recentLogs, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "openzigs-audit-log.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <header className="rounded-3xl bg-ink p-6 text-stone shadow-panel">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-haze">OpenZigs</p>
            <h1 className="mt-2 text-4xl font-semibold">Control Panel</h1>
            <p className="mt-2 text-sm text-haze">
              Monitor approvals, tool controls, and audit activity in real time.
            </p>
          </div>
          <div className="flex items-center gap-4 rounded-2xl bg-stone/10 px-5 py-3">
            <button
              onClick={() => setPromptDrawerOpen(true)}
              className="rounded-full bg-tide px-4 py-2 text-xs font-semibold text-white"
            >
              Prompt Library
            </button>
            <span className="text-sm text-haze">Agent status</span>
            <span className="rounded-full bg-ember px-3 py-1 text-xs font-semibold text-ink">
              {statusText}
            </span>
          </div>
        </div>
      </header>

      <div className="dashboard-grid">
        <div className="flex flex-col gap-6">
          <SectionCard title="Tool Management">
            <div className="space-y-4">
              {Object.entries(toolGroups).map(([groupName, tools]) => (
                <div key={groupName} className="rounded-2xl border border-ink/10 bg-white/60 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-tide">
                      {groupName}
                    </h3>
                    <span className="text-xs text-ink/70">{tools.length} tools</span>
                  </div>
                  <div className="space-y-3">
                    {tools.map((tool) => (
                      <div key={tool.name} className="flex flex-col gap-2 rounded-xl bg-stone/80 p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-semibold text-ink">{tool.name}</p>
                            <p className="text-xs text-ink/60">{tool.description}</p>
                          </div>
                          <button
                            className={`rounded-full px-4 py-1 text-xs font-semibold transition ${
                              tool.enabled
                                ? "bg-moss text-white"
                                : "bg-ink/10 text-ink"
                            }`}
                            onClick={() => toggleMutation.mutate({ name: tool.name, enabled: !tool.enabled })}
                          >
                            {tool.enabled ? "Enabled" : "Disabled"}
                          </button>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-ink/60">
                          <span className="uppercase tracking-[0.2em]">{tool.category}</span>
                          <span className="rounded-full bg-ink/10 px-2 py-1 text-[10px] font-semibold uppercase">
                            {tool.riskLevel}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Audit Log">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <select
                className="rounded-full border border-ink/10 bg-white/80 px-3 py-2 text-xs uppercase tracking-[0.2em]"
                value={logCategory}
                onChange={(event) => setLogCategory(event.target.value)}
              >
                <option value="all">All categories</option>
                <option value="system">System</option>
                <option value="tool">Tool</option>
                <option value="security">Security</option>
              </select>
              <select
                className="rounded-full border border-ink/10 bg-white/80 px-3 py-2 text-xs uppercase tracking-[0.2em]"
                value={logLevel}
                onChange={(event) => setLogLevel(event.target.value)}
              >
                <option value="all">All levels</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
                <option value="security">Security</option>
              </select>
              <button
                className="rounded-full border border-ink/10 bg-ember px-4 py-2 text-xs font-semibold text-ink"
                onClick={handleExport}
              >
                Export JSON
              </button>
            </div>
            <div className="space-y-3">
              {recentLogs.length === 0 ? (
                <p className="text-sm text-ink/60">No activity yet.</p>
              ) : (
                recentLogs.map((log) => (
                  <div key={log.id} className="rounded-2xl border border-ink/10 bg-white/60 p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-ink">{log.event}</p>
                        <p className="text-xs text-ink/60">{log.category} · {log.level}</p>
                      </div>
                      <span className="text-xs text-ink/50">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </SectionCard>
        </div>

        <div className="flex flex-col gap-6">
          <SectionCard title="Snapshot">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-ink/10 bg-white/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-ink/60">Tools</p>
                <p className="mt-2 text-2xl font-semibold text-ink">{toolCount}</p>
              </div>
              <div className="rounded-2xl border border-ink/10 bg-white/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-ink/60">Approvals</p>
                <p className="mt-2 text-2xl font-semibold text-ink">{pendingApprovals.length}</p>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Pending Approvals">
            <div className="space-y-4">
              {pendingApprovals.length === 0 ? (
                <p className="text-sm text-ink/60">No approvals waiting.</p>
              ) : (
                pendingApprovals.map((approval) => (
                  <div key={approval.id} className="rounded-2xl border border-ink/10 bg-white/60 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-ink">{approval.tool}</p>
                        <p className="text-xs text-ink/60">{approval.explanation}</p>
                      </div>
                      <span className="rounded-full bg-ember px-3 py-1 text-[10px] font-semibold uppercase text-ink">
                        {approval.riskLevel}
                      </span>
                    </div>
                    {approval.preview ? (
                      <p className="mt-2 text-xs text-ink/70">{approval.preview}</p>
                    ) : null}
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        className="rounded-full bg-moss px-4 py-1 text-xs font-semibold text-white"
                        onClick={() => decisionMutation.mutate({ id: approval.id, approved: true })}
                      >
                        Approve
                      </button>
                      <button
                        className="rounded-full border border-ink/20 px-4 py-1 text-xs font-semibold text-ink"
                        onClick={() => decisionMutation.mutate({ id: approval.id, approved: false })}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </SectionCard>

          <SectionCard title="Scheduler">
            <ScheduleManagerPanel />
          </SectionCard>
        </div>
      </div>

      <PromptLibraryDrawer open={promptDrawerOpen} onClose={() => setPromptDrawerOpen(false)} />
      <ToastContainer />
    </div>
  );
};
