"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { X, Save, Loader2 } from "lucide-react";

// ── Types ───────────────────────────────────────────────────

interface OutboxAttachment {
  filePath: string;
  filename: string;
  assetType?: string;
}

interface OutboxItem {
  id: string;
  title: string | null;
  contentBody: string | null;
  agentContext: string;
  scheduledTime: string;
  assetUrl: string | null;
  platform: string;
  attachments: OutboxAttachment[];
  platformMetadata: Record<string, unknown>;
}

interface Props {
  open: boolean;
  item: OutboxItem | null;
  onClose: () => void;
}

// ── Component ───────────────────────────────────────────────

export function EditOutboxModal({ open, item, onClose }: Props) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [contentBody, setContentBody] = useState("");
  const [agentContext, setAgentContext] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");

  // Sync form state when item changes
  useEffect(() => {
    if (item) {
      setTitle(item.title ?? "");
      setContentBody(item.contentBody ?? "");
      setAgentContext(item.agentContext);
      // Convert ISO to datetime-local format
      const dt = new Date(item.scheduledTime);
      const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
      setScheduledTime(local);
    }
  }, [item]);

  const updateMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson(`/api/admin/outbox/${item?.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      showToast("Item updated", "success");
      onClose();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  function handleSave() {
    if (!item) return;
    const payload: Record<string, unknown> = {};

    if (title !== (item.title ?? "")) payload.title = title || null;
    if (contentBody !== (item.contentBody ?? "")) payload.content_body = contentBody || null;
    if (agentContext !== item.agentContext) payload.agent_context = agentContext;

    const newScheduled = new Date(scheduledTime).toISOString();
    if (newScheduled !== item.scheduledTime) payload.scheduled_time = newScheduled;

    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    updateMutation.mutate(payload);
  }

  if (!open || !item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-card-foreground">Edit Outbox Item</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Optional title"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Content</label>
            <textarea
              value={contentBody}
              onChange={(e) => setContentBody(e.target.value)}
              rows={4}
              placeholder="Post content"
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Agent Context</label>
            <textarea
              value={agentContext}
              onChange={(e) => setAgentContext(e.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Scheduled Time</label>
            <input
              type="datetime-local"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={updateMutation.isPending || !agentContext.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {updateMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
