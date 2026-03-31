import type { DragEvent } from "react";
import { Cog, GitBranch, Zap, GitMerge } from "lucide-react";

const NODE_TYPES = [
  {
    type: "promptStage",
    label: "Prompt Stage",
    description: "An LLM prompt step with optional tools",
    icon: Cog,
    color: "text-emerald-500 bg-emerald-500/10",
  },
  {
    type: "parallelGroup",
    label: "Parallel Group",
    description: "Fan-out into parallel branches",
    icon: GitBranch,
    color: "text-sky-500 bg-sky-500/10",
  },
  {
    type: "postAction",
    label: "Post-Action",
    description: "Deterministic post-processing step",
    icon: Zap,
    color: "text-amber-500 bg-amber-500/10",
  },
  {
    type: "condition",
    label: "Condition",
    description: "Conditional branch (coming soon)",
    icon: GitMerge,
    color: "text-violet-500 bg-violet-500/10",
    disabled: true,
  },
] as { type: string; label: string; description: string; icon: typeof Cog; color: string; disabled?: boolean }[];

export function NodePalette() {
  const onDragStart = (event: DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-card/50 p-3 overflow-y-auto">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-3">
        Node Types
      </h3>
      <div className="space-y-2">
        {NODE_TYPES.map(({ type, label, description, icon: Icon, color, disabled }) => (
          <div
            key={type}
            draggable={!disabled}
            onDragStart={(e) => onDragStart(e, type)}
            className={`rounded-lg border border-border p-3 transition-all ${
              disabled
                ? "opacity-50 cursor-not-allowed"
                : "cursor-grab hover:border-primary/40 hover:shadow-sm active:cursor-grabbing"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`rounded-md p-1 ${color}`}>
                <Icon className="h-3.5 w-3.5" />
              </div>
              <span className="text-sm font-medium text-card-foreground">{label}</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-tight">{description}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
