"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "./section-card";
import { Button } from "@/components/ui/button";
import { TokenBadge } from "@/components/tasks/token-badge";
import type { TokenUsage } from "@/lib/types";

const TaskGraph = dynamic(
  () => import("@/components/tasks/task-graph").then((mod) => ({ default: mod.TaskGraph })),
  { ssr: false, loading: () => <p className="text-sm text-muted-foreground p-4">Loading graph…</p> }
);

const TaskTreeView = dynamic(
  () => import("@/components/tasks/task-tree-view").then((mod) => ({ default: mod.TaskTreeView })),
  { ssr: false, loading: () => <p className="text-sm text-muted-foreground p-4">Loading tree…</p> }
);

type TaskData = {
  id: string;
  parentTaskId: string | null;
  trigger: "chat" | "cron" | "agent";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  goal: string;
  context: string;
  result: string | null;
  error: string | null;
  model: string | null;
  depth: number;
  notifyOnComplete: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  tokenUsage: TokenUsage | null;
};

type TaskStats = {
  queued: number;
  running: number;
};

const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  queued: { bg: "bg-yellow-500/15", text: "text-yellow-600 dark:text-yellow-400", label: "Queued" },
  running: { bg: "bg-blue-500/15", text: "text-blue-600 dark:text-blue-400", label: "Running" },
  completed: { bg: "bg-green-500/15", text: "text-green-600 dark:text-green-400", label: "Completed" },
  failed: { bg: "bg-red-500/15", text: "text-red-600 dark:text-red-400", label: "Failed" },
  cancelled: { bg: "bg-gray-500/15", text: "text-gray-500", label: "Cancelled" },
};

const TRIGGER_ICON: Record<string, string> = {
  chat: "💬",
  cron: "⏰",
  agent: "🤖",
};

const StatusBadge = ({ status }: { status: string }) => {
  const style = STATUS_BADGE[status] ?? STATUS_BADGE.queued;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
};

const relativeTime = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
};

export const TaskDashboard = () => {
  const queryClient = useQueryClient();
  const { socket } = useSocket();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [graphTaskId, setGraphTaskId] = useState<string | null>(null);
  const [treeTaskId, setTreeTaskId] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["tasks", statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("limit", "50");
      return fetchJson<{ tasks: TaskData[]; count: number }>(`/api/tasks?${params.toString()}`);
    },
    refetchInterval: 5000,
  });

  const statsQuery = useQuery({
    queryKey: ["taskStats"],
    queryFn: () => fetchJson<TaskStats>("/api/tasks/stats"),
    refetchInterval: 3000,
  });

  const childrenQuery = useQuery({
    queryKey: ["taskChildren", expandedTask],
    queryFn: () =>
      expandedTask
        ? fetchJson<{ children: TaskData[]; count: number }>(`/api/tasks/${expandedTask}/children`)
        : Promise.resolve({ children: [], count: 0 }),
    enabled: !!expandedTask,
  });

  const cancelMutation = useMutation({
    mutationFn: (taskId: string) =>
      fetchJson(`/api/tasks/${taskId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["taskStats"] });
    },
  });

  useEffect(() => {
    if (!socket) return;

    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["taskStats"] });
    };

    socket.on("task:notification", refresh);
    return () => {
      socket.off("task:notification", refresh);
    };
  }, [socket, queryClient]);

  const tasks = tasksQuery.data?.tasks ?? [];
  const stats = statsQuery.data ?? { queued: 0, running: 0 };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <header className="rounded-2xl bg-foreground p-6 text-background shadow-panel">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
            <h1 className="mt-2 text-4xl font-semibold">Background Tasks</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Monitor background agent tasks, spawned sub-agents, and scheduled work.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 rounded-2xl bg-background/10 px-5 py-3">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Queued</p>
                <p className="text-xl font-semibold">{stats.queued}</p>
              </div>
              <div className="h-8 w-px bg-background/20" />
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Running</p>
                <p className="text-xl font-semibold">{stats.running}</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <SectionCard title="Tasks">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <select
            className="rounded-full border border-border bg-card px-3 py-2 text-xs uppercase tracking-[0.2em] text-foreground"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <span className="text-xs text-muted-foreground">
            {tasksQuery.data?.count ?? 0} task(s)
          </span>
        </div>

        <div className="space-y-3">
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No background tasks yet. Tasks appear when the agent uses <code>spawn-agent</code> or when scheduled jobs run.
            </p>
          ) : (
            tasks.map((task) => (
              <div key={task.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span title={task.trigger}>{TRIGGER_ICON[task.trigger] ?? "📋"}</span>
                      <p className="truncate text-sm font-semibold text-foreground">{task.goal}</p>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{relativeTime(task.createdAt)}</span>
                      {task.model && <span>· {task.model}</span>}
                      {task.depth > 0 && <span>· depth {task.depth}</span>}
                      {task.parentTaskId && (
                        <span>· child of <code className="text-[10px]">{task.parentTaskId.slice(0, 8)}</code></span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <TokenBadge usage={task.tokenUsage} />
                    <StatusBadge status={task.status} />
                    {(task.status === "queued" || task.status === "running") && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full text-xs"
                        onClick={() => cancelMutation.mutate(task.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>

                {/* Result or Error */}
                {task.status === "completed" && task.result && (
                  <div className="mt-3 rounded-lg bg-green-500/5 p-3">
                    <p className="text-xs font-semibold text-green-600 dark:text-green-400">Result</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs text-foreground">
                      {task.result.length > 300 ? task.result.slice(0, 300) + "…" : task.result}
                    </p>
                  </div>
                )}
                {task.status === "failed" && task.error && (
                  <div className="mt-3 rounded-lg bg-red-500/5 p-3">
                    <p className="text-xs font-semibold text-red-600 dark:text-red-400">Error</p>
                    <p className="mt-1 text-xs text-foreground">{task.error}</p>
                  </div>
                )}

                {/* Expand children */}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
                  >
                    {expandedTask === task.id ? "▼ Hide children" : "▶ Show children"}
                  </button>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setGraphTaskId(graphTaskId === task.id ? null : task.id)}
                  >
                    {graphTaskId === task.id ? "◆ Hide graph" : "◇ View graph"}
                  </button>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setTreeTaskId(treeTaskId === task.id ? null : task.id)}
                  >
                    {treeTaskId === task.id ? "▣ Hide tree" : "▢ View tree"}
                  </button>
                </div>

                {expandedTask === task.id && childrenQuery.data && (
                  <div className="mt-3 space-y-2 border-l-2 border-border pl-4">
                    {childrenQuery.data.children.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No sub-tasks.</p>
                    ) : (
                      childrenQuery.data.children.map((child) => (
                        <div key={child.id} className="flex items-center justify-between rounded-lg border border-border/50 bg-background p-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-foreground">{child.goal}</p>
                            <p className="text-[10px] text-muted-foreground">{relativeTime(child.createdAt)}</p>
                          </div>
                          <StatusBadge status={child.status} />
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Task workflow graph */}
                {graphTaskId === task.id && (
                  <div className="mt-3">
                    <TaskGraph taskId={task.id} height={400} />
                  </div>
                )}

                {/* Task tree view */}
                {treeTaskId === task.id && (
                  <div className="mt-3">
                    <TaskTreeView taskId={task.id} />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </SectionCard>
    </div>
  );
};
