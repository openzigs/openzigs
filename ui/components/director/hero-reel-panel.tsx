"use client";

import { useState, useCallback } from "react";
import { Sparkles, Loader2, Play, CheckCircle2, XCircle } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

type HeroReelJobResponse = { produceJobId: string };
type HeroReelJobStatus = {
  status: "running" | "complete" | "failed";
  elapsedMs?: number;
  error?: string;
  manifest?: Record<string, unknown>;
};

export const HeroReelPanel = () => {
  const [overview, setOverview] = useState("");
  const [produceJobId, setProduceJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "generating" | "complete" | "failed">("idle");

  // Poll for job status
  const jobStatusQuery = useQuery({
    queryKey: ["hero-reel-job", produceJobId],
    queryFn: () =>
      fetchJson<HeroReelJobStatus>(`/api/admin/director/produce/${produceJobId}/status`),
    enabled: !!produceJobId && phase === "generating",
    refetchInterval: 2000,
  });

  // Transition on completion
  if (jobStatusQuery.data?.status === "complete" && phase === "generating") {
    setPhase("complete");
    showToast("Hero Reel storyboard generated!", "success");
  }
  if (jobStatusQuery.data?.status === "failed" && phase === "generating") {
    setPhase("failed");
    showToast(`Hero Reel failed: ${jobStatusQuery.data.error ?? "Unknown error"}`, "error");
  }

  const generateMutation = useMutation({
    mutationFn: () =>
      fetchJson<HeroReelJobResponse>("/api/admin/director/produce", {
        method: "POST",
        body: JSON.stringify({
          mode: "hero-reel",
          heroReelOverview: overview || "Create an energetic highlight reel",
          defaultClipDuration: 2,
          skipTTS: true,
        }),
      }),
    onSuccess: (data) => {
      setProduceJobId(data.produceJobId);
      setPhase("generating");
    },
    onError: (err) => {
      setPhase("failed");
      showToast(`Generation failed: ${(err as Error).message}`, "error");
    },
  });

  const handleGenerate = useCallback(() => {
    setPhase("generating");
    generateMutation.mutate();
  }, [generateMutation]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 overflow-y-auto">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className="h-5 w-5 text-amber-400" />
          <h2 className="text-xl font-semibold text-foreground">Hero Reel</h2>
        </div>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Generate a fast-paced, music-driven montage with automated captions.
          No source document needed — just describe the vibe and let the AI direct.
        </p>
      </div>

      {/* Presentation Overview & Tone */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          1. Presentation Overview &amp; Tone{" "}
          <span className="text-muted-foreground/50">(optional)</span>
        </label>
        <textarea
          value={overview}
          onChange={(e) => setOverview(e.target.value)}
          placeholder="e.g., create a fast-paced montage showcasing platform highlights. Tone: energetic and modern. Focus: dark-themed engineering presentations."
          rows={4}
          disabled={phase === "generating"}
          className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-50"
        />
        <p className="text-[11px] text-muted-foreground/60">
          Describe the overall feel, focus areas, and tone. The AI will autonomously
          generate 5-10 highlight scenes with captions and video-optimized prompts.
        </p>
      </div>

      {/* Pipeline info */}
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
        <p className="text-xs text-amber-400 font-medium mb-1">What happens next</p>
        <ul className="text-xs text-muted-foreground space-y-1">
          <li>&bull; The AI generates a montage storyboard of 5-10 fast-paced highlight scenes</li>
          <li>&bull; Each scene gets a 2-second video clip via the local video model</li>
          <li>&bull; Automated captions are generated for each scene</li>
          <li>&bull; Background music and crossfade transitions are applied</li>
          <li>&bull; No narrator script or TTS — the reel is purely visual</li>
        </ul>
      </div>

      {/* Generate / Status */}
      <div className="flex flex-col items-center gap-3">
        {phase === "idle" && (
          <button
            onClick={handleGenerate}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-8 py-3 text-sm font-semibold text-white shadow-lg hover:from-amber-600 hover:to-orange-600 transition-all"
          >
            <Play className="h-4 w-4" />
            Generate Hero Reel
          </button>
        )}

        {phase === "generating" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
            Generating Hero Reel storyboard…
          </div>
        )}

        {phase === "complete" && (
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Hero Reel storyboard generated successfully!
          </div>
        )}

        {phase === "failed" && (
          <div className="space-y-2 text-center">
            <div className="flex items-center justify-center gap-2 text-sm text-red-400">
              <XCircle className="h-4 w-4" />
              Generation failed
            </div>
            <button
              onClick={() => {
                setPhase("idle");
                setProduceJobId(null);
              }}
              className="text-xs text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
