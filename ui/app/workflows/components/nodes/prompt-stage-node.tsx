import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type PromptStageData = {
  name: string;
  prompt: string;
  tools: string[] | null;
  model: string | null;
  timeoutSeconds: number;
  executionStatus?: "pending" | "running" | "done" | "error";
};

function PromptStageNodeInner({ data, selected }: NodeProps) {
  const d = data as unknown as PromptStageData;
  const statusColor: Record<string, string> = {
    pending: "bg-muted-foreground/40",
    running: "bg-amber-500 animate-pulse",
    done: "bg-emerald-500",
    error: "bg-red-500",
  };

  return (
    <div
      className={`rounded-xl border-2 bg-card px-4 py-3 shadow-md min-w-[200px] max-w-[280px] transition-all ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-primary !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1.5">
        <div className={`h-2 w-2 rounded-full shrink-0 ${statusColor[d.executionStatus ?? "pending"] ?? "bg-emerald-500"}`} />
        <span className="text-sm font-semibold text-card-foreground truncate">{d.name || "New Stage"}</span>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 mb-1.5">
        {d.prompt || "No prompt set"}
      </p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {d.model && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            {d.model}
          </span>
        )}
        {d.tools && d.tools.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {d.tools.length} tool{d.tools.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-primary !w-3 !h-3" />
    </div>
  );
}

export const PromptStageNode = memo(PromptStageNodeInner);
