"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { TaskTreeNode, TaskTreeStats } from "@/lib/types";
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Ban,
  BarChart3,
} from "lucide-react";

/* ── Status styling ── */

const STATUS_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string; label: string }> = {
  queued: { icon: Clock, color: "text-amber-500", label: "Queued" },
  running: { icon: Loader2, color: "text-blue-500", label: "Running" },
  completed: { icon: CheckCircle2, color: "text-green-500", label: "Done" },
  failed: { icon: XCircle, color: "text-red-500", label: "Failed" },
  cancelled: { icon: Ban, color: "text-gray-400", label: "Cancelled" },
};

/* ── Tree Node ── */

function TreeNode({
  node,
  depth,
  defaultExpanded,
}: {
  node: TaskTreeNode;
  depth: number;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children.length > 0;
  const cfg = STATUS_CONFIG[node.status] ?? STATUS_CONFIG.queued;
  const Icon = cfg.icon;
  const isAnimated = node.status === "running";
  const durationStr = node.durationMs != null ? `${(node.durationMs / 1000).toFixed(1)}s` : null;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 px-1 rounded-md hover:bg-muted/50 cursor-pointer group"
        style={{ paddingLeft: `${depth * 20 + 4}px` }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {/* Expand toggle */}
        <span className="w-4 shrink-0 flex items-center justify-center">
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : (
            <span className="h-3.5 w-3.5" />
          )}
        </span>

        {/* Status icon */}
        <Icon className={`h-3.5 w-3.5 shrink-0 ${cfg.color} ${isAnimated ? "animate-spin" : ""}`} />

        {/* Goal */}
        <span className="text-xs text-foreground truncate flex-1">{node.goal}</span>

        {/* Duration */}
        {durationStr && (
          <span className="text-[10px] text-muted-foreground font-mono shrink-0">{durationStr}</span>
        )}

        {/* Token usage */}
        {node.tokenUsage?.totalTokens != null && node.tokenUsage.totalTokens > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {node.tokenUsage.totalTokens.toLocaleString()} tok
          </span>
        )}

        {/* Child count badge */}
        {hasChildren && (
          <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-1.5 shrink-0">
            {node.children.length}
          </span>
        )}
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              defaultExpanded={child.status === "running"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Stats Bar ── */

function StatsBar({ stats }: { stats: TaskTreeStats }) {
  const total = stats.totalTasks;
  if (total === 0) return null;

  const segments = [
    { count: stats.completed, color: "bg-green-500", label: "Done" },
    { count: stats.running, color: "bg-blue-500", label: "Running" },
    { count: stats.queued, color: "bg-amber-500", label: "Queued" },
    { count: stats.failed, color: "bg-red-500", label: "Failed" },
    { count: stats.cancelled, color: "bg-gray-400", label: "Cancelled" },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <BarChart3 className="h-3 w-3" />
        <span>{total} task{total !== 1 ? "s" : ""}</span>
        {stats.totalTokens > 0 && <span>· {stats.totalTokens.toLocaleString()} tokens</span>}
      </div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className={`${seg.color} transition-all`}
            style={{ width: `${(seg.count / total) * 100}%` }}
            title={`${seg.label}: ${seg.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        {segments.map((seg) => (
          <span key={seg.label} className="flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-full ${seg.color}`} />
            {seg.label}: {seg.count}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Main Component ── */

export function TaskTreeView({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const { socket } = useSocket();

  const { data, isLoading, error } = useQuery({
    queryKey: ["taskTree", taskId],
    queryFn: () =>
      fetchJson<{ tree: TaskTreeNode; stats: TaskTreeStats }>(`/api/tasks/${taskId}/tree?maxDepth=10`),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!socket) return;
    const handleTreeUpdate = (ev: { rootTaskId: string }) => {
      if (ev.rootTaskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ["taskTree", taskId] });
      }
    };
    socket.on("task:tree-update", handleTreeUpdate);
    return () => {
      socket.off("task:tree-update", handleTreeUpdate);
    };
  }, [socket, taskId, queryClient]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tree…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 text-xs text-red-500">
        Failed to load task tree.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <StatsBar stats={data.stats} />
      <div className="max-h-80 overflow-y-auto border border-border rounded-lg bg-background p-2">
        <TreeNode node={data.tree} depth={0} defaultExpanded />
      </div>
    </div>
  );
}
