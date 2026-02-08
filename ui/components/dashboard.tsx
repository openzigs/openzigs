"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { ToolInfo, Approval, AuditEntry } from "@/lib/types";
import { SectionCard } from "./section-card";
import { ToastContainer, showToast } from "./toast";
import { Button } from "@/components/ui/button";

export const Dashboard = () => {
  const queryClient = useQueryClient();
  const { socket, connected } = useSocket();
  const [logCategory, setLogCategory] = useState("all");
  const [logLevel, setLogLevel] = useState("all");

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
      if (logCategory !== "all") params.set("category", logCategory);
      if (logLevel !== "all") params.set("level", logLevel);
      return fetchJson<{ entries: AuditEntry[] }>(`/api/logs?${params.toString()}`);
    }
  });

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchJson<{ status: string }>("/api/health")
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
    if (!socket) return;

    const refreshApprovals = () => queryClient.invalidateQueries({ queryKey: ["approvals"] });
    const refreshTools = () => queryClient.invalidateQueries({ queryKey: ["tools"] });
    const onJobExecuted = (data: { jobName?: string; success?: boolean }) => {
      const name = data.jobName ?? "Job";
      showToast(`${name} ${data.success ? "completed" : "failed"}`, data.success ? "success" : "error");
    };

    socket.on("approval:request", refreshApprovals);
    socket.on("approval:decided", refreshApprovals);
    socket.on("tool:toggled", refreshTools);
    socket.on("job:executed", onJobExecuted);

    return () => {
      socket.off("approval:request", refreshApprovals);
      socket.off("approval:decided", refreshApprovals);
      socket.off("tool:toggled", refreshTools);
      socket.off("job:executed", onJobExecuted);
    };
  }, [socket, queryClient]);

  const toolGroups = toolsQuery.data?.tools;

  const statusText = healthQuery.isSuccess
    ? connected ? "Connected" : "Polling"
    : healthQuery.isError ? "Needs auth" : "Connecting";

  const toolCount = useMemo(() => {
    if (!toolGroups) return 0;
    return Object.values(toolGroups).reduce((acc, group) => acc + group.length, 0);
  }, [toolGroups]);

  const pendingApprovals = approvalsQuery.data?.approvals ?? [];
  const recentLogs = logsQuery.data?.entries ?? [];

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
      <header className="rounded-2xl bg-foreground p-6 text-background shadow-panel">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
            <h1 className="mt-2 text-4xl font-semibold">Control Panel</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Monitor approvals, tool controls, and audit activity in real time.
            </p>
          </div>
          <div className="flex items-center gap-4 rounded-2xl bg-background/10 px-5 py-3">
            <span className="text-sm text-muted-foreground">Agent status</span>
            <span className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground">
              {statusText}
            </span>
          </div>
        </div>
      </header>

      <div className="dashboard-grid">
        <div className="flex flex-col gap-6">
          <SectionCard title="Audit Log">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <select
                className="rounded-full border border-border bg-card px-3 py-2 text-xs uppercase tracking-[0.2em] text-foreground"
                value={logCategory}
                onChange={(event) => setLogCategory(event.target.value)}
              >
                <option value="all">All categories</option>
                <option value="system">System</option>
                <option value="tool">Tool</option>
                <option value="security">Security</option>
              </select>
              <select
                className="rounded-full border border-border bg-card px-3 py-2 text-xs uppercase tracking-[0.2em] text-foreground"
                value={logLevel}
                onChange={(event) => setLogLevel(event.target.value)}
              >
                <option value="all">All levels</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
                <option value="security">Security</option>
              </select>
              <Button variant="default" size="sm" onClick={handleExport} className="rounded-full">
                Export JSON
              </Button>
            </div>
            <div className="space-y-3">
              {recentLogs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                recentLogs.map((log) => (
                  <div key={log.id} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{log.event}</p>
                        <p className="text-xs text-muted-foreground">{log.category} · {log.level}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">
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
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Tools</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{toolCount}</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Approvals</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{pendingApprovals.length}</p>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Pending Approvals">
            <div className="space-y-4">
              {pendingApprovals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No approvals waiting.</p>
              ) : (
                pendingApprovals.map((approval) => (
                  <div key={approval.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{approval.tool}</p>
                        <p className="text-xs text-muted-foreground">{approval.explanation}</p>
                      </div>
                      <span className="rounded-full bg-accent/15 px-3 py-1 text-[10px] font-semibold uppercase text-accent">
                        {approval.riskLevel}
                      </span>
                    </div>
                    {approval.preview ? (
                      <p className="mt-2 text-xs text-muted-foreground">{approval.preview}</p>
                    ) : null}
                    <div className="mt-3 flex items-center gap-2">
                      <Button size="sm" className="rounded-full" onClick={() => decisionMutation.mutate({ id: approval.id, approved: true })}>
                        Approve
                      </Button>
                      <Button variant="outline" size="sm" className="rounded-full" onClick={() => decisionMutation.mutate({ id: approval.id, approved: false })}>
                        Reject
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </SectionCard>
        </div>
      </div>

      <ToastContainer />
    </div>
  );
};
