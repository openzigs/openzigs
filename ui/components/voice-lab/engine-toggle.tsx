/**
 * EngineToggle — Issue #272 (SI-4)
 *
 * Displays the active TTS engine and provides a one-click switch between
 * Engine A (Kokoro MLX) and Engine C (F5-TTS voice cloning).
 * Shows sidecar health and F5-TTS availability status.
 */

"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Cpu, RefreshCw, AlertCircle, CheckCircle2, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

type EngineStatus = {
  status: string;
  ready: boolean;
  tts_loaded: boolean;
  stt_loaded: boolean;
  tts_model: string;
  stt_model: string;
  voice_count: number;
  active_engine: "kokoro" | "f5tts";
  engines_available: string[];
  f5tts_loaded: boolean;
  f5tts_loading: boolean;
  f5tts_available: boolean;
};

type SwitchResult = {
  engine: string;
  status: "already_loaded" | "switched";
};

export function EngineToggle() {
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);

  const engineQuery = useQuery({
    queryKey: ["audio-engine-status"],
    queryFn: () => fetchJson<EngineStatus>("/api/admin/audio/engine/status"),
    refetchInterval: 15_000,
    retry: false,
  });

  const switchMutation = useMutation({
    mutationFn: (engine: "kokoro" | "f5tts") =>
      fetchJson<SwitchResult>("/api/admin/audio/engine/switch", {
        method: "POST",
        body: JSON.stringify({ engine }),
      }),
    onSuccess: (data) => {
      const labels: Record<string, string> = {
        kokoro: "Kokoro (Engine A)",
        f5tts: "F5-TTS (Engine C)",
      };
      const msg =
        data.status === "already_loaded"
          ? `Engine ${data.engine} is already active.`
          : `Switched to ${labels[data.engine] ?? data.engine}.`;
      showToast(msg, "success");
      void queryClient.invalidateQueries({ queryKey: ["audio-engine-status"] });
      setSwitching(false);
    },
    onError: (err: Error) => {
      showToast(err.message || "Engine switch failed.", "error");
      setSwitching(false);
    },
  });

  const status = engineQuery.data;
  const isLoading = engineQuery.isLoading;
  const isError = engineQuery.isError;

  const handleSwitch = (engine: "kokoro" | "f5tts") => {
    setSwitching(true);
    switchMutation.mutate(engine);
  };

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">TTS Engine</span>
        </div>
        <button
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => void engineQuery.refetch()}
          title="Refresh engine status"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", engineQuery.isFetching && "animate-spin")} />
        </button>
      </div>

      {/* Status area */}
      {isLoading && (
        <p className="text-sm text-muted-foreground animate-pulse">Connecting to audio sidecar…</p>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Audio sidecar unreachable. Start with: <code className="font-mono text-xs">python sidecars/audio/server.py</code></span>
        </div>
      )}

      {status && (
        <div className="space-y-3">
          {/* Engine selector buttons */}
          <div className="grid grid-cols-2 gap-2">
            {(["kokoro", "f5tts"] as const).map((engine) => {
              const isActive = status.active_engine === engine;
              const isKokoro = engine === "kokoro";
              const isF5TTS = engine === "f5tts";
              return (
                <button
                  key={engine}
                  onClick={() => !isActive && handleSwitch(engine)}
                  disabled={isActive || switching || (isF5TTS && !status.f5tts_available)}
                  className={cn(
                    "relative flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-all",
                    isActive
                      ? "border-primary/40 bg-primary/8 cursor-default"
                      : "border-border bg-card hover:border-primary/20 hover:bg-primary/4 cursor-pointer",
                    (switching && !isActive) && "opacity-50",
                    (isF5TTS && !status.f5tts_available) && "opacity-40 cursor-not-allowed",
                  )}
                >
                  {isActive && (
                    <span className="absolute right-2 top-2 flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  )}
                  {/* F5-TTS availability indicator */}
                  {isF5TTS && !isActive && status.f5tts_available && (
                    <span className="absolute right-2 top-2 flex h-1.5 w-1.5 rounded-full bg-emerald-400/60" title="f5-tts-mlx installed" />
                  )}
                  <span className="font-semibold text-foreground">
                    {isKokoro ? "Kokoro (A)" : "F5-TTS (C)"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isKokoro
                      ? `${status.voice_count} presets · MLX`
                      : status.f5tts_available
                        ? status.f5tts_loaded ? "Emotion cloning · loaded" : "Emotion cloning · MLX"
                        : "Not installed"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Model info */}
          <div className="space-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>TTS Model</span>
              <span className="font-mono text-foreground">{status.tts_model || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span>TTS Loaded</span>
              <span className={status.tts_loaded ? "text-emerald-500" : ""}>
                {status.tts_loaded ? "yes" : "lazy (loads on first use)"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>F5-TTS</span>
              <span className="flex items-center gap-1">
                {status.f5tts_available ? (
                  status.f5tts_loaded ? (
                    <><CheckCircle2 className="h-3 w-3 text-emerald-500" />loaded</>
                  ) : (
                    <><CheckCircle2 className="h-3 w-3 text-emerald-500/60" />installed (lazy)</>
                  )
                ) : (
                  <><AlertCircle className="h-3 w-3 text-amber-500" />not installed</>
                )}
              </span>
            </div>
          </div>

          {/* Sidecar ready indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Radio className={cn("h-3 w-3", status.ready ? "text-emerald-500" : "text-amber-500")} />
            Sidecar {status.ready ? "ready" : status.status}
          </div>
        </div>
      )}
    </div>
  );
}
