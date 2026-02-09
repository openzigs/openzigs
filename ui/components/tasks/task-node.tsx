"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type TaskNodeData = {
  id: string;
  goal: string;
  status: string;
  trigger: string;
  depth: number;
  model: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  spawnedBy: string | null;
  /** Injected by the graph: number of children this task spawned */
  childCount?: number;
};

/* ─── Status → visual mapping ─── */
const STATUS_STYLES: Record<string, {
  ring: string;
  iconBg: string;
  pulse: boolean;
  label: string;
}> = {
  queued:    { ring: "ring-yellow-500/60", iconBg: "bg-yellow-500/20 text-yellow-400", pulse: false, label: "Queued" },
  running:   { ring: "ring-blue-500/60",   iconBg: "bg-blue-500/20 text-blue-400",     pulse: true,  label: "Running" },
  completed: { ring: "ring-emerald-500/60", iconBg: "bg-emerald-500/20 text-emerald-400", pulse: false, label: "Done" },
  failed:    { ring: "ring-red-500/60",     iconBg: "bg-red-500/20 text-red-400",       pulse: false, label: "Failed" },
  cancelled: { ring: "ring-gray-500/60",    iconBg: "bg-gray-500/20 text-gray-400",     pulse: false, label: "Cancelled" },
};

/* ─── Role-based node icons (SVG paths) ─── */
const ROLE_ICON: Record<string, { svg: string; label: string }> = {
  orchestrator: {
    label: "Orchestrator",
    svg: `<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  agent: {
    label: "Agent",
    svg: `<circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>`,
  },
  worker: {
    label: "Worker",
    svg: `<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M9 9h6M9 13h6M9 17h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  scheduler: {
    label: "Scheduler",
    svg: `<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  chat: {
    label: "User Request",
    svg: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};

/** Determine the role of a task node for icon selection */
function getRole(task: TaskNodeData): string {
  if (task.depth === 0 && task.trigger === "chat") return "chat";
  if (task.depth === 0 && task.trigger === "cron") return "scheduler";
  if ((task.childCount ?? 0) > 0) return "orchestrator";
  if (task.trigger === "agent") return "agent";
  return "worker";
}

/** Extract a short label from the goal (first meaningful words) */
function shortLabel(goal: string, maxLen = 40): string {
  const clean = goal.replace(/^\/\S+\s*/, "").trim();
  if (clean.length <= maxLen) return clean || goal.slice(0, maxLen);
  return clean.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}

/**
 * Orchestration-style node for the task graph.
 *
 * Circular icon badge at top, label below, status indicator,
 * model + timing metadata. Designed to resemble a professional
 * orchestration / workflow diagram.
 */
export const TaskNode = memo(({ data }: NodeProps) => {
  const task = data as unknown as TaskNodeData;
  const style = STATUS_STYLES[task.status] ?? STATUS_STYLES.queued;
  const role = getRole(task);
  const icon = ROLE_ICON[role] ?? ROLE_ICON.worker;

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent"
      />

      <div className="flex flex-col items-center gap-1.5 group">
        {/* ─── Circular icon ─── */}
        <div
          className={`
            relative flex h-14 w-14 items-center justify-center rounded-full
            ring-2 ${style.ring} ${style.iconBg}
            bg-card shadow-lg
            transition-all duration-200
            group-hover:shadow-xl group-hover:scale-105
            ${style.pulse ? "animate-pulse" : ""}
          `}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            dangerouslySetInnerHTML={{ __html: icon.svg }}
          />

          {/* Status dot — bottom-right of circle */}
          <span
            className={`
              absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card
              ${task.status === "completed" ? "bg-emerald-500" :
                task.status === "running" ? "bg-blue-500 animate-pulse" :
                task.status === "failed" ? "bg-red-500" :
                task.status === "queued" ? "bg-yellow-500" :
                "bg-gray-500"}
            `}
            title={style.label}
          />
        </div>

        {/* ─── Label card ─── */}
        <div className="flex flex-col items-center gap-0.5 max-w-[180px]">
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
            {icon.label}
          </span>

          <p className="text-center text-[11px] font-medium leading-tight text-foreground line-clamp-2">
            {shortLabel(task.goal)}
          </p>

          {task.model && (
            <span className="mt-0.5 rounded-full bg-muted/60 px-2 py-[1px] text-[9px] font-mono text-muted-foreground">
              {task.model}
            </span>
          )}

          {task.completedAt && (
            <span className="text-[9px] text-muted-foreground">
              {formatDuration(task.createdAt, task.completedAt)}
            </span>
          )}
        </div>

        {/* ─── Result / Error preview ─── */}
        {task.status === "completed" && task.result && (
          <div className="max-w-[200px] rounded-md bg-emerald-500/10 px-2 py-1">
            <p className="text-center text-[9px] leading-tight text-emerald-600 dark:text-emerald-400 line-clamp-2">
              {task.result.slice(0, 100)}
            </p>
          </div>
        )}
        {task.status === "failed" && task.error && (
          <div className="max-w-[200px] rounded-md bg-red-500/10 px-2 py-1">
            <p className="text-center text-[9px] leading-tight text-red-600 dark:text-red-400 line-clamp-2">
              {task.error.slice(0, 100)}
            </p>
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent"
      />
    </>
  );
});

TaskNode.displayName = "TaskNode";

/** Format duration between two ISO date strings. */
function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}
