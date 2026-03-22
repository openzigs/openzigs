"use client";

import { useState, useEffect, useCallback } from "react";
import { Youtube, Loader2, CheckCircle, XCircle, Clock, ExternalLink } from "lucide-react";
import { fetchJson } from "@/lib/api";

interface PublishRecord {
  id: string;
  draftId: string;
  videoId: string | null;
  videoUrl: string | null;
  title: string;
  privacyStatus: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  published: <CheckCircle className="h-3.5 w-3.5 text-green-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
  uploading: <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />,
};

const STATUS_LABEL: Record<string, string> = {
  published: "Published",
  failed: "Failed",
  uploading: "Uploading",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function YouTubePublishHistory({ draftId }: { draftId: string }) {
  const [publishes, setPublishes] = useState<PublishRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ publishes: PublishRecord[] }>(
        `/api/admin/director/youtube/publish/${draftId}/history`,
      );
      setPublishes(res.publishes);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Poll while uploading
  useEffect(() => {
    if (!open) return;
    const hasActive = publishes.some((p) => p.status === "uploading");
    if (!hasActive) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [open, publishes, load]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition"
        title="YouTube publish history"
      >
        <Youtube className="h-3.5 w-3.5 text-red-500" />
        Publishes
        {publishes.length > 0 && (
          <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-600">
            {publishes.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">YouTube Publishes</span>
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>

          {publishes.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No publishes yet.
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {publishes.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-0"
                >
                  {STATUS_ICON[p.status] ?? <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{p.title}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {STATUS_LABEL[p.status] ?? p.status} · {p.privacyStatus} · {formatDate(p.createdAt)}
                    </p>
                    {p.errorMessage && (
                      <p className="mt-0.5 truncate text-[10px] text-destructive">{p.errorMessage}</p>
                    )}
                  </div>
                  {p.videoUrl && (
                    <a
                      href={p.videoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground transition"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
