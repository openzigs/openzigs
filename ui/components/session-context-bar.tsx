"use client";

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Copy, Check, Loader2, MessageSquare } from "lucide-react";
import type { SessionStatus } from "@/lib/types";

/* ── Context Gauge ── */

const CONTEXT_THRESHOLDS = [
  { max: 0.6, color: "bg-emerald-500", label: "Normal" },
  { max: 0.8, color: "bg-amber-500", label: "Context filling up" },
  { max: 0.95, color: "bg-orange-500", label: "Compaction will start soon" },
  { max: 1, color: "bg-destructive", label: "Context nearly full — may block" },
] as const;

const getThreshold = (usage: number) =>
  CONTEXT_THRESHOLDS.find((t) => usage <= t.max) ?? CONTEXT_THRESHOLDS[3];

export const ContextGauge = ({ usage }: { usage: number }) => {
  const threshold = getThreshold(usage);
  const pct = Math.round(usage * 100);

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 cursor-default">
            <span className="text-xs text-muted-foreground">Context:</span>
            <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  threshold.color,
                  usage > 0.8 && "animate-pulse"
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={cn("text-xs font-medium", usage > 0.8 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              {pct}%
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{threshold.label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

/* ── Session ID Chip ── */

export const SessionIdChip = ({ sessionId }: { sessionId: string }) => {
  const [copied, setCopied] = useState(false);
  const truncated = sessionId.length > 8 ? sessionId.slice(0, 8) + "…" : sessionId;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }, [sessionId]);

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            onClick={handleCopy}
            aria-label="Copy session ID"
          >
            {truncated}
            {copied ? (
              <Check className="h-3 w-3 text-emerald-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{copied ? "Copied!" : `Click to copy: ${sessionId}`}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

/* ── Compaction Spinner ── */

export const CompactionSpinner = ({ active }: { active: boolean }) => {
  if (!active) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="hidden sm:inline">Compacting</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Background compaction in progress — summarizing older context</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

/* ── Relative Time ── */

const relativeTime = (isoDate: string): string => {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

/* ── Session Context Bar ── */

export const SessionContextBar = ({
  status,
}: {
  status: SessionStatus | null;
}) => {
  if (!status) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-card/50 px-5 py-1.5 text-xs">
      {/* Session ID */}
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">Session:</span>
        <SessionIdChip sessionId={status.sessionId} />
      </div>

      {/* Separator */}
      <span className="hidden text-border sm:inline">│</span>

      {/* Context gauge */}
      <ContextGauge usage={status.contextUsage} />

      {/* Separator */}
      <span className="hidden text-border sm:inline">│</span>

      {/* Turn count */}
      <div className="flex items-center gap-1 text-muted-foreground">
        <MessageSquare className="h-3 w-3" />
        <span>{status.turnCount} turn{status.turnCount !== 1 ? "s" : ""}</span>
      </div>

      {/* Separator */}
      <span className="hidden text-border sm:inline">│</span>

      {/* Session age */}
      <span className="text-muted-foreground">{relativeTime(status.createdAt)}</span>

      {/* Compaction spinner */}
      <CompactionSpinner active={status.compactionActive} />
    </div>
  );
};
