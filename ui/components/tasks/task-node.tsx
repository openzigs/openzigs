"use client";

import { memo, useEffect, useRef, useState } from "react";
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
  /** Whether this node has running children (waiting on sub-agents) */
  isWaiting?: boolean;
  /** Previous status for transition animations */
  prevStatus?: string;
};

/* ─── Status → visual mapping ─── */
const STATUS_STYLES: Record<string, {
  ring: string;
  ringGlow: string;
  iconBg: string;
  dotColor: string;
  label: string;
}> = {
  queued:    {
    ring: "ring-amber-400/40",
    ringGlow: "",
    iconBg: "bg-amber-500/10 text-amber-400",
    dotColor: "bg-amber-400",
    label: "Queued",
  },
  running:   {
    ring: "ring-blue-500/70",
    ringGlow: "shadow-[0_0_20px_4px_rgba(59,130,246,0.3)]",
    iconBg: "bg-blue-500/15 text-blue-400",
    dotColor: "bg-blue-500",
    label: "Running",
  },
  completed: {
    ring: "ring-emerald-500/70",
    ringGlow: "shadow-[0_0_12px_2px_rgba(16,185,129,0.25)]",
    iconBg: "bg-emerald-500/15 text-emerald-400",
    dotColor: "bg-emerald-500",
    label: "Done",
  },
  failed:    {
    ring: "ring-red-500/70",
    ringGlow: "shadow-[0_0_12px_2px_rgba(239,68,68,0.25)]",
    iconBg: "bg-red-500/15 text-red-400",
    dotColor: "bg-red-500",
    label: "Failed",
  },
  cancelled: {
    ring: "ring-gray-500/40",
    ringGlow: "",
    iconBg: "bg-gray-500/10 text-gray-400",
    dotColor: "bg-gray-500",
    label: "Cancelled",
  },
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
 * Orchestration-style node with real-time status animations.
 *
 * - Running: pulsing glow, animated status dot, spinning progress ring
 * - Completed: green glow, pop-in transition, checkmark overlay
 * - Failed: red glow, error pulse
 * - Waiting: breathing animation for orchestrators waiting on children
 * - Queued: subtle amber dot
 */
export const TaskNode = memo(({ data }: NodeProps) => {
  const task = data as unknown as TaskNodeData;
  const style = STATUS_STYLES[task.status] ?? STATUS_STYLES.queued;
  const role = getRole(task);
  const icon = ROLE_ICON[role] ?? ROLE_ICON.worker;
  const isRunning = task.status === "running";
  const isCompleted = task.status === "completed";
  const isFailed = task.status === "failed";
  const isWaiting = task.isWaiting && isRunning;

  // Track status transitions for pop animation
  const [justCompleted, setJustCompleted] = useState(false);
  const prevStatusRef = useRef(task.status);

  useEffect(() => {
    if (prevStatusRef.current !== "completed" && task.status === "completed") {
      setJustCompleted(true);
      const timer = setTimeout(() => setJustCompleted(false), 500);
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = task.status;
  }, [task.status]);

  // Elapsed time for running tasks
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    if (!isRunning) {
      setElapsed("");
      return;
    }
    const start = new Date(task.createdAt).getTime();
    const tick = () => {
      const ms = Date.now() - start;
      if (ms < 1000) setElapsed(`${ms}ms`);
      else {
        const secs = Math.floor(ms / 1000);
        if (secs < 60) setElapsed(`${secs}s`);
        else setElapsed(`${Math.floor(secs / 60)}m ${secs % 60}s`);
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isRunning, task.createdAt]);

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent"
      />

      <div className="flex flex-col items-center gap-1.5 group">
        {/* ─── Circular icon with animated effects ─── */}
        <div className="relative">
          {/* Outer glow ring for running state */}
          {isRunning && !isWaiting && (
            <div className="absolute inset-[-4px] rounded-full bg-blue-500/10 node-running" />
          )}
          {/* Waiting state: orbiting dots */}
          {isWaiting && (
            <>
              <div className="absolute inset-[-6px] rounded-full node-waiting">
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-2 w-2 rounded-full bg-blue-400/60" style={{ animation: "waiting-orbit 2s linear infinite" }} />
                </div>
              </div>
              <div className="absolute inset-[-6px] rounded-full">
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-300/40" style={{ animation: "waiting-orbit 2s linear infinite 0.67s" }} />
                </div>
              </div>
              <div className="absolute inset-[-6px] rounded-full">
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-300/30" style={{ animation: "waiting-orbit 2s linear infinite 1.33s" }} />
                </div>
              </div>
            </>
          )}

          {/* Spinning progress ring for running */}
          {isRunning && (
            <svg
              className="absolute inset-[-3px] h-[62px] w-[62px]"
              viewBox="0 0 62 62"
              style={{ animation: "ring-spin 3s linear infinite" }}
            >
              <circle
                cx="31"
                cy="31"
                r="29"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="40 142"
                className="text-blue-500/40"
                strokeLinecap="round"
              />
            </svg>
          )}

          <div
            className={`
              relative flex h-14 w-14 items-center justify-center rounded-full
              ring-2 ${style.ring}
              ${style.iconBg}
              ${style.ringGlow}
              bg-card
              transition-all duration-500 ease-out
              group-hover:scale-110
              ${justCompleted ? "node-completed-pop" : ""}
            `}
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-6 w-6 transition-all duration-300 ${isRunning ? "opacity-80" : ""}`}
              dangerouslySetInnerHTML={{ __html: icon.svg }}
            />

            {/* Completion checkmark overlay */}
            {isCompleted && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-emerald-500/10" />
              </div>
            )}
          </div>

          {/* Status dot — bottom-right of circle */}
          <span
            className={`
              absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full
              border-2 border-card
              ${style.dotColor}
              ${isRunning ? "status-dot-active" : ""}
              transition-colors duration-500
            `}
            title={style.label}
          />
        </div>

        {/* ─── Label card ─── */}
        <div className="flex flex-col items-center gap-0.5 max-w-[180px]">
          <span className={`text-[9px] font-bold uppercase tracking-[0.15em] transition-colors duration-300 ${
            isRunning ? "text-blue-400" :
            isCompleted ? "text-emerald-400" :
            isFailed ? "text-red-400" :
            "text-muted-foreground"
          }`}>
            {isWaiting ? "Waiting" : icon.label}
          </span>

          <p className="text-center text-[11px] font-medium leading-tight text-foreground line-clamp-2">
            {shortLabel(task.goal)}
          </p>

          {/* Model badge */}
          {task.model && (
            <span className="mt-0.5 rounded-full bg-muted/60 px-2 py-[1px] text-[9px] font-mono text-muted-foreground">
              {task.model}
            </span>
          )}

          {/* Duration: live elapsed for running, final for completed */}
          {isRunning && elapsed && (
            <span className="text-[9px] font-mono text-blue-400 tabular-nums">
              {elapsed}
            </span>
          )}
          {task.completedAt && !isRunning && (
            <span className="text-[9px] text-muted-foreground">
              {formatDuration(task.createdAt, task.completedAt)}
            </span>
          )}
        </div>

        {/* ─── Result / Error preview ─── */}
        {isCompleted && task.result && (
          <div className="max-w-[200px] rounded-md bg-emerald-500/10 px-2 py-1 animate-slide-in">
            <p className="text-center text-[9px] leading-tight text-emerald-600 dark:text-emerald-400 line-clamp-2">
              {task.result.slice(0, 100)}
            </p>
          </div>
        )}
        {isFailed && task.error && (
          <div className="max-w-[200px] rounded-md bg-red-500/10 px-2 py-1 animate-slide-in">
            <p className="text-center text-[9px] leading-tight text-red-600 dark:text-red-400 line-clamp-2">
              {task.error.slice(0, 100)}
            </p>
          </div>
        )}

        {/* Waiting indicator for orchestrators */}
        {isWaiting && (
          <div className="max-w-[200px] rounded-md bg-blue-500/10 px-2 py-1 animate-slide-in">
            <p className="text-center text-[9px] leading-tight text-blue-400">
              Waiting on {task.childCount ?? 0} sub-agent{(task.childCount ?? 0) > 1 ? "s" : ""}…
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
