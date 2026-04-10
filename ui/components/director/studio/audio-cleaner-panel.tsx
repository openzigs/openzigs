"use client";

import { useState, useCallback } from "react";
import {
  Mic,
  Loader2,
  Volume2,
  VolumeX,
  Sparkles,
  Sliders,
} from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

interface AudioCleanerPanelProps {
  draftId: string;
  audioSource?: string;
}

type Aggressiveness = "gentle" | "moderate" | "aggressive";

export function AudioCleanerPanel({
  draftId: _draftId,
  audioSource,
}: AudioCleanerPanelProps) {
  const [loading, setLoading] = useState(false);
  const [removeFiller, setRemoveFiller] = useState(true);
  const [trimSilence, setTrimSilence] = useState(true);
  const [aggressiveness, setAggressiveness] =
    useState<Aggressiveness>("moderate");
  const [enhanceSpeech, setEnhanceSpeech] = useState(false);
  const [deNoise, setDeNoise] = useState(false);
  const [result, setResult] = useState<{
    removedFillers: number;
    silenceTrimmed: number;
    durationSaved: string;
    outputPath: string;
  } | null>(null);

  const handleClean = useCallback(async () => {
    if (!audioSource) {
      showToast("No audio source available", "error");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetchJson<{
        jobId: string;
        status: string;
      }>("/api/studio/pipeline/clean-audio", {
        method: "POST",
        body: JSON.stringify({
          source: audioSource,
          removeFiller,
          trimSilence,
          aggressiveness,
          enhanceSpeech,
          deNoise,
        }),
      });

      const jobId = res.jobId;
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const poll = await fetchJson<{
          jobId: string;
          status: string;
          removedFillers?: number;
          trimmedSilenceRegions?: number;
          totalTimeSaved?: number;
          outputPath?: string;
        }>(`/api/studio/pipeline/clean-audio/${jobId}`);

        if (poll.status === "complete") {
          setResult({
            removedFillers: poll.removedFillers ?? 0,
            silenceTrimmed: poll.trimmedSilenceRegions ?? 0,
            durationSaved: `${(poll.totalTimeSaved ?? 0).toFixed(1)}s`,
            outputPath: poll.outputPath ?? "",
          });
          showToast("Audio cleaned successfully", "success");
          return;
        }
        if (poll.status === "failed") {
          showToast("Audio cleaning failed", "error");
          return;
        }
      }
      showToast("Audio cleaning timed out", "error");
    } catch (err) {
      showToast(
        `Failed to clean audio: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [
    audioSource,
    removeFiller,
    trimSilence,
    aggressiveness,
    enhanceSpeech,
    deNoise,
  ]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Mic className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Audio Cleaner</h3>
      </div>

      <div className="space-y-2">
        {/* Toggles */}
        <label className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5">
            <VolumeX className="h-3.5 w-3.5" />
            Remove filler words
          </span>
          <input
            type="checkbox"
            checked={removeFiller}
            onChange={(e) => setRemoveFiller(e.target.checked)}
            className="accent-primary"
          />
        </label>

        <label className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5">
            <Volume2 className="h-3.5 w-3.5" />
            Trim silence
          </span>
          <input
            type="checkbox"
            checked={trimSilence}
            onChange={(e) => setTrimSilence(e.target.checked)}
            className="accent-primary"
          />
        </label>

        <label className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Enhance speech
          </span>
          <input
            type="checkbox"
            checked={enhanceSpeech}
            onChange={(e) => setEnhanceSpeech(e.target.checked)}
            className="accent-primary"
          />
        </label>

        <label className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5">
            <Sliders className="h-3.5 w-3.5" />
            Noise reduction
          </span>
          <input
            type="checkbox"
            checked={deNoise}
            onChange={(e) => setDeNoise(e.target.checked)}
            className="accent-primary"
          />
        </label>

        {/* Aggressiveness */}
        <label className="text-xs text-muted-foreground">
          Aggressiveness
          <select
            value={aggressiveness}
            onChange={(e) =>
              setAggressiveness(e.target.value as Aggressiveness)
            }
            className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="gentle">Gentle (only um, uh, er)</option>
            <option value="moderate">
              Moderate (+ like, you know, I mean)
            </option>
            <option value="aggressive">
              Aggressive (+ basically, actually, sort of)
            </option>
          </select>
        </label>
      </div>

      <button
        onClick={handleClean}
        disabled={loading || !audioSource}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Cleaning...
          </>
        ) : (
          <>
            <Mic className="h-3.5 w-3.5" />
            Clean Audio
          </>
        )}
      </button>

      {result && (
        <div className="rounded-lg border border-border bg-green-500/5 p-2.5">
          <p className="text-sm font-medium text-green-600">Audio Cleaned</p>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <p>Removed {result.removedFillers} filler words</p>
            <p>Trimmed {result.silenceTrimmed} silence regions</p>
            <p>Saved {result.durationSaved}</p>
          </div>
        </div>
      )}
    </div>
  );
}
