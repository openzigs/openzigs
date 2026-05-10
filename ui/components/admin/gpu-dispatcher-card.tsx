"use client";

/**
 * GPU Dispatcher panel — surfaces per-GPU dispatcher lane state from
 * `/api/system/gpu` (`dispatcher.gpus[]`) and live updates over Socket.IO
 * (`gpu:dispatcher:state`). Issue #1060 (Epic #1053).
 *
 * - Per-GPU card: state badge, current job, queue depth, mutex-blocked tooltip.
 * - "Cancel running job" button (with `window.confirm`) → POST
 *   /api/admin/gpu/dispatcher/:idx/cancel.
 * - "Retry" button on error lanes → POST /api/admin/gpu/dispatcher/:idx/clear-error.
 *
 * The panel renders an empty-state hint when the server response omits the
 * `dispatcher` block (e.g. legacy server, no GPUs detected).
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Ban, Loader2, RotateCcw } from "lucide-react";

import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { useSocket } from "@/lib/socket-context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type DispatcherWorkloadType = "llm" | "image" | "video";
export type DispatcherLaneState = "idle" | "busy" | "error";

export interface DispatcherLaneSnapshot {
  index: number;
  state: DispatcherLaneState;
  currentJob?: {
    id: string;
    workloadType: DispatcherWorkloadType;
    startedAt: number;
  };
  lastError?: string;
  queueDepth: number;
  mutexBlockedBy?: DispatcherWorkloadType;
}

const stateStyles: Record<DispatcherLaneState, string> = {
  idle: "bg-muted text-muted-foreground",
  busy: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
};

const workloadLabels: Record<DispatcherWorkloadType, string> = {
  llm: "LLM",
  image: "Image",
  video: "Video",
};

function mutexLabel(blocker: DispatcherWorkloadType): string {
  if (blocker === "llm") return "Blocked: LLM workload running on another GPU";
  return `Blocked: ${workloadLabels[blocker]} render running on another GPU`;
}

function elapsed(startedAt: number, now: number): string {
  const ms = Math.max(0, now - startedAt);
  if (ms < 1000) return `${ms} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

export interface GpuDispatcherCardProps {
  /** Initial snapshot from the parent GPU panel query. */
  initial: DispatcherLaneSnapshot;
}

export const GpuDispatcherCard = ({ initial }: GpuDispatcherCardProps) => {
  const [snap, setSnap] = useState<DispatcherLaneSnapshot>(initial);
  // Re-render every second so the elapsed-time label ticks while a job runs.
  const [, setTick] = useState(0);
  // Bug #1064-PN-B: replace native window.confirm with shadcn Dialog.
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { socket } = useSocket();

  // Sync to parent prop changes when /api/system/gpu refetches.
  useEffect(() => {
    setSnap(initial);
  }, [initial]);

  // Live updates over Socket.IO (Issue #1060 AC: "Live updates via existing
  // Socket.IO channel — no polling.").
  useEffect(() => {
    if (!socket) return;
    const handler = (next: DispatcherLaneSnapshot) => {
      if (next.index !== snap.index) return;
      setSnap(next);
    };
    socket.on("gpu:dispatcher:state", handler);
    return () => {
      socket.off("gpu:dispatcher:state", handler);
    };
  }, [socket, snap.index]);

  // Tick the elapsed timer while a job is running.
  useEffect(() => {
    if (snap.state !== "busy") return;
    const interval = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(interval);
  }, [snap.state]);

  const cancelMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ cancelled: boolean }>(
        `/api/admin/gpu/dispatcher/${snap.index}/cancel`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      if (data.cancelled) {
        showToast(`Cancelled job on GPU ${snap.index}`, "success");
      } else {
        showToast(`No running job on GPU ${snap.index}`, "error");
      }
      queryClient.invalidateQueries({ queryKey: ["gpu-profile"] });
    },
    onError: (err) =>
      showToast(`Cancel failed: ${(err as Error).message}`, "error"),
  });

  const retryMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ cleared: boolean }>(
        `/api/admin/gpu/dispatcher/${snap.index}/clear-error`,
        { method: "POST" },
      ),
    onSuccess: () => {
      showToast(`GPU ${snap.index} returned to idle`, "success");
      queryClient.invalidateQueries({ queryKey: ["gpu-profile"] });
    },
    onError: (err) =>
      showToast(`Retry failed: ${(err as Error).message}`, "error"),
  });

  const handleCancel = () => {
    setCancelDialogOpen(true);
  };

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${snap.state === "error" ? "border-red-500/40 bg-red-500/5" : "border-border bg-card"}`}
      data-testid={`gpu-dispatcher-card-${snap.index}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-card-foreground">
          GPU {snap.index}
        </h4>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${stateStyles[snap.state]}`}
          data-testid={`gpu-dispatcher-state-${snap.index}`}
        >
          {snap.state === "busy" && <Activity className="h-3 w-3" />}
          {snap.state === "error" && <Ban className="h-3 w-3" />}
          {snap.state}
        </span>
      </div>

      {snap.state === "busy" && snap.currentJob && (
        <p className="text-xs text-muted-foreground">
          Running <strong>{workloadLabels[snap.currentJob.workloadType]}</strong>{" "}
          job <code className="text-[10px]">{snap.currentJob.id.slice(0, 8)}</code>{" "}
          for {elapsed(snap.currentJob.startedAt, Date.now())}
        </p>
      )}

      {snap.state === "idle" && !snap.mutexBlockedBy && (
        <p className="text-xs text-muted-foreground">Available</p>
      )}

      {snap.mutexBlockedBy && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                className="text-xs text-amber-600 dark:text-amber-400 cursor-help underline decoration-dotted underline-offset-2"
                data-testid={`gpu-dispatcher-mutex-${snap.index}`}
              >
                {mutexLabel(snap.mutexBlockedBy)}
              </p>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs text-xs">
                Image generation and LLM inference share GPU {snap.index} —
                only one can run at a time. The waiting workload will start
                automatically once the active job completes.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {snap.state === "error" && snap.lastError && (
        <p
          className="text-xs text-red-600 dark:text-red-400"
          data-testid={`gpu-dispatcher-error-${snap.index}`}
        >
          {snap.lastError}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Queue depth: <strong>{snap.queueDepth}</strong>
        </span>
        <div className="flex items-center gap-2">
          {snap.state === "error" && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
              onClick={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
              data-testid={`gpu-dispatcher-retry-${snap.index}`}
            >
              {retryMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              Retry
            </button>
          )}
          {snap.state === "busy" && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/5 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
              onClick={handleCancel}
              disabled={cancelMutation.isPending}
              data-testid={`gpu-dispatcher-cancel-${snap.index}`}
            >
              {cancelMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Ban className="h-3 w-3" />
              )}
              Cancel
            </button>
          )}
        </div>
      </div>

      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel job on GPU {snap.index}?</DialogTitle>
            <DialogDescription>
              The running{" "}
              <strong>{snap.currentJob?.workloadType ?? "job"}</strong> job
              will be terminated. Any in-flight output will be discarded and
              the queue will advance to the next pending job.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setCancelDialogOpen(false)}
              className="rounded border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Keep running
            </button>
            <button
              type="button"
              data-testid={`gpu-dispatcher-cancel-confirm-${snap.index}`}
              onClick={() => {
                setCancelDialogOpen(false);
                cancelMutation.mutate();
              }}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
            >
              Cancel job
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export interface GpuDispatcherSectionProps {
  lanes?: DispatcherLaneSnapshot[];
}

export const GpuDispatcherSection = ({ lanes }: GpuDispatcherSectionProps) => {
  if (!lanes || lanes.length === 0) {
    return (
      <div
        className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground"
        data-testid="gpu-dispatcher-empty"
      >
        No dispatcher state available — the GPU dispatcher is not active on
        this host (no GPU detected, or running an older server build).
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border p-4">
      <h3 className="mb-3 text-sm font-semibold text-card-foreground">
        GPU Dispatcher
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Per-GPU job queue with mutual exclusion between LLM and image/video
        workloads. Each GPU runs at most one job at a time; mutex serializes
        LLM ↔ diffusion contention even across different physical GPUs (issue
        #1056).
      </p>
      <div
        className={`grid gap-3 ${lanes.length > 1 ? "sm:grid-cols-2" : ""}`}
      >
        {lanes.map((lane) => (
          <GpuDispatcherCard key={lane.index} initial={lane} />
        ))}
      </div>
    </div>
  );
};
