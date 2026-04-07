"use client";

import { useState, useCallback } from "react";
import { Film, Loader2, Search, Sparkles, Clock, Brain } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { InlineModelPicker } from "@/components/model-picker-select";

interface BRollSuggestion {
  timestamp: number;
  duration: number;
  query: string;
  context: string;
  hasAsset: boolean;
}

interface BRollPanelProps {
  draftId: string;
  videoSource?: string;
}

type BRollDensity = "sparse" | "moderate" | "dense";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function BRollPanel({
  draftId: _draftId,
  videoSource,
}: BRollPanelProps) {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<BRollSuggestion[]>([]);
  const [density, setDensity] = useState<BRollDensity>("moderate");
  const [model, setModel] = useState("");
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  const handleAnalyze = useCallback(async () => {
    if (!videoSource) {
      showToast("No video source available", "error");
      return;
    }
    setLoading(true);
    setSuggestions([]);
    try {
      const res = await fetchJson<{
        jobId: string;
        status: string;
        suggestions?: BRollSuggestion[];
      }>("/api/studio/pipeline/broll", {
        method: "POST",
        body: JSON.stringify({
          source: videoSource,
          mode: "suggest",
          density,
          model: model || undefined,
        }),
      });

      if (res.suggestions) {
        setSuggestions(res.suggestions);
        showToast(`Found ${res.suggestions.length} B-Roll points`, "success");
      } else {
        const jobId = res.jobId;
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((r) => setTimeout(r, 3000));
          const poll = await fetchJson<{
            jobId: string;
            status: string;
            suggestions?: BRollSuggestion[];
          }>(`/api/studio/pipeline/broll/${jobId}`);

          if (poll.status === "complete" && poll.suggestions) {
            setSuggestions(poll.suggestions);
            showToast(
              `Found ${poll.suggestions.length} B-Roll points`,
              "success",
            );
            return;
          }
          if (poll.status === "failed") {
            showToast("B-Roll analysis failed", "error");
            return;
          }
        }
        showToast("B-Roll analysis timed out", "error");
      }
    } catch (err) {
      showToast(
        `Failed to analyze: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [videoSource, density, model]);

  const toggleAccepted = useCallback((index: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Film className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Auto B-Roll</h3>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">
          Density
          <select
            value={density}
            onChange={(e) => setDensity(e.target.value as BRollDensity)}
            className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="sparse">Sparse (every ~2 min)</option>
            <option value="moderate">Moderate (every ~1 min)</option>
            <option value="dense">Dense (every ~30s)</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Brain className="h-3 w-3" />
          AI Model
          <InlineModelPicker
            value={model}
            onChange={setModel}
            className="flex-1"
          />
        </label>
      </div>

      <button
        onClick={handleAnalyze}
        disabled={loading || !videoSource}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Analyzing...
          </>
        ) : (
          <>
            <Sparkles className="h-3.5 w-3.5" />
            Find B-Roll Points
          </>
        )}
      </button>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {suggestions.length} insertion points
            </p>
            <p className="text-xs text-muted-foreground">
              {accepted.size} accepted
            </p>
          </div>
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => toggleAccepted(i)}
              className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                accepted.has(i)
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Search className="h-3 w-3 text-muted-foreground" />
                    <span className="text-sm font-medium">{s.query}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {s.context}
                  </p>
                </div>
                <div className="ml-2 flex flex-col items-end gap-0.5">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {formatTime(s.timestamp)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.duration}s
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
