"use client";

import { useState, useEffect, useCallback } from "react";
import { History, Loader2, CheckCircle, XCircle, Clock, Download } from "lucide-react";
import { fetchJson } from "@/lib/api";

interface RenderRecord {
  id: string;
  jobId: string;
  quality: string;
  status: string;
  progress: number;
  outputPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  complete: <CheckCircle className="h-3.5 w-3.5 text-green-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
  queued: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RenderHistory({ draftId }: { draftId: string }) {
  const [renders, setRenders] = useState<RenderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ renders: RenderRecord[] }>(
        `/api/admin/director/drafts/${draftId}/renders`,
      );
      setRenders(res.renders);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Poll active renders
  useEffect(() => {
    if (!open) return;
    const hasActive = renders.some(
      (r) => r.status !== "complete" && r.status !== "failed" && r.status !== "aborted",
    );
    if (!hasActive) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [open, renders, load]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition"
        title="Render history"
      >
        <History className="h-3.5 w-3.5" />
        Renders
        {renders.length > 0 && (
          <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-bold text-primary">
            {renders.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">Render History</span>
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>

          {renders.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No renders yet. Click Render to create one.
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {renders.map((r) => (
                <div key={r.id} className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-0">
                  {STATUS_ICON[r.status] ?? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium capitalize text-foreground">{r.quality}</span>
                      <span className="text-[10px] text-muted-foreground">•</span>
                      <span className="text-[10px] capitalize text-muted-foreground">{r.status}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">{formatDate(r.createdAt)}</p>
                    {r.status !== "complete" && r.status !== "failed" && r.progress > 0 && (
                      <div className="mt-1 h-1 w-full rounded-full bg-muted">
                        <div
                          className="h-1 rounded-full bg-primary transition-all"
                          style={{ width: `${r.progress}%` }}
                        />
                      </div>
                    )}
                    {r.error && (
                      <p className="mt-0.5 text-[10px] text-destructive truncate">{r.error}</p>
                    )}
                  </div>
                  {r.status === "complete" && r.outputPath && (
                    <a
                      href={`/api/admin/director/renders/${r.jobId}/download`}
                      download
                      className="shrink-0 rounded p-1 text-muted-foreground hover:text-primary transition"
                      title="Download"
                    >
                      <Download className="h-3.5 w-3.5" />
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
