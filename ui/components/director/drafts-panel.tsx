"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, Trash2, Loader2, FileVideo, Clock } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { DraftSummary } from "./types";

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const MODE_LABELS: Record<string, string> = {
  highlight: "Highlight Reel",
  "script-driven": "Script-Driven",
  presentation: "Presentation",
  standard: "Standard",
  shorts: "Shorts",
  "blog-to-video": "Blog to Video",
};

export function DraftsPanel() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchJson<{ drafts: DraftSummary[] }>("/api/admin/director/drafts");
      setDrafts(res.drafts);
    } catch {
      showToast("Failed to load drafts", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleting(id);
    try {
      await fetchJson(`/api/admin/director/drafts/${id}`, { method: "DELETE" });
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      showToast("Draft deleted", "success");
    } catch {
      showToast("Failed to delete draft", "error");
    } finally {
      setDeleting(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (drafts.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileVideo className="h-8 w-8" />
        <p className="text-sm">No saved drafts yet</p>
        <p className="text-xs">Create a video from the Video Wizard or Blog to YouTube tab, then open it in Studio to save changes.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {drafts.map((d) => (
        <div
          key={d.id}
          role="button"
          tabIndex={0}
          onClick={() => router.push(`/director/studio/${d.id}`)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") router.push(`/director/studio/${d.id}`); }}
          className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition hover:border-primary/50 hover:bg-muted/50"
        >
          {/* Thumbnail or placeholder */}
          <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md bg-muted">
            {d.thumbnail ? (
              <img src={d.thumbnail} alt="" className="h-full w-full rounded-md object-cover" />
            ) : (
              <Clapperboard className="h-5 w-5 text-muted-foreground" />
            )}
          </div>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{d.title}</p>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                {MODE_LABELS[d.productionMode] ?? d.productionMode}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize">
                {d.status}
              </span>
              <span className="inline-flex items-center gap-0.5">
                <Clock className="h-3 w-3" />
                {formatRelative(d.updatedAt)}
              </span>
            </div>
          </div>

          {/* Delete */}
          <button
            onClick={(e) => handleDelete(d.id, e)}
            disabled={deleting === d.id}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 disabled:opacity-50"
            title="Delete draft"
          >
            {deleting === d.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
