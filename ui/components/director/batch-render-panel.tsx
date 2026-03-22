"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Layers,
  Loader2,
  Play,
  CheckSquare,
  Square,
  XCircle,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { DraftSummary } from "./types";

interface BatchJob {
  draftId: string;
  jobId?: string;
  error?: string;
}

interface BatchResult {
  total: number;
  queued: number;
  failed: number;
  results: BatchJob[];
}

export function BatchRenderPanel() {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [lastBatch, setLastBatch] = useState<BatchResult | null>(null);

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

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === drafts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(drafts.map((d) => d.id)));
    }
  };

  const handleBatchRender = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      const res = await fetchJson<BatchResult>("/api/admin/director/render/batch", {
        method: "POST",
        body: JSON.stringify({ draftIds: Array.from(selected) }),
      });
      setLastBatch(res);
      setSelected(new Set());
      showToast(`Queued ${res.queued} render(s)`, "success");
    } catch {
      showToast("Batch render failed", "error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Layers className="h-4 w-4" />
          Batch Render
        </h3>
        {selected.size > 0 && (
          <button
            onClick={handleBatchRender}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Render Selected ({selected.size})
          </button>
        )}
      </div>

      {/* Select All */}
      {drafts.length > 0 && (
        <button
          onClick={toggleAll}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {selected.size === drafts.length ? (
            <CheckSquare className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
          {selected.size === drafts.length ? "Deselect All" : "Select All"}
        </button>
      )}

      {drafts.length === 0 ? (
        <div className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Layers className="h-6 w-6" />
          <p className="text-xs">No drafts available for rendering</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {drafts.map((d) => (
            <button
              key={d.id}
              onClick={() => toggleSelect(d.id)}
              className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition ${
                selected.has(d.id)
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card hover:border-primary/30"
              }`}
            >
              {selected.has(d.id) ? (
                <CheckSquare className="h-4 w-4 shrink-0 text-primary" />
              ) : (
                <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{d.title}</p>
                <p className="text-xs text-muted-foreground capitalize">{d.status}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Last Batch Results */}
      {lastBatch && (
        <div className="rounded-lg border border-border bg-card p-3 space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Last Batch Results</h4>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1 text-green-500">
              <CheckCircle2 className="h-3 w-3" />
              {lastBatch.queued} queued
            </span>
            {lastBatch.failed > 0 && (
              <span className="flex items-center gap-1 text-red-500">
                <XCircle className="h-3 w-3" />
                {lastBatch.failed} failed
              </span>
            )}
          </div>
          <div className="space-y-1">
            {lastBatch.results.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {r.jobId ? (
                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                ) : (
                  <AlertCircle className="h-3 w-3 text-red-500" />
                )}
                <span className="truncate text-muted-foreground">
                  {r.draftId.slice(0, 8)}… {r.error ? `— ${r.error}` : `→ ${r.jobId?.slice(0, 8)}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
