"use client";

import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Plus, Trash2, Wand2, GripVertical, Check, X } from "lucide-react";

export interface UserChapter {
  id?: string;
  title: string;
  description: string;
  start_seconds: number;
  end_seconds: number;
  order_index: number;
}

interface ClassifyResponse {
  chapters: UserChapter[];
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function parseTimeInput(val: string): number {
  const trimmed = val.trim();
  // Accept "m:ss" or plain seconds
  const colonMatch = /^(\d+):(\d{1,2})$/.exec(trimmed);
  if (colonMatch) {
    return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);
  }
  const num = parseFloat(trimmed);
  return Number.isFinite(num) ? num : 0;
}

export function ChapterEditor({
  presentationId,
  durationSeconds,
  initialChapters,
  onClose,
  onSaved,
}: {
  presentationId: string;
  durationSeconds: number;
  initialChapters: UserChapter[];
  onClose: () => void;
  onSaved: (chapters: UserChapter[]) => void;
}) {
  const queryClient = useQueryClient();
  const [chapters, setChapters] = useState<UserChapter[]>(() =>
    initialChapters.length > 0
      ? initialChapters
      : [
          {
            title: "",
            description: "",
            start_seconds: 0,
            end_seconds: durationSeconds,
            order_index: 0,
          },
        ]
  );
  const [editingIndex, setEditingIndex] = useState<number | null>(
    initialChapters.length === 0 ? 0 : null
  );

  const saveMutation = useMutation({
    mutationFn: (chs: UserChapter[]) =>
      fetchJson<{ chapters: UserChapter[] }>(
        `/api/presentations/${presentationId}/user-chapters`,
        { method: "PUT", body: JSON.stringify({ chapters: chs }) }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["presentation", presentationId] });
      onSaved(data.chapters);
      showToast("Chapters saved", "success");
    },
    onError: (err) => showToast(`Save failed: ${err.message}`, "error"),
  });

  const classifyMutation = useMutation({
    mutationFn: () =>
      fetchJson<ClassifyResponse>(
        `/api/presentations/${presentationId}/user-chapters/classify`,
        { method: "POST" }
      ),
    onSuccess: (data) => {
      setChapters(
        data.chapters.map((ch, i) => ({ ...ch, order_index: i }))
      );
      queryClient.invalidateQueries({ queryKey: ["presentation", presentationId] });
      onSaved(data.chapters);
      showToast("AI assigned time ranges to chapters", "success");
    },
    onError: (err) => showToast(`Classification failed: ${err.message}`, "error"),
  });

  const handleSave = useCallback(() => {
    const normalised = chapters.map((ch, i) => ({ ...ch, order_index: i }));
    saveMutation.mutate(normalised);
  }, [chapters, saveMutation]);

  const handleClassify = useCallback(async () => {
    // Save first so the server has the latest definitions, then classify
    const normalised = chapters.map((ch, i) => ({ ...ch, order_index: i }));
    try {
      await fetchJson(`/api/presentations/${presentationId}/user-chapters`, {
        method: "PUT",
        body: JSON.stringify({ chapters: normalised }),
      });
    } catch {
      // ignore — classify will fail with its own error if save failed
    }
    classifyMutation.mutate();
  }, [chapters, presentationId, classifyMutation]);

  const addChapter = () => {
    const last = chapters[chapters.length - 1];
    const newStart = last ? last.end_seconds : 0;
    const newCh: UserChapter = {
      title: "",
      description: "",
      start_seconds: newStart,
      end_seconds: durationSeconds,
      order_index: chapters.length,
    };
    setChapters((prev) => [...prev, newCh]);
    setEditingIndex(chapters.length);
  };

  const removeChapter = (i: number) => {
    setChapters((prev) => prev.filter((_, idx) => idx !== i));
    if (editingIndex === i) setEditingIndex(null);
  };

  const updateChapter = (i: number, patch: Partial<UserChapter>) => {
    setChapters((prev) =>
      prev.map((ch, idx) => (idx === i ? { ...ch, ...patch } : ch))
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Edit Chapters</h3>
        <button
          onClick={onClose}
          className="rounded-lg p-1 hover:bg-muted/50 text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Define chapters by title and description. Click{" "}
        <strong>AI Classify</strong> and the AI will read the transcript and
        assign time ranges automatically.
      </p>

      {/* Chapter rows */}
      <div className="space-y-2">
        {chapters.map((ch, i) => (
          <div
            key={i}
            className="rounded-xl border border-border bg-card overflow-hidden"
          >
            {/* Collapsed header */}
            <div className="flex items-center gap-2 px-3 py-2">
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              <button
                className="flex-1 text-left min-w-0"
                onClick={() =>
                  setEditingIndex(editingIndex === i ? null : i)
                }
              >
                <p className="truncate text-xs font-medium text-foreground">
                  {ch.title || (
                    <span className="italic text-muted-foreground">
                      Untitled chapter
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {formatTime(ch.start_seconds)} – {formatTime(ch.end_seconds)}
                </p>
              </button>
              <button
                onClick={() => removeChapter(i)}
                className="shrink-0 rounded-lg p-1 text-destructive/60 hover:bg-destructive/5 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Expanded editor */}
            {editingIndex === i && (
              <div className="border-t border-border px-3 pb-3 pt-2 space-y-2">
                <label className="block text-[11px] font-medium text-muted-foreground">
                  Title
                </label>
                <input
                  type="text"
                  value={ch.title}
                  onChange={(e) => updateChapter(i, { title: e.target.value })}
                  placeholder="e.g., Introduction"
                  className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                />

                <label className="block text-[11px] font-medium text-muted-foreground">
                  Description{" "}
                  <span className="font-normal text-muted-foreground/60">
                    (used by AI to classify transcript)
                  </span>
                </label>
                <textarea
                  value={ch.description}
                  onChange={(e) => updateChapter(i, { description: e.target.value })}
                  placeholder="Describe what this chapter covers…"
                  rows={2}
                  className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground resize-none"
                />

                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                      Start (m:ss)
                    </label>
                    <input
                      type="text"
                      defaultValue={formatTime(ch.start_seconds)}
                      onBlur={(e) =>
                        updateChapter(i, {
                          start_seconds: parseTimeInput(e.target.value),
                        })
                      }
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                      End (m:ss)
                    </label>
                    <input
                      type="text"
                      defaultValue={formatTime(ch.end_seconds)}
                      onBlur={(e) =>
                        updateChapter(i, {
                          end_seconds: parseTimeInput(e.target.value),
                        })
                      }
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                    />
                  </div>
                </div>

                <button
                  onClick={() => setEditingIndex(null)}
                  className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-[11px] font-semibold text-primary hover:bg-primary/20"
                >
                  <Check className="h-3 w-3" />
                  Done
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add chapter */}
      <button
        onClick={addChapter}
        className="flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        Add chapter
      </button>

      {/* Actions */}
      <div className="flex flex-col gap-2 pt-1">
        <button
          onClick={() => void handleClassify()}
          disabled={classifyMutation.isPending || chapters.length === 0}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          <Wand2 className="h-3.5 w-3.5" />
          {classifyMutation.isPending ? "Classifying…" : "AI Classify Transcript"}
        </button>

        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="flex-1 rounded-xl border border-primary px-3 py-2 text-xs font-semibold text-primary disabled:opacity-40 hover:bg-primary/5"
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onClose}
            className="rounded-xl border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/50"
          >
            Cancel
          </button>
        </div>

        {/* Clear user chapters — revert to auto-detect */}
        {initialChapters.length > 0 && (
          <button
            onClick={() => {
              saveMutation.mutate([]);
              onSaved([]);
            }}
            className="text-[10px] text-destructive/70 hover:text-destructive underline underline-offset-2 text-center"
          >
            Clear user chapters (revert to auto-detect)
          </button>
        )}
      </div>
    </div>
  );
}
