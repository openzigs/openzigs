"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Bot, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubagentEntry } from "@/lib/hooks/use-subagent-events";

interface SubagentInlineViewProps {
  entries: SubagentEntry[];
  className?: string;
}

function StatusIcon({ status }: { status: SubagentEntry["status"] }) {
  switch (status) {
    case "running":
    case "tool-active":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    default:
      return <Bot className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function SubagentSection({ entry }: { entry: SubagentEntry }) {
  const [expanded, setExpanded] = useState(entry.status === "running" || entry.status === "tool-active");

  const isActive = entry.status === "running" || entry.status === "tool-active";
  const toggle = () => setExpanded((v) => !v);

  return (
    <div
      className={cn(
        "rounded-lg border text-xs",
        isActive ? "border-blue-500/30 bg-blue-500/5" : "border-border bg-muted/30"
      )}
      data-testid="subagent-section"
      role="region"
      aria-label={`Subagent: ${entry.agentName}`}
    >
      {/* Header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={toggle}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon status={entry.status} />
        <span className="font-medium text-foreground">{entry.agentName}</span>
        {entry.status === "tool-active" && (
          <span className="ml-auto text-blue-500">running tools…</span>
        )}
        {entry.status === "completed" && (
          <span className="ml-auto text-muted-foreground">done</span>
        )}
        {entry.status === "failed" && (
          <span className="ml-auto text-destructive">failed</span>
        )}
      </button>

      {/* Body */}
      {expanded && (
        <div className="border-t border-border/50 px-3 py-2 text-muted-foreground">
          {entry.summary && <p>{entry.summary}</p>}
          {entry.error && <p className="text-destructive">{entry.error}</p>}
          {isActive && !entry.summary && !entry.error && (
            <p className="italic">Working…</p>
          )}
          {entry.status === "completed" && !entry.summary && (
            <p className="italic">Completed with no summary.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders SDK-native subagent activity inline within the chat conversation.
 * Displays each active subagent as a collapsible section.
 */
export function SubagentInlineView({ entries, className }: SubagentInlineViewProps) {
  if (entries.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="subagent-inline-view">
      {entries.map((entry) => (
        <SubagentSection key={entry.agentName} entry={entry} />
      ))}
    </div>
  );
}
