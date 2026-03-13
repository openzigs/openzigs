"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { X, Send, Clock, Loader2 } from "lucide-react";

// ── Types ───────────────────────────────────────────────────

type OutboxPlatform = "twitter" | "pinterest" | "linkedin" | "facebook" | "youtube" | "reddit" | "instagram";

interface AddToOutboxModalProps {
  open: boolean;
  onClose: () => void;
  /** Gallery asset ID */
  assetId: string;
  /** Asset filename for display */
  assetFilename: string;
  /** Asset type */
  assetType: "image" | "video" | "audio" | "document" | "text";
  /** Optional pre-filled prompt / description from the asset */
  defaultContext?: string;
}

const PLATFORMS: { value: OutboxPlatform; label: string }[] = [
  { value: "twitter", label: "𝕏 / Twitter" },
  { value: "pinterest", label: "Pinterest" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "facebook", label: "Facebook" },
  { value: "youtube", label: "YouTube" },
  { value: "reddit", label: "Reddit" },
  { value: "instagram", label: "Instagram" },
];

// ── Component ───────────────────────────────────────────────

export function AddToOutboxModal({
  open,
  onClose,
  assetId,
  assetFilename,
  assetType,
  defaultContext = "",
}: AddToOutboxModalProps) {
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState<OutboxPlatform>("twitter");
  const [scheduledTime, setScheduledTime] = useState(() => {
    // Default to 30 minutes from now, rounded to nearest 5 min
    const d = new Date(Date.now() + 30 * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d.toISOString().slice(0, 16); // datetime-local format
  });
  const [agentContext, setAgentContext] = useState(defaultContext);

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson("/api/admin/outbox", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      showToast(`Queued "${assetFilename}" for ${platform}`, "success");
      onClose();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentContext.trim()) return;

    mutation.mutate({
      asset_id: assetId,
      asset_type: assetType === "audio" ? "audio" : assetType === "video" ? "video" : "image",
      platform,
      scheduled_time: new Date(scheduledTime).toISOString(),
      agent_context: agentContext.trim(),
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative mx-4 w-full max-w-lg rounded-2xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-card-foreground">Add to Publishing Queue</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{assetFilename}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {/* Platform */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-card-foreground">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as OutboxPlatform)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* Scheduled Time */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-card-foreground">
              <Clock className="mr-1 inline h-3.5 w-3.5" />
              Scheduled Time
            </label>
            <input
              type="datetime-local"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>

          {/* Agent Context */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-card-foreground">
              Publishing Instructions
            </label>
            <textarea
              value={agentContext}
              onChange={(e) => setAgentContext(e.target.value)}
              placeholder="Describe how the AI agent should publish this content (e.g., caption, hashtags, target audience)..."
              rows={4}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The AI agent will use these instructions to craft and publish the post autonomously.
            </p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !agentContext.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Queue for Publishing
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
