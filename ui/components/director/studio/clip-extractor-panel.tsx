"use client";

import { useState, useCallback } from "react";
import {
  Scissors,
  Loader2,
  Sparkles,
  Clock,
  TrendingUp,
  Brain,
} from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { InlineModelPicker } from "@/components/model-picker-select";

interface ExtractedClip {
  startTime: number;
  endTime: number;
  viralityScore: number;
  title: string;
  description: string;
  hookDetected: boolean;
}

interface ClipExtractorPanelProps {
  draftId: string;
  videoSource?: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-500";
  if (score >= 60) return "text-yellow-500";
  return "text-muted-foreground";
}

export function ClipExtractorPanel({
  draftId: _draftId,
  videoSource,
}: ClipExtractorPanelProps) {
  const [clips, setClips] = useState<ExtractedClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [clipCount, setClipCount] = useState(5);
  const [style, setStyle] = useState<
    "react" | "highlight" | "summarize" | "teaser"
  >("highlight");
  const [minDuration, setMinDuration] = useState(15);
  const [maxDuration, setMaxDuration] = useState(90);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");

  const handleExtract = useCallback(async () => {
    if (!videoSource) {
      showToast("No video source available", "error");
      return;
    }
    setLoading(true);
    setClips([]);
    try {
      const res = await fetchJson<{
        jobId: string;
        status: string;
        clips?: ExtractedClip[];
        clipCount?: number;
      }>("/api/studio/pipeline/clip", {
        method: "POST",
        body: JSON.stringify({
          source: videoSource,
          clipCount,
          style,
          minDuration,
          maxDuration,
          prompt: prompt || undefined,
          mode: prompt ? "prompt" : "auto",
          model: model || undefined,
        }),
      });

      if (res.clips) {
        setClips(res.clips);
        showToast(`Found ${res.clips.length} clips`, "success");
      } else {
        const jobId = res.jobId;
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((r) => setTimeout(r, 3000));
          const poll = await fetchJson<{
            jobId: string;
            status: string;
            clips?: ExtractedClip[];
          }>(`/api/studio/pipeline/clip/${jobId}`);

          if (poll.status === "complete" && poll.clips) {
            setClips(poll.clips);
            showToast(`Found ${poll.clips.length} clips`, "success");
            return;
          }
          if (poll.status === "failed") {
            showToast("Clip extraction failed", "error");
            return;
          }
        }
        showToast("Clip extraction timed out", "error");
      }
    } catch (err) {
      showToast(
        `Failed to extract clips: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [videoSource, clipCount, style, minDuration, maxDuration, prompt, model]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Scissors className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">AI Clip Extraction</h3>
      </div>

      {/* Configuration */}
      <div className="space-y-2">
        <input
          type="text"
          placeholder="Describe what clips to extract (optional)..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted-foreground">
            Clips
            <input
              type="number"
              min={1}
              max={50}
              value={clipCount}
              onChange={(e) => setClipCount(Number(e.target.value))}
              className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Style
            <select
              value={style}
              onChange={(e) =>
                setStyle(
                  e.target.value as
                    | "react"
                    | "highlight"
                    | "summarize"
                    | "teaser",
                )
              }
              className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="highlight">Highlights</option>
              <option value="react">Reactions</option>
              <option value="summarize">Summary</option>
              <option value="teaser">Teaser</option>
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            Min Duration (s)
            <input
              type="number"
              min={5}
              max={300}
              value={minDuration}
              onChange={(e) => setMinDuration(Number(e.target.value))}
              className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Max Duration (s)
            <input
              type="number"
              min={10}
              max={600}
              value={maxDuration}
              onChange={(e) => setMaxDuration(Number(e.target.value))}
              className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
        </div>

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
        onClick={handleExtract}
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
            Extract Clips
          </>
        )}
      </button>

      {/* Results */}
      {clips.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Found {clips.length} clips
          </p>
          {clips
            .sort((a, b) => b.viralityScore - a.viralityScore)
            .map((clip, i) => (
              <div
                key={i}
                className="rounded-lg border border-border p-2.5 hover:bg-muted/50"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{clip.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {clip.description}
                    </p>
                  </div>
                  <div className="ml-2 flex items-center gap-1">
                    <TrendingUp
                      className={`h-3 w-3 ${scoreColor(clip.viralityScore)}`}
                    />
                    <span
                      className={`text-xs font-medium ${scoreColor(clip.viralityScore)}`}
                    >
                      {clip.viralityScore}
                    </span>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatTime(clip.startTime)} → {formatTime(clip.endTime)}
                  </span>
                  <span>{Math.round(clip.endTime - clip.startTime)}s</span>
                  {clip.hookDetected && (
                    <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-green-500">
                      Hook
                    </span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
