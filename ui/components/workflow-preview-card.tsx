"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Check, Pencil, Play, Clock, Tag, Zap, FileText, Webhook } from "lucide-react";
import type { WorkflowPreview } from "@/lib/types";

const TYPE_META: Record<
  WorkflowPreview["type"],
  { label: string; icon: typeof Zap; color: string }
> = {
  prompt: { label: "Prompt", icon: FileText, color: "text-primary" },
  "scheduled-job": { label: "Scheduled Job", icon: Clock, color: "text-moss" },
  webhook: { label: "Webhook", icon: Webhook, color: "text-amber-500" },
  agent: { label: "Agent", icon: Zap, color: "text-purple-500" },
};

/** Renders a key–value row in the config preview. */
const ConfigRow = ({ label, value }: { label: string; value: unknown }) => {
  const display =
    value === null || value === undefined
      ? "—"
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);

  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-28 shrink-0 font-medium text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground break-all">{display}</span>
    </div>
  );
};

export const WorkflowPreviewCard = ({
  preview,
  onConfirm,
  onEdit,
  onTestRun,
}: {
  preview: WorkflowPreview;
  onConfirm: () => void;
  onEdit: () => void;
  onTestRun?: () => void;
}) => {
  const meta = TYPE_META[preview.type] ?? TYPE_META.prompt;
  const Icon = meta.icon;

  return (
    <div className="max-w-md space-y-3 rounded-2xl border border-primary/20 bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", meta.color)} />
        <span className={cn("text-[10px] font-semibold uppercase tracking-wider", meta.color)}>
          {meta.label}
        </span>
        <Tag className="ml-auto h-3 w-3 text-muted-foreground" />
      </div>

      {/* Name & summary */}
      <div>
        <p className="text-sm font-semibold text-foreground">{preview.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{preview.summary}</p>
      </div>

      {/* Config key/values */}
      {Object.keys(preview.config).length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border bg-muted/50 p-3">
          {Object.entries(preview.config).map(([key, val]) => (
            <ConfigRow key={key} label={key} value={val} />
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 gap-1.5 px-3 text-xs"
          onClick={onConfirm}
        >
          <Check className="h-3 w-3" />
          Confirm
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-3 text-xs"
          onClick={onEdit}
        >
          <Pencil className="h-3 w-3" />
          Edit
        </Button>
        {onTestRun && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-amber-400/30 px-3 text-xs text-amber-500 hover:bg-amber-500/5"
            onClick={onTestRun}
          >
            <Play className="h-3 w-3" />
            Test Run
          </Button>
        )}
      </div>
    </div>
  );
};
