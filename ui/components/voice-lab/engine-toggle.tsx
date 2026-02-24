/**
 * EngineToggle — Issue #272 (SI-4)
 *
 * Displays the active TTS engine and provides a one-click switch between
 * Engine A (Kokoro MLX) and Engine B (GPT-SoVITS voice cloning).
 * Shows sidecar health and GPT-SoVITS reachability status.
 * Includes push-button install and start for GPT-SoVITS (Engine B).
 */

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, buildUrl } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Cpu, RefreshCw, AlertCircle, CheckCircle2, Radio, ChevronDown, ChevronUp, ExternalLink, Terminal, Download, Play, Loader2 } from "lucide-react";
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
  active_engine: "kokoro" | "sovits" | "f5tts";
  engines_available: string[];
  sovits_url: string;
  sovits_reachable: boolean;
  f5tts_loaded: boolean;
  f5tts_loading: boolean;
  f5tts_available: boolean;
};

type SwitchResult = {
  engine: string;
  status: "already_loaded" | "switched";
};

type SovitsInstallStatus = {
  installed: boolean;
  installing: boolean;
};

// ── SSE log streaming hook ───────────────────────────────────────────────────

function useSSEAction(url: string) {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<{ line: string; stream: string }[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    setRunning(true);
    setLines([]);
    setExitCode(null);

    const controller = new AbortController();
    abortRef.current = controller;

    fetch(buildUrl(url), {
      method: "POST",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const txt = await res.text();
          setLines([{ line: `Error: ${txt}`, stream: "stderr" }]);
          setRunning(false);
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buf = "";
        let currentEvent = "";

        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          const value = result.value;
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const parts = buf.split("\n");
          buf = parts.pop() ?? "";

          for (const part of parts) {
            if (part.startsWith("event: ")) {
              currentEvent = part.slice(7).trim();
            } else if (part.startsWith("data: ")) {
              try {
                const data = JSON.parse(part.slice(6));
                if (currentEvent === "done") {
                  setExitCode(data.code ?? 1);
                  setRunning(false);
                } else if (currentEvent === "ready") {
                  setExitCode(0);
                  setRunning(false);
                } else if (data.line) {
                  setLines((prev) => [...prev, { line: data.line, stream: data.stream }]);
                }
              } catch { /* skip invalid JSON */ }
              currentEvent = "";
            }
          }
        }
        setRunning(false);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLines((prev) => [...prev, { line: `Connection error: ${String(err)}`, stream: "stderr" }]);
        setRunning(false);
      });
  }, [url]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  return { running, lines, exitCode, start, cancel };
}

// ── LogOutput ─────────────────────────────────────────────────────────────────

function LogOutput({ lines }: { lines: { line: string; stream: string }[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines.length]);

  if (lines.length === 0) return null;
  return (
    <div
      ref={scrollRef}
      className="mt-2 max-h-48 overflow-y-auto rounded-md bg-black/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed"
    >
      {lines.map((l, i) => (
        <div key={i} className={l.stream === "stderr" ? "text-red-400" : l.stream === "system" ? "text-amber-400" : "text-zinc-300"}>
          {l.line}
        </div>
      ))}
    </div>
  );
}

export function EngineToggle() {
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  const engineQuery = useQuery({
    queryKey: ["audio-engine-status"],
    queryFn: () => fetchJson<EngineStatus>("/api/admin/audio/engine/status"),
    refetchInterval: 15_000,
    retry: false,
  });

  const installStatusQuery = useQuery({
    queryKey: ["sovits-install-status"],
    queryFn: () => fetchJson<SovitsInstallStatus>("/api/admin/audio/engine/sovits-install-status"),
    refetchInterval: 10_000,
    retry: false,
  });

  const installer = useSSEAction("/api/admin/audio/engine/install-sovits");
  const starter = useSSEAction("/api/admin/audio/engine/start-sovits");

  // Auto-refresh engine status + install status when installer/starter completes
  useEffect(() => {
    if (installer.exitCode === 0) {
      void queryClient.invalidateQueries({ queryKey: ["sovits-install-status"] });
    }
  }, [installer.exitCode, queryClient]);

  useEffect(() => {
    if (starter.exitCode === 0) {
      void queryClient.invalidateQueries({ queryKey: ["audio-engine-status"] });
    }
  }, [starter.exitCode, queryClient]);

  const switchMutation = useMutation({
    mutationFn: (engine: "kokoro" | "sovits" | "f5tts") =>
      fetchJson<SwitchResult>("/api/admin/audio/engine/switch", {
        method: "POST",
        body: JSON.stringify({ engine }),
      }),
    onSuccess: (data) => {
      const labels: Record<string, string> = {
        kokoro: "Kokoro (Engine A)",
        sovits: "GPT-SoVITS (Engine B)",
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

  const handleSwitch = (engine: "kokoro" | "sovits" | "f5tts") => {
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
          <div className="grid grid-cols-3 gap-2">
            {(["kokoro", "sovits", "f5tts"] as const).map((engine) => {
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
                  {/* Proactive unreachability indicator on Engine B when Engine A is active */}
                  {!isKokoro && !isF5TTS && !isActive && !status.sovits_reachable && (
                    <span className="absolute right-2 top-2 flex h-1.5 w-1.5 rounded-full bg-amber-400" title={`GPT-SoVITS not reachable at ${status.sovits_url}`} />
                  )}
                  {/* F5-TTS availability indicator */}
                  {isF5TTS && !isActive && status.f5tts_available && (
                    <span className="absolute right-2 top-2 flex h-1.5 w-1.5 rounded-full bg-emerald-400/60" title="f5-tts-mlx installed" />
                  )}
                  <span className="font-semibold text-foreground">
                    {isKokoro ? "Kokoro (A)" : isF5TTS ? "F5-TTS (C)" : "GPT-SoVITS (B)"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isKokoro
                      ? `${status.voice_count} presets · MLX`
                      : isF5TTS
                        ? status.f5tts_available
                          ? status.f5tts_loaded ? "Emotion cloning · loaded" : "Emotion cloning · MLX"
                          : "Not installed"
                        : status.sovits_reachable
                          ? "Voice cloning · ready"
                          : `Offline · ${status.sovits_url}`}
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

          {/* Engine B push-button setup — shown when GPT-SoVITS is not yet running */}
          {!status.sovits_reachable && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-950/10">
              <button
                onClick={() => setShowSetup((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-amber-400 hover:text-amber-300 transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Set up Engine B (GPT-SoVITS)
                </span>
                {showSetup ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>

              {showSetup && (
                <div className="border-t border-amber-500/10 px-3 pb-3 pt-2 space-y-3 text-xs text-muted-foreground">
                  <p>
                    GPT-SoVITS is a voice cloning engine that runs locally. Click below to
                    install and start it automatically.
                  </p>
                  <p className="text-[11px] text-muted-foreground/70">
                    Requirements: Python 3.9+, ~4 GB disk, ~8 GB RAM, Apple Silicon or CUDA GPU.
                  </p>

                  {/* Step 1: Install */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 font-medium text-foreground/80">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                        1
                      </span>
                      Install GPT-SoVITS
                    </div>
                    {installStatusQuery.data?.installed && !installer.running ? (
                      <div className="ml-5.5 flex items-center gap-1.5 text-emerald-500 text-[11px]">
                        <CheckCircle2 className="h-3 w-3" />
                        Installed
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          installer.start();
                        }}
                        disabled={installer.running}
                        className={cn(
                          "ml-5.5 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-all",
                          installer.running
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-300 cursor-wait"
                            : "border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300",
                        )}
                      >
                        {installer.running ? (
                          <><Loader2 className="h-3 w-3 animate-spin" />Installing… (this takes a few minutes)</>
                        ) : installer.exitCode === 0 ? (
                          <><CheckCircle2 className="h-3 w-3 text-emerald-500" />Installed</>
                        ) : (
                          <><Download className="h-3 w-3" />Install GPT-SoVITS (~4 GB)</>
                        )}
                      </button>
                    )}
                    <LogOutput lines={installer.lines} />
                  </div>

                  {/* Step 2: Start */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 font-medium text-foreground/80">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                        2
                      </span>
                      Start GPT-SoVITS server
                    </div>
                    <button
                      onClick={() => {
                        starter.start();
                      }}
                      disabled={starter.running || (!installStatusQuery.data?.installed && installer.exitCode !== 0)}
                      className={cn(
                        "ml-5.5 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-all",
                        starter.running
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 cursor-wait"
                          : (!installStatusQuery.data?.installed && installer.exitCode !== 0)
                            ? "border-border bg-muted/30 text-muted-foreground/40 cursor-not-allowed"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300",
                      )}
                    >
                      {starter.running ? (
                        <><Loader2 className="h-3 w-3 animate-spin" />Starting…</>
                      ) : starter.exitCode === 0 ? (
                        <><CheckCircle2 className="h-3 w-3 text-emerald-500" />Server ready</>
                      ) : (
                        <><Play className="h-3 w-3" />Start server</>
                      )}
                    </button>
                    <LogOutput lines={starter.lines} />
                    {starter.exitCode === 0 && (
                      <p className="ml-5.5 text-[11px] text-emerald-500/80">
                        Server is running! Click the GPT-SoVITS card above to switch.
                      </p>
                    )}
                  </div>

                  {/* Step 3: Switch */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 font-medium text-foreground/80">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                        3
                      </span>
                      Switch to Engine B
                    </div>
                    <p className="ml-5.5 text-[11px] text-muted-foreground/80">
                      Once the server is ready, click the GPT-SoVITS card above to activate Engine B.
                    </p>
                  </div>

                  <a
                    href="https://github.com/RVC-Boss/GPT-SoVITS"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    GPT-SoVITS on GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
