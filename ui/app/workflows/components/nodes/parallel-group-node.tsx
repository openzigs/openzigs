import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";

export type ParallelGroupData = {
  name: string;
  branchCount: number;
  executionStatus?: "pending" | "running" | "done" | "error";
};

function ParallelGroupNodeInner({ data, selected }: NodeProps) {
  const d = data as unknown as ParallelGroupData;

  return (
    <div
      className={`rounded-xl border-2 border-dashed bg-sky-500/5 px-5 py-4 shadow-md min-w-[200px] transition-all ${
        selected ? "border-sky-500 ring-2 ring-sky-500/30" : "border-sky-400/50"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-sky-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <GitBranch className="h-4 w-4 text-sky-500 shrink-0" />
        <span className="text-sm font-semibold text-card-foreground truncate">{d.name || "Parallel Group"}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {d.branchCount || 0} branch{(d.branchCount || 0) !== 1 ? "es" : ""}
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-sky-500 !w-3 !h-3" />
    </div>
  );
}

export const ParallelGroupNode = memo(ParallelGroupNodeInner);
