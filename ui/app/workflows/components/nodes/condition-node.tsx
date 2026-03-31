import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitMerge } from "lucide-react";

export type ConditionData = {
  name: string;
  expression: string;
  comingSoon: boolean;
};

function ConditionNodeInner({ data, selected }: NodeProps) {
  const d = data as unknown as ConditionData;

  return (
    <div
      className={`rounded-xl border-2 border-dashed bg-violet-500/5 px-4 py-3 shadow-md min-w-[180px] transition-all relative ${
        selected ? "border-violet-500 ring-2 ring-violet-500/30" : "border-violet-400/50"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-violet-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <GitMerge className="h-3.5 w-3.5 text-violet-500 shrink-0" />
        <span className="text-sm font-semibold text-card-foreground truncate">{d.name || "Condition"}</span>
      </div>
      <span className="absolute -top-2 -right-2 rounded-full bg-violet-500 px-2 py-0.5 text-[9px] font-bold text-white shadow-sm">
        Coming Soon
      </span>
      <p className="text-xs text-muted-foreground italic">Conditional branching</p>
      <Handle type="source" position={Position.Bottom} className="!bg-violet-500 !w-3 !h-3" />
    </div>
  );
}

export const ConditionNode = memo(ConditionNodeInner);
