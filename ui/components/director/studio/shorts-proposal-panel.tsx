"use client";

import { useState, useCallback } from "react";
import {
  Scissors,
  Loader2,
  ThumbsUp,
  ThumbsDown,
  Play,
  Sparkles,
  Clock,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

interface ShortProposal {
  startTime: number;
  endTime: number;
  title: string;
  hookText: string;
  ctaText: string;
  score: number;
  reason: string;
}

interface ShortsProposalPanelProps {
  draftId: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ShortsProposalPanel({ draftId }: ShortsProposalPanelProps) {
  const [proposals, setProposals] = useState<ShortProposal[]>([]);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<ShortProposal | null>(null);
  const [maxShorts, setMaxShorts] = useState(3);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    setProposals([]);
    setAccepted(new Set());
    try {
      const res = await fetchJson<{ proposals: ShortProposal[] }>(
        `/api/admin/director/drafts/${draftId}/shorts/propose`,
        { method: "POST", body: JSON.stringify({ maxShorts }) },
      );
      setProposals(res.proposals);
      // Auto-accept all initially
      setAccepted(new Set(res.proposals.map((_, i) => i)));
    } catch {
      showToast("Failed to generate Short proposals", "error");
    } finally {
      setLoading(false);
    }
  }, [draftId, maxShorts]);

  const toggleAccept = (idx: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditForm({ ...proposals[idx] });
  };

  const saveEdit = () => {
    if (editingIdx === null || !editForm) return;
    setProposals((prev) => prev.map((p, i) => (i === editingIdx ? editForm : p)));
    setEditingIdx(null);
    setEditForm(null);
  };

  const handleRender = async () => {
    const segments = proposals
      .filter((_, i) => accepted.has(i))
      .map((p) => ({
        startTime: p.startTime,
        endTime: p.endTime,
        title: p.title,
        hookText: p.hookText,
        ctaText: p.ctaText,
        burnSubtitles: true,
      }));

    if (segments.length === 0) {
      showToast("Select at least one Short to render", "error");
      return;
    }

    setRendering(true);
    try {
      const res = await fetchJson<{ jobIds: string[] }>(
        `/api/admin/director/drafts/${draftId}/shorts/render`,
        { method: "POST", body: JSON.stringify({ segments }) },
      );
      showToast(`Queued ${res.jobIds.length} Short(s) for rendering`, "success");
    } catch {
      showToast("Failed to queue Short renders", "error");
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Scissors className="h-4 w-4" />
          Shorts Generator
        </h3>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Max Shorts:</label>
          <select
            value={maxShorts}
            onChange={(e) => setMaxShorts(Number(e.target.value))}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            {[1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {loading ? "Analyzing…" : "Generate Proposals"}
        </button>
      </div>

      {/* Proposals */}
      {proposals.length > 0 && (
        <div className="space-y-3">
          {proposals.map((p, idx) => (
            <div
              key={idx}
              className={`rounded-lg border p-3 transition ${
                accepted.has(idx) ? "border-green-500/40 bg-green-500/5" : "border-border bg-card opacity-60"
              }`}
            >
              {editingIdx === idx && editForm ? (
                /* Edit Mode */
                <div className="space-y-2">
                  <input
                    type="text"
                    value={editForm.title}
                    onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                    placeholder="Title"
                  />
                  <input
                    type="text"
                    value={editForm.hookText}
                    onChange={(e) => setEditForm({ ...editForm, hookText: e.target.value })}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                    placeholder="Hook text"
                  />
                  <input
                    type="text"
                    value={editForm.ctaText}
                    onChange={(e) => setEditForm({ ...editForm, ctaText: e.target.value })}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                    placeholder="CTA text"
                  />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground">
                      <Check className="h-3 w-3" /> Save
                    </button>
                    <button onClick={() => { setEditingIdx(null); setEditForm(null); }} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
                      <X className="h-3 w-3" /> Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* View Mode */
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{p.title}</p>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatTime(p.startTime)} – {formatTime(p.endTime)}
                          <span className="opacity-60">({Math.round(p.endTime - p.startTime)}s)</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Sparkles className="h-3 w-3" />
                          Score: {p.score}/100
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => startEdit(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => toggleAccept(idx)}
                        className={`rounded p-1 ${
                          accepted.has(idx) ? "text-green-500 hover:text-red-500" : "text-muted-foreground hover:text-green-500"
                        }`}
                        title={accepted.has(idx) ? "Reject" : "Accept"}
                      >
                        {accepted.has(idx) ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                  {p.hookText && (
                    <p className="mt-1 text-xs text-muted-foreground">Hook: &ldquo;{p.hookText}&rdquo;</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground/70 italic">{p.reason}</p>
                </>
              )}
            </div>
          ))}

          {/* Render button */}
          <button
            onClick={handleRender}
            disabled={rendering || accepted.size === 0}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {rendering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Render {accepted.size} Short{accepted.size !== 1 ? "s" : ""}
          </button>
        </div>
      )}

      {!loading && proposals.length === 0 && (
        <div className="flex h-24 flex-col items-center justify-center gap-1.5 text-muted-foreground">
          <Scissors className="h-6 w-6" />
          <p className="text-xs">Click &ldquo;Generate Proposals&rdquo; to analyze your video for Shorts</p>
        </div>
      )}
    </div>
  );
}
