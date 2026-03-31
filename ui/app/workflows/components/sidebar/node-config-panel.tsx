import type { Node } from "@xyflow/react";
import { Trash2 } from "lucide-react";

interface NodeConfigPanelProps {
  selectedNode: Node | null;
  onDataChange: (nodeId: string, data: Record<string, unknown>) => void;
  onDelete: () => void;
}

export function NodeConfigPanel({ selectedNode, onDataChange, onDelete }: NodeConfigPanelProps) {
  if (!selectedNode) {
    return (
      <aside className="w-64 shrink-0 border-l border-border bg-card/50 p-4 flex items-center justify-center">
        <p className="text-sm text-muted-foreground text-center">Select a node to configure</p>
      </aside>
    );
  }

  const update = (key: string, value: unknown) => {
    onDataChange(selectedNode.id, { [key]: value });
  };

  return (
    <aside className="w-64 shrink-0 border-l border-border bg-card/50 p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
          Properties
        </h3>
        <button
          onClick={onDelete}
          className="rounded-md p-1 text-red-500 hover:bg-red-500/10 transition-colors"
          title="Delete node"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        {/* Name field — all node types */}
        <Field label="Name">
          <input
            type="text"
            value={String(selectedNode.data.name ?? "")}
            onChange={(e) => update("name", e.target.value)}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </Field>

        {/* Prompt Stage fields */}
        {selectedNode.type === "promptStage" && (
          <>
            <Field label="Prompt">
              <textarea
                rows={4}
                value={String(selectedNode.data.prompt ?? "")}
                onChange={(e) => update("prompt", e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Enter the prompt for this stage..."
              />
            </Field>
            <Field label="Model (optional)">
              <input
                type="text"
                value={String(selectedNode.data.model ?? "")}
                onChange={(e) => update("model", e.target.value || null)}
                placeholder="e.g. gpt-4o"
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </Field>
            <Field label="Timeout (seconds)">
              <input
                type="number"
                min={0}
                value={Number(selectedNode.data.timeoutSeconds ?? 300)}
                onChange={(e) => update("timeoutSeconds", parseInt(e.target.value, 10) || 300)}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </Field>
          </>
        )}

        {/* Post-action fields */}
        {selectedNode.type === "postAction" && (
          <Field label="Action Type">
            <select
              value={String(selectedNode.data.actionType ?? "")}
              onChange={(e) => update("actionType", e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">Select action…</option>
              <option value="save-to-file">Save to File</option>
              <option value="send-notification">Send Notification</option>
              <option value="webhook">Webhook</option>
              <option value="transform">Transform</option>
            </select>
          </Field>
        )}

        {/* Node metadata */}
        <div className="border-t border-border pt-3 mt-3">
          <p className="text-[11px] text-muted-foreground">
            Type: <span className="font-medium text-foreground">{selectedNode.type}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            ID: <span className="font-mono text-foreground">{selectedNode.id.slice(0, 12)}…</span>
          </p>
        </div>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );
}
