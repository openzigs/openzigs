import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";

export type PostActionData = {
  name: string;
  actionType: string;
  config: Record<string, unknown>;
  executionStatus?: "pending" | "running" | "done" | "error";
};

function PostActionNodeInner({ data, selected }: NodeProps) {
  const d = data as unknown as PostActionData;

  return (
    <div
      className={`rounded-xl border-2 border-dashed bg-amber-500/5 px-4 py-3 shadow-md min-w-[180px] transition-all ${
        selected ? "border-amber-500 ring-2 ring-amber-500/30" : "border-amber-400/50"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-amber-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <Zap className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        <span className="text-sm font-semibold text-card-foreground truncate">{d.name || "Post-Action"}</span>
      </div>
      {d.actionType && (
        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
          {d.actionType}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500 !w-3 !h-3" />
    </div>
  );
}

export const PostActionNode = memo(PostActionNodeInner);
