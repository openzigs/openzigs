"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

type TaskNodeData = {
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
};

const STATUS_COLORS: Record<string, { border: string; bg: string; dot: string }> = {
  queued: { border: "border-yellow-500/40", bg: "bg-yellow-500/5", dot: "bg-yellow-500" },
  running: { border: "border-blue-500/40", bg: "bg-blue-500/5", dot: "bg-blue-500 animate-pulse" },
  completed: { border: "border-green-500/40", bg: "bg-green-500/5", dot: "bg-green-500" },
  failed: { border: "border-red-500/40", bg: "bg-red-500/5", dot: "bg-red-500" },
  cancelled: { border: "border-gray-400/40", bg: "bg-gray-400/5", dot: "bg-gray-400" },
};

const TRIGGER_ICON: Record<string, string> = {
  chat: "💬",
  cron: "⏰",
  agent: "🤖",
};

/**
 * Custom React Flow node for visualising a single AgentTask.
 * Shows trigger icon, goal text (truncated), status dot, and model.
 */
export const TaskNode = memo(({ data }: NodeProps) => {
  const task = data as unknown as TaskNodeData;
  const colors = STATUS_COLORS[task.status] ?? STATUS_COLORS.queued;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-border !bg-muted-foreground" />
      <div
        className={`min-w-[200px] max-w-[280px] rounded-xl border-2 ${colors.border} ${colors.bg} bg-card p-3 shadow-sm transition-shadow hover:shadow-md`}
      >
        {/* Header: trigger + status dot */}
        <div className="flex items-center gap-2">
          <span className="text-sm">{TRIGGER_ICON[task.trigger] ?? "📋"}</span>
          <span
            className={`h-2 w-2 rounded-full ${colors.dot}`}
            title={task.status}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {task.status}
          </span>
          {task.depth > 0 && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              d:{task.depth}
            </span>
          )}
        </div>

        {/* Goal */}
        <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-snug text-foreground">
          {task.goal}
        </p>

        {/* Model + timing */}
        <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
          {task.model && <span className="font-mono">{task.model}</span>}
          {task.completedAt && (
            <span className="ml-auto">
              {formatDuration(task.createdAt, task.completedAt)}
            </span>
          )}
        </div>

        {/* Result / Error preview */}
        {task.status === "completed" && task.result && (
          <p className="mt-1.5 line-clamp-1 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-700 dark:text-green-400">
            {task.result.slice(0, 80)}
          </p>
        )}
        {task.status === "failed" && task.error && (
          <p className="mt-1.5 line-clamp-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-700 dark:text-red-400">
            {task.error.slice(0, 80)}
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-border !bg-muted-foreground" />
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
