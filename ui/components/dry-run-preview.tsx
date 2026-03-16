"use client";

import { Clock, Sparkles, Wrench, Zap, FileText, CheckCircle2 } from "lucide-react";

export type DryRunData = {
  resolvedGoal?: string;
  variables?: Record<string, string>;
  skillName?: string | null;
  allowedTools?: string[];
  autoApproveTools?: string[];
  pipeline?: { stages: unknown[] } | null;
  nextRuns?: string[];
  cronExpression?: string;
  timezone?: string;
  actionType?: string;
  model?: string;
};

export function DryRunPreview({
  data,
  onExecute,
  onClose,
}: {
  data: DryRunData;
  onExecute?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-300/30 bg-amber-50/50 dark:bg-amber-900/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <FileText className="h-4 w-4 text-amber-500" />
          Dry Run Preview
        </h4>
        <button
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>

      {/* Next Runs */}
      {data.nextRuns && data.nextRuns.length > 0 && (
        <div className="flex items-start gap-2">
          <Clock className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" />
          <div>
            <p className="text-xs font-medium text-muted-foreground">Next runs</p>
            {data.nextRuns.map((r, i) => (
              <p key={i} className="text-xs text-foreground/80">
                {new Date(r).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Skill */}
      {data.skillName && (
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          <span className="text-xs text-foreground">
            <span className="font-medium">Skill:</span> {data.skillName}
          </span>
        </div>
      )}

      {/* Resolved Goal */}
      {data.resolvedGoal && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Resolved Prompt</p>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 px-3 py-2 font-mono text-xs text-foreground/80">
            {data.resolvedGoal}
          </pre>
        </div>
      )}

      {/* Variables */}
      {data.variables && Object.keys(data.variables).length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Variables</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(data.variables).map(([k, v]) => (
              <span key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                {k}=<span className="text-primary">{v}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tools */}
      {data.allowedTools && data.allowedTools.length > 0 && (
        <div className="flex items-start gap-2">
          <Wrench className="h-3.5 w-3.5 mt-0.5 text-sky-500" />
          <div>
            <p className="text-xs text-foreground">
              <span className="font-medium">{data.allowedTools.length} tools</span>
              {data.autoApproveTools && data.autoApproveTools.length > 0 && (
                <span className="text-muted-foreground">
                  {" "}({data.autoApproveTools.length} auto-approved)
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Pipeline */}
      {data.pipeline && data.pipeline.stages && data.pipeline.stages.length > 0 && (
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-emerald-500" />
          <span className="text-xs text-foreground">
            <span className="font-medium">Pipeline:</span> {data.pipeline.stages.length} stage{data.pipeline.stages.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {onExecute && (
          <button
            onClick={onExecute}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <CheckCircle2 className="h-3 w-3" />
            Execute Now
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted"
        >
          Close
        </button>
      </div>
    </div>
  );
}
