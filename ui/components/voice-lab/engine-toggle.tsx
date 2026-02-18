/**
 * EngineToggle — Issue #272 (SI-4)
 *
 * Displays the active TTS engine and provides a one-click switch between
 * Engine A (Kokoro MLX) and Engine B (GPT-SoVITS voice cloning).
 * Shows sidecar health and GPT-SoVITS reachability status.
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
  active_engine: "kokoro" | "sovits";
  engines_available: string[];
  sovits_url: string;
  sovits_reachable: boolean;
};

type SwitchResult = {
  engine: string;
  status: "already_loaded" | "switched";
};

// ── EngineToggle Component ───────────────────────────────────────────────────

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
    mutationFn: (engine: "kokoro" | "sovits") =>
      fetchJson<SwitchResult>("/api/admin/audio/engine/switch", {
        method: "POST",
        body: JSON.stringify({ engine }),
      }),
    onSuccess: (data) => {
      const msg =
        data.status === "already_loaded"
          ? `Engine ${data.engine} is already active.`
          : `Switched to ${data.engine === "kokoro" ? "Kokoro (Engine A)" : "GPT-SoVITS (Engine B)"}.`;
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

  const handleSwitch = (engine: "kokoro" | "sovits") => {
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
            {(["kokoro", "sovits"] as const).map((engine) => {
              const isActive = status.active_engine === engine;
              const isKokoro = engine === "kokoro";
              return (
                <button
                  key={engine}
                  onClick={() => !isActive && handleSwitch(engine)}
                  disabled={isActive || switching}
                  className={cn(
                    "relative flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-all",
                    isActive
                      ? "border-primary/40 bg-primary/8 cursor-default"
                      : "border-border bg-card hover:border-primary/20 hover:bg-primary/4 cursor-pointer",
                    (switching && !isActive) && "opacity-50",
                  )}
                >
                  {isActive && (
                    <span className="absolute right-2 top-2 flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  )}
                  {/* Proactive unreachability indicator on Engine B when Engine A is active */}
                  {!isKokoro && !isActive && !status.sovits_reachable && (
                    <span className="absolute right-2 top-2 flex h-1.5 w-1.5 rounded-full bg-amber-400" title={`GPT-SoVITS not reachable at ${status.sovits_url}`} />
                  )}
                  <span className="font-semibold text-foreground">
                    {isKokoro ? "Kokoro (Engine A)" : "GPT-SoVITS (Engine B)"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isKokoro
                      ? `${status.voice_count} voice presets · MLX`
                      : status.sovits_reachable
                        ? "Voice cloning · ready"
                        : `Offline · start GPT-SoVITS on ${status.sovits_url}`}
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
            {/* Always show GPT-SoVITS reachability so users know what to start */}
            <div className="flex justify-between">
              <span>GPT-SoVITS</span>
              <span className="flex items-center gap-1">
                {status.sovits_reachable ? (
                  <><CheckCircle2 className="h-3 w-3 text-emerald-500" />reachable</>
                ) : (
                  <><AlertCircle className="h-3 w-3 text-amber-500" />offline · {status.sovits_url}</>
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
