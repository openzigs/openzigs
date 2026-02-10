"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Activity, Save, Minus, Plus, Wrench } from "lucide-react";

type TaskEngineConfig = {
  maxConcurrent: number;
  stats: {
    queued: number;
    running: number;
  };
};

type SessionConfig = {
  maxToolsPerRequest: number;
  totalTools: number;
  alwaysOnCount: number;
};

export const TaskEnginePanel = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["task-engine-config"],
    queryFn: () => fetchJson<TaskEngineConfig>("/api/admin/tasks/config"),
    refetchInterval: 5_000,
  });

  const sessionQuery = useQuery({
    queryKey: ["session-config"],
    queryFn: () => fetchJson<SessionConfig>("/api/admin/session/config"),
    refetchInterval: 10_000,
  });

  const [localMax, setLocalMax] = useState<number | null>(null);
  const effectiveMax = localMax ?? query.data?.maxConcurrent ?? 2;

  const [localToolLimit, setLocalToolLimit] = useState<number | null>(null);
  const effectiveToolLimit = localToolLimit ?? sessionQuery.data?.maxToolsPerRequest ?? 30;

  const mutation = useMutation({
    mutationFn: (maxConcurrent: number) =>
      fetchJson("/api/admin/tasks/config", {
        method: "PUT",
        body: JSON.stringify({ maxConcurrent }),
      }),
    onSuccess: () => {
      setLocalMax(null);
      void queryClient.invalidateQueries({ queryKey: ["task-engine-config"] });
      showToast("Concurrency updated.", "success");
    },
    onError: (err) => {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    },
  });

  const toolLimitMutation = useMutation({
    mutationFn: (maxToolsPerRequest: number) =>
      fetchJson("/api/admin/session/config", {
        method: "PUT",
        body: JSON.stringify({ maxToolsPerRequest }),
      }),
    onSuccess: () => {
      setLocalToolLimit(null);
      void queryClient.invalidateQueries({ queryKey: ["session-config"] });
      showToast("Tool limit updated.", "success");
    },
    onError: (err) => {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    },
  });

  const isDirty = localMax !== null && localMax !== (query.data?.maxConcurrent ?? 2);
  const isToolLimitDirty =
    localToolLimit !== null && localToolLimit !== (sessionQuery.data?.maxToolsPerRequest ?? 30);

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const stats = query.data?.stats ?? { queued: 0, running: 0 };
  const totalTools = sessionQuery.data?.totalTools ?? 0;
  const alwaysOnCount = sessionQuery.data?.alwaysOnCount ?? 0;

  return (
    <div className="space-y-5">
      {/* Live Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatBadge label="Running" value={stats.running} color="text-sky-500" />
        <StatBadge label="Queued" value={stats.queued} color="text-amber-500" />
        <StatBadge label="Max Concurrent" value={effectiveMax} color="text-emerald-500" />
      </div>

      {/* Concurrency Control */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Agent Concurrency</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Number of agents that can execute simultaneously. Higher values increase throughput but
          consume more API quota. Takes effect immediately — no restart required.
        </p>
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition hover:bg-muted disabled:opacity-30"
            onClick={() => setLocalMax(Math.max(1, effectiveMax - 1))}
            disabled={effectiveMax <= 1 || mutation.isPending}
          >
            <Minus className="h-4 w-4" />
          </button>

          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={effectiveMax}
            onChange={(e) => setLocalMax(Number(e.target.value))}
            disabled={mutation.isPending}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary"
          />

          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition hover:bg-muted disabled:opacity-30"
            onClick={() => setLocalMax(Math.min(10, effectiveMax + 1))}
            disabled={effectiveMax >= 10 || mutation.isPending}
          >
            <Plus className="h-4 w-4" />
          </button>

          <span className="min-w-[2ch] text-center text-sm font-bold text-foreground tabular-nums">
            {effectiveMax}
          </span>
        </div>

        {isDirty && (
          <button
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
            onClick={() => mutation.mutate(effectiveMax)}
            disabled={mutation.isPending}
          >
            <Save className="h-4 w-4" />
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {/* Tool Limit Control */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Tool Limit per Request</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Maximum number of tools sent to the model per request. {alwaysOnCount} core tools are
          always included. {totalTools > 0 && (
            <span className="font-medium text-foreground">{totalTools} tools</span>
          )}{totalTools > 0 && " registered total. "}
          Higher values give the model more capabilities but consume more context window.
        </p>
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition hover:bg-muted disabled:opacity-30"
            onClick={() => setLocalToolLimit(Math.max(1, effectiveToolLimit - 5))}
            disabled={effectiveToolLimit <= 1 || toolLimitMutation.isPending}
          >
            <Minus className="h-4 w-4" />
          </button>

          <input
            type="range"
            min={1}
            max={128}
            step={1}
            value={effectiveToolLimit}
            onChange={(e) => setLocalToolLimit(Number(e.target.value))}
            disabled={toolLimitMutation.isPending}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary"
          />

          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition hover:bg-muted disabled:opacity-30"
            onClick={() => setLocalToolLimit(Math.min(128, effectiveToolLimit + 5))}
            disabled={effectiveToolLimit >= 128 || toolLimitMutation.isPending}
          >
            <Plus className="h-4 w-4" />
          </button>

          <span className="min-w-[3ch] text-center text-sm font-bold text-foreground tabular-nums">
            {effectiveToolLimit}
          </span>
        </div>

        {isToolLimitDirty && (
          <button
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
            onClick={() => toolLimitMutation.mutate(effectiveToolLimit)}
            disabled={toolLimitMutation.isPending}
          >
            <Save className="h-4 w-4" />
            {toolLimitMutation.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {/* Task Limits (read-only) */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Safety Limits
        </h3>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <LimitItem label="Max Depth" value={5} />
          <LimitItem label="Max Children" value={10} />
          <LimitItem label="Rate/min" value={20} />
        </div>
      </div>
    </div>
  );
};

const StatBadge = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div className="flex flex-col items-center rounded-xl border border-border bg-card p-3">
    <span className={`text-2xl font-bold tabular-nums ${color}`}>{value}</span>
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
);

const LimitItem = ({ label, value }: { label: string; value: number }) => (
  <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-1.5">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-semibold text-foreground">{value}</span>
  </div>
);
