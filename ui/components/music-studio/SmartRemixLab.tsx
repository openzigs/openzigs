"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { buildMediaUrl } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { showToast } from "@/components/toast";
import type WaveSurfer from "wavesurfer.js";
import { WaveformTrack } from "./WaveformTrack";
import {
  Wand2,
  Volume2,
  VolumeX,
  Play,
  Pause,
  SkipBack,
  Loader2,
  Upload,
  Music,
  Drum,
  Guitar,
  Piano,
  Download,
  Save,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────

interface AnalysisResult {
  stems: Record<string, string>;
  bpm: number;
  key: string;
  jobId: string;
}

interface StemState {
  name: string;
  path: string;
  volume: number;
  muted: boolean;
  /** If a replacement has been generated, store the path here. */
  replacedPath?: string;
  /** The instrument ID used for the replacement. */
  replacedInstrumentId?: string;
  /** Whether AI replace is in progress. */
  replacing?: boolean;
}

const INSTRUMENT_OPTIONS = [
  { id: "80s_analog_synth", label: "80s Analog Synth" },
  { id: "slap_bass", label: "Slap Bass" },
  { id: "grand_piano", label: "Grand Piano" },
  { id: "electric_guitar", label: "Electric Guitar" },
  { id: "acoustic_guitar", label: "Acoustic Guitar" },
  { id: "strings_ensemble", label: "Strings Ensemble" },
  { id: "brass_section", label: "Brass Section" },
  { id: "flute", label: "Flute" },
  { id: "organ", label: "Organ" },
  { id: "marimba", label: "Marimba" },
];

const VIBE_OPTIONS = [
  { id: "punchy_pop", label: "Punchy Pop", desc: "Loud drums, bright vocals" },
  { id: "warm_lofi", label: "Warm Lo-Fi", desc: "Filtered, saturated warmth" },
  {
    id: "cinematic_wide",
    label: "Cinematic & Wide",
    desc: "Lush reverb, stereo width",
  },
  { id: "raw", label: "Raw", desc: "No processing, clean mix" },
];

const STEM_COLORS: Record<string, string> = {
  vocals: "bg-pink-500/20 border-pink-500/40 text-pink-400",
  drums: "bg-orange-500/20 border-orange-500/40 text-orange-400",
  bass: "bg-blue-500/20 border-blue-500/40 text-blue-400",
  guitar: "bg-green-500/20 border-green-500/40 text-green-400",
  piano: "bg-purple-500/20 border-purple-500/40 text-purple-400",
  other: "bg-zinc-500/20 border-zinc-500/40 text-zinc-400",
};

const STEM_ICONS: Record<string, React.ReactNode> = {
  vocals: <Music className="h-4 w-4" />,
  drums: <Drum className="h-4 w-4" />,
  bass: <Guitar className="h-4 w-4" />,
  guitar: <Guitar className="h-4 w-4" />,
  piano: <Piano className="h-4 w-4" />,
  other: <Music className="h-4 w-4" />,
};

const STEM_WAVEFORM_COLORS: Record<string, { wave: string; progress: string }> = {
  vocals: { wave: "#ec4899", progress: "#f472b6" },
  drums: { wave: "#f97316", progress: "#fb923c" },
  bass: { wave: "#3b82f6", progress: "#60a5fa" },
  guitar: { wave: "#22c55e", progress: "#4ade80" },
  piano: { wave: "#a855f7", progress: "#c084fc" },
  other: { wave: "#71717a", progress: "#a1a1aa" },
};

// ── Subcomponents ───────────────────────────────────────────

interface GalleryAsset {
  id: string;
  filename: string;
  prompt?: string;
}

interface MediaJob {
  id: string;
  type: string;
  status: string;
}

interface SmartRemixLabProps {
  audioAssets: GalleryAsset[];
}

export function SmartRemixLab({ audioAssets }: SmartRemixLabProps) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [stems, setStems] = useState<StemState[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string>("");
  const [vibe, setVibe] = useState("raw");
  const [replaceModal, setReplaceModal] = useState<{
    stemName: string;
    instrumentId: string;
  } | null>(null);
  const [masterJobId, setMasterJobId] = useState<string | null>(null);
  const [masterResult, setMasterResult] = useState<string | null>(null);
  const [analyzeJobId, setAnalyzeJobId] = useState<string | null>(null);
  const [gallerySaving, setGallerySaving] = useState(false);
  const [quickMixJobId, setQuickMixJobId] = useState<string | null>(null);
  const pollRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());

  // ── Stem Playback ─────────────────────────────────────────
  const wsRefs = useRef<Map<string, WaveSurfer | null>>(new Map());
  const wsRefCache = useRef<Map<string, React.MutableRefObject<WaveSurfer | null>>>(new Map());
  const isSyncingRef = useRef(false);
  const syncRAFRef = useRef<number | null>(null);
  const pendingSyncRef = useRef<{ stemName: string; progress: number } | null>(null);
  const isPlayingRef = useRef(false);
  const timeDisplayRef = useRef<HTMLSpanElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [totalDuration, setTotalDuration] = useState(0);

  // ── Analyze Mutation ────────────────────────────────────
  const analyzeMut = useMutation({
    mutationFn: async (assetId: string) => {
      const res = await fetchJson<MediaJob>("/api/queue/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "remix_analyze",
          payload: {
            source_asset_id: assetId,
          },
        }),
      });
      return res;
    },
    onSuccess: (job) => {
      showToast("Track analysis submitted — separating stems...", "success");
      setAnalyzeJobId(job.id);
      pollForResult(job.id, "analyze");
    },
    onError: (err) => {
      setAnalyzeJobId(null);
      showToast(
        `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    },
  });

  // ── Replace Stem Mutation ───────────────────────────────
  const replaceMut = useMutation({
    mutationFn: async ({
      stemPath,
      instrumentId,
    }: {
      stemPath: string;
      instrumentId: string;
    }) => {
      const res = await fetchJson<MediaJob>("/api/queue/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "remix_replace",
          payload: {
            source_stem_url: stemPath,
            target_instrument_id: instrumentId,
            original_bpm: analysis?.bpm,
            original_key: analysis?.key,
          },
        }),
      });
      return res;
    },
    onSuccess: (job, variables) => {
      const stemName = stems.find(
        (s) => s.path === variables.stemPath
      )?.name;
      showToast(
        `Replacing ${stemName ?? "stem"} with ${variables.instrumentId}...`,
        "success"
      );
      // Mark the stem as replacing and store the instrument id
      setStems((prev) =>
        prev.map((s) =>
          s.path === variables.stemPath
            ? { ...s, replacing: true, replacedInstrumentId: variables.instrumentId }
            : s
        )
      );
      pollForReplaceResult(job.id, variables.stemPath);
      setReplaceModal(null);
    },
    onError: (err) => {
      showToast(
        `Replace failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    },
  });

  // ── Master Mutation ─────────────────────────────────────
  const masterMut = useMutation({
    mutationFn: async () => {
      // Build stem_paths using replaced paths where available
      const stemPaths: Record<string, string> = {};
      const volumes: Record<string, number> = {};
      const muted: Record<string, boolean> = {};

      for (const stem of stems) {
        stemPaths[stem.name] = stem.replacedPath ?? stem.path;
        volumes[stem.name] = stem.volume;
        muted[stem.name] = stem.muted;
      }

      const res = await fetchJson<MediaJob>("/api/queue/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "remix_master",
          payload: {
            stem_paths: stemPaths,
            volumes,
            muted,
            vibe,
          },
        }),
      });
      return res;
    },
    onSuccess: (job) => {
      showToast("Mix & Master submitted...", "success");
      setMasterJobId(job.id);
      pollForMasterResult(job.id);
    },
    onError: (err) => {
      showToast(
        `Master failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    },
  });

  // ── Save Mix Mutation (quick mix, no mastering) ─────────
  const saveMixMut = useMutation({
    mutationFn: async () => {
      const stemPaths: Record<string, string> = {};
      const volumes: Record<string, number> = {};
      const muted: Record<string, boolean> = {};

      for (const stem of stems) {
        stemPaths[stem.name] = stem.replacedPath ?? stem.path;
        volumes[stem.name] = stem.volume;
        muted[stem.name] = stem.muted;
      }

      const res = await fetchJson<MediaJob>("/api/queue/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "remix_master",
          payload: {
            stem_paths: stemPaths,
            volumes,
            muted,
            vibe,
            skip_mastering: true,
          },
        }),
      });
      return res;
    },
    onSuccess: (job) => {
      showToast("Saving mix to gallery...", "success");
      setQuickMixJobId(job.id);
      pollForQuickMixResult(job.id);
    },
    onError: (err) => {
      showToast(
        `Save mix failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    },
  });

  // ── Polling ─────────────────────────────────────────────

  const pollForResult = useCallback(
    (jobId: string, _kind: "analyze") => {
      const interval = setInterval(async () => {
        try {
          const job = await fetchJson<{
            id: string;
            status: string;
            resultMetadata?: Record<string, unknown>;
          }>(`/api/queue/jobs/${jobId}`);

          if (job.status === "complete") {
            clearInterval(interval);
            pollRef.current.delete(interval);
            setAnalyzeJobId(null);
            // Fetch the analysis result from the sidecar status
            // The result is stored in resultMetadata by the callback handler
            const meta = job.resultMetadata ?? {};
            const result: AnalysisResult = {
              stems: (meta.stems as Record<string, string>) ?? {},
              bpm: (meta.bpm as number) ?? 0,
              key: (meta.key as string) ?? "Unknown",
              jobId,
            };
            setAnalysis(result);
            setStems(
              Object.entries(result.stems).map(([name, stemPath]) => ({
                name,
                path: stemPath,
                volume: 1.0,
                muted: false,
              }))
            );
            showToast(
              `Analysis complete — ${Object.keys(result.stems).length} stems, ${result.bpm} BPM, ${result.key}`,
              "success"
            );
          } else if (job.status === "failed") {
            clearInterval(interval);
            pollRef.current.delete(interval);
            setAnalyzeJobId(null);
            showToast("Track analysis failed", "error");
          }
        } catch {
          // Transient fetch error, keep polling
        }
      }, 3_000);

      pollRef.current.add(interval);
      // Cleanup after 10 minutes max
      setTimeout(() => { clearInterval(interval); pollRef.current.delete(interval); }, 600_000);
    },
    []
  );

  const pollForReplaceResult = useCallback(
    (jobId: string, stemPath: string) => {
      const interval = setInterval(async () => {
        try {
          const job = await fetchJson<{
            id: string;
            status: string;
            resultMetadata?: Record<string, unknown>;
          }>(`/api/queue/jobs/${jobId}`);

          if (job.status === "complete") {
            clearInterval(interval);
            pollRef.current.delete(interval);
            const meta = job.resultMetadata ?? {};
            const replacedPath =
              (meta.replaced_stem_path as string) ?? "";

            setStems((prev) =>
              prev.map((s) =>
                s.path === stemPath
                  ? {
                      ...s,
                      replacedPath,
                      replacing: false,
                    }
                  : s
              )
            );
            showToast("Instrument replacement complete!", "success");
          } else if (job.status === "failed") {
            clearInterval(interval);
            pollRef.current.delete(interval);
            setStems((prev) =>
              prev.map((s) =>
                s.path === stemPath
                  ? { ...s, replacing: false }
                  : s
              )
            );
            showToast("Replacement failed", "error");
          }
        } catch {
          // Keep polling
        }
      }, 3_000);

      pollRef.current.add(interval);
      setTimeout(() => { clearInterval(interval); pollRef.current.delete(interval); }, 600_000);
    },
    []
  );

  const pollForMasterResult = useCallback((jobId: string) => {
    const interval = setInterval(async () => {
      try {
        const job = await fetchJson<{
          id: string;
          status: string;
          resultUrl?: string;
          galleryAssetId?: string;
          resultMetadata?: Record<string, unknown>;
        }>(`/api/queue/jobs/${jobId}`);

        if (job.status === "complete") {
          clearInterval(interval);
          pollRef.current.delete(interval);
          setMasterJobId(null);
          if (job.resultUrl) {
            setMasterResult(job.resultUrl);
          }
          showToast("Mix & Master complete!", "success");
        } else if (job.status === "failed") {
          clearInterval(interval);
          pollRef.current.delete(interval);
          setMasterJobId(null);
          showToast("Mix & Master failed", "error");
        }
      } catch {
        // Keep polling
      }
    }, 3_000);
    pollRef.current.add(interval);
    setTimeout(() => { clearInterval(interval); pollRef.current.delete(interval); }, 600_000);
  }, []);

  const pollForQuickMixResult = useCallback((jobId: string) => {
    const interval = setInterval(async () => {
      try {
        const job = await fetchJson<{
          id: string;
          status: string;
          resultMetadata?: Record<string, unknown>;
        }>(`/api/queue/jobs/${jobId}`);

        if (job.status === "complete") {
          clearInterval(interval);
          pollRef.current.delete(interval);
          setQuickMixJobId(null);
          showToast("Mix saved to gallery!", "success");
        } else if (job.status === "failed") {
          clearInterval(interval);
          pollRef.current.delete(interval);
          setQuickMixJobId(null);
          showToast("Save mix failed", "error");
        }
      } catch {
        // Keep polling
      }
    }, 3_000);
    pollRef.current.add(interval);
    setTimeout(() => { clearInterval(interval); pollRef.current.delete(interval); }, 600_000);
  }, []);

  // Cleanup all polling intervals + WaveSurfer instances on unmount
  useEffect(() => {
    return () => {
      pollRef.current.forEach((id) => clearInterval(id));
      pollRef.current.clear();
      wsRefs.current.forEach((ws) => {
        try { ws?.destroy(); } catch { /* ignore */ }
      });
      wsRefs.current.clear();
      wsRefCache.current.clear();
      if (syncRAFRef.current != null) {
        cancelAnimationFrame(syncRAFRef.current);
        syncRAFRef.current = null;
      }
    };
  }, []);

  // ── Stem Playback Handlers ──────────────────────────────

  const buildStemUrl = useCallback((stemPath: string) => {
    return buildMediaUrl(`/api/files/serve?path=${encodeURIComponent(stemPath)}`);
  }, []);

  const getWsRef = useCallback((stemName: string) => {
    const cached = wsRefCache.current.get(stemName);
    if (cached) return cached;

    const ref = {
      get current() { return wsRefs.current.get(stemName) ?? null; },
      set current(ws: WaveSurfer | null) {
        wsRefs.current.set(stemName, ws ?? null);
        if (ws) {
          ws.on("seeking", (time: number) => {
            if (isSyncingRef.current || isPlayingRef.current) return;
            const dur = ws.getDuration();
            if (dur <= 0) return;
            const progress = time / dur;
            // Coalesce rapid seeking events via rAF — at most one sync per frame
            pendingSyncRef.current = { stemName, progress };
            if (syncRAFRef.current == null) {
              syncRAFRef.current = requestAnimationFrame(() => {
                syncRAFRef.current = null;
                const pending = pendingSyncRef.current;
                if (!pending) return;
                pendingSyncRef.current = null;
                isSyncingRef.current = true;
                wsRefs.current.forEach((otherWs, name) => {
                  if (name !== pending.stemName && otherWs) otherWs.seekTo(pending.progress);
                });
                isSyncingRef.current = false;
              });
            }
          });
        }
      },
    } as React.MutableRefObject<WaveSurfer | null>;

    wsRefCache.current.set(stemName, ref);
    return ref;
  }, []);

  const playAll = useCallback(() => {
    // Flush any pending seek sync before playing to prevent stuck playback
    if (syncRAFRef.current != null) {
      cancelAnimationFrame(syncRAFRef.current);
      syncRAFRef.current = null;
    }
    const pending = pendingSyncRef.current;
    if (pending) {
      pendingSyncRef.current = null;
      isSyncingRef.current = true;
      wsRefs.current.forEach((otherWs, name) => {
        if (name !== pending.stemName && otherWs) otherWs.seekTo(pending.progress);
      });
      isSyncingRef.current = false;
    }
    wsRefs.current.forEach((ws) => ws?.play());
    setIsPlaying(true);
    isPlayingRef.current = true;
  }, []);

  const pauseAll = useCallback(() => {
    wsRefs.current.forEach((ws) => ws?.pause());
    setIsPlaying(false);
    isPlayingRef.current = false;
  }, []);

  const togglePlayback = useCallback(() => {
    if (isPlaying) pauseAll();
    else playAll();
  }, [isPlaying, playAll, pauseAll]);

  const seekToStart = useCallback(() => {
    wsRefs.current.forEach((ws) => ws?.seekTo(0));
    if (timeDisplayRef.current) timeDisplayRef.current.textContent = "0:00";
  }, []);

  const handleTimeUpdate = useCallback((time: number) => {
    // Update the parent time display directly via ref — avoids re-rendering all stems
    if (timeDisplayRef.current) {
      const m = Math.floor(time / 60);
      const s = Math.floor(time % 60);
      timeDisplayRef.current.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    }
  }, []);

  const handleWsReady = useCallback((dur: number) => {
    setTotalDuration((prev) => Math.max(prev, dur));
  }, []);

  const formatTime = useCallback((t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }, []);

  // Sync "finish" events across all stems
  useEffect(() => {
    const handlers: (() => void)[] = [];
    wsRefs.current.forEach((ws) => {
      if (!ws) return;
      const onFinish = () => setIsPlaying(false);
      ws.on("finish", onFinish);
      handlers.push(() => ws.un("finish", onFinish));
    });
    return () => handlers.forEach((h) => h());
  }, [stems]);

  // ── Handlers ────────────────────────────────────────────

  const handleAnalyze = useCallback(() => {
    if (!selectedAssetId) {
      showToast("Select an audio asset first", "error");
      return;
    }
    setAnalysis(null);
    setStems([]);
    setMasterResult(null);
    wsRefs.current.clear();
    wsRefCache.current.clear();
    if (syncRAFRef.current != null) {
      cancelAnimationFrame(syncRAFRef.current);
      syncRAFRef.current = null;
    }
    setIsPlaying(false);
    if (timeDisplayRef.current) timeDisplayRef.current.textContent = "0:00";
    setTotalDuration(0);
    analyzeMut.mutate(selectedAssetId);
  }, [selectedAssetId, analyzeMut]);

  const handleOpenReplace = useCallback((stemName: string) => {
    setReplaceModal({ stemName, instrumentId: INSTRUMENT_OPTIONS[0].id });
  }, []);

  const handleConfirmReplace = useCallback(() => {
    if (!replaceModal) return;
    const stem = stems.find((s) => s.name === replaceModal.stemName);
    if (!stem) return;
    replaceMut.mutate({
      stemPath: stem.path,
      instrumentId: replaceModal.instrumentId,
    });
  }, [replaceModal, stems, replaceMut]);

  const handleMixMaster = useCallback(() => {
    if (stems.length === 0) {
      showToast("Analyze a track first", "error");
      return;
    }
    masterMut.mutate();
  }, [stems, masterMut]);

  const handleSaveMix = useCallback(() => {
    if (stems.length === 0) {
      showToast("Analyze a track first", "error");
      return;
    }
    saveMixMut.mutate();
  }, [stems, saveMixMut]);

  const handleSaveToGallery = useCallback(async () => {
    if (!masterResult) return;
    setGallerySaving(true);
    try {
      const mediaUrl = buildMediaUrl(masterResult);
      const audioRes = await fetch(mediaUrl);
      if (!audioRes.ok) throw new Error(`Failed to fetch master audio (${audioRes.status})`);
      const blob = await audioRes.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          "",
        ),
      );
      const apiBase =
        process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
      const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
      const res = await fetch(`${apiBase}/api/queue/assets/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          filename: "remix-master.wav",
          data_base64: base64,
          mime_type: "audio/wav",
          tags: ["remix", vibe],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Upload failed (${res.status})`);
      }
      showToast("Saved to gallery!", "success");
    } catch (err) {
      showToast(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    } finally {
      setGallerySaving(false);
    }
  }, [masterResult, vibe]);

  const updateStemVolume = useCallback(
    (name: string, volume: number) => {
      setStems((prev) =>
        prev.map((s) => (s.name === name ? { ...s, volume } : s))
      );
    },
    []
  );

  const toggleStemMute = useCallback(
    (name: string) => {
      setStems((prev) =>
        prev.map((s) =>
          s.name === name ? { ...s, muted: !s.muted } : s
        )
      );
    },
    []
  );

  // ── Render ──────────────────────────────────────────────

  const isAnalyzing = analyzeMut.isPending || !!analyzeJobId;
  const isMastering = masterMut.isPending || !!masterJobId;
  const isSavingMix = saveMixMut.isPending || !!quickMixJobId;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-white">AI Remix Lab</h2>

      {/* Track Selection + Analyze */}
      <SectionCard title="Track Analysis">
        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label
                htmlFor="remix-asset-select"
                className="mb-1 block text-xs font-medium text-zinc-400"
              >
                Choose a track from your gallery to analyze
              </label>
              <select
                id="remix-asset-select"
                value={selectedAssetId}
                onChange={(e) => setSelectedAssetId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Select an audio asset...</option>
                {audioAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.filename}
                    {a.prompt ? ` — ${a.prompt}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleAnalyze}
              disabled={!selectedAssetId || isAnalyzing}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isAnalyzing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {isAnalyzing ? "Analyzing..." : "Analyze & Split"}
            </button>
          </div>

          {/* Analysis Progress */}
          {isAnalyzing && (
            <div className="flex items-center gap-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
              <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
              <div className="flex-1">
                <p className="text-sm font-medium text-indigo-300">
                  Separating stems...
                </p>
                <p className="text-xs text-zinc-500">
                  This may take a minute or two. The AI is isolating vocals, drums, bass, and other instruments.
                </p>
              </div>
            </div>
          )}

          {/* Analysis Summary */}
          {analysis && (
            <div className="flex items-center gap-4 rounded-lg border border-zinc-700 bg-zinc-900/50 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">BPM</span>
                <span className="font-mono text-sm font-semibold text-indigo-400">
                  {Math.round(analysis.bpm)}
                </span>
              </div>
              <div className="h-4 w-px bg-zinc-700" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Key</span>
                <span className="font-mono text-sm font-semibold text-emerald-400">
                  {analysis.key}
                </span>
              </div>
              <div className="h-4 w-px bg-zinc-700" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Stems</span>
                <span className="font-mono text-sm font-semibold text-amber-400">
                  {Object.keys(analysis.stems).length}
                </span>
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Stem Dashboard */}
      {stems.length > 0 && (
        <SectionCard title="Stem Dashboard">
          <div className="space-y-3">
            {/* Transport Controls */}
            <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2">
              <button
                onClick={seekToStart}
                className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                title="Restart"
              >
                <SkipBack className="h-4 w-4" />
              </button>
              <button
                onClick={togglePlayback}
                className="rounded-full bg-indigo-600 p-2 text-white hover:bg-indigo-500"
                title={isPlaying ? "Pause" : "Play all stems"}
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </button>
              <span ref={timeDisplayRef} className="font-mono text-sm text-zinc-400">
                0:00
              </span>
              <span className="font-mono text-sm text-zinc-400">
                {` / ${formatTime(totalDuration)}`}
              </span>
            </div>

            {/* Stem Tracks */}
            {stems.map((stem, idx) => {
              const colorClass =
                STEM_COLORS[stem.name] ?? STEM_COLORS.other;
              const icon = STEM_ICONS[stem.name] ?? STEM_ICONS.other;
              const waveColors =
                STEM_WAVEFORM_COLORS[stem.name] ?? STEM_WAVEFORM_COLORS.other;

              return (
                <div
                  key={stem.name}
                  className={`space-y-2 rounded-lg border p-3 ${colorClass}`}
                >
                  {/* Controls row */}
                  <div className="flex items-center gap-3">
                    {/* Stem icon + name */}
                    <div className="flex w-24 items-center gap-2">
                      {icon}
                      <span className="text-sm font-medium capitalize">
                        {stem.name}
                      </span>
                    </div>

                    {/* Volume slider */}
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(stem.volume * 100)}
                      onChange={(e) =>
                        updateStemVolume(
                          stem.name,
                          Number(e.target.value) / 100
                        )
                      }
                      className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
                      aria-label={`${stem.name} volume`}
                    />
                    <span className="w-10 text-right font-mono text-xs text-zinc-400">
                      {Math.round(stem.volume * 100)}%
                    </span>

                    {/* Mute button */}
                    <button
                      onClick={() => toggleStemMute(stem.name)}
                      className={`rounded-md p-1.5 transition ${
                        stem.muted
                          ? "bg-red-500/20 text-red-400"
                          : "bg-zinc-800 text-zinc-400 hover:text-white"
                      }`}
                      title={stem.muted ? "Unmute" : "Mute"}
                    >
                      {stem.muted ? (
                        <VolumeX className="h-4 w-4" />
                      ) : (
                        <Volume2 className="h-4 w-4" />
                      )}
                    </button>

                    {/* AI Replace button */}
                    <button
                      onClick={() => handleOpenReplace(stem.name)}
                      disabled={stem.replacing}
                      className="flex items-center gap-1.5 rounded-lg bg-indigo-600/20 px-3 py-1.5 text-xs font-medium text-indigo-300 transition hover:bg-indigo-600/30 disabled:opacity-50"
                      title="AI Replace Instrument"
                    >
                      {stem.replacing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Wand2 className="h-3 w-3" />
                      )}
                      {stem.replacedPath ? "Re-Replace" : "AI Replace"}
                    </button>

                    {/* Replaced indicator */}
                    {stem.replacedPath && !stem.replacing && (
                      <span className="text-xs text-emerald-400">
                        ✓ {INSTRUMENT_OPTIONS.find((i) => i.id === stem.replacedInstrumentId)?.label ?? "Replaced"}
                      </span>
                    )}
                  </div>

                  {/* Waveform */}
                  <WaveformTrack
                    url={buildStemUrl(stem.replacedPath ?? stem.path)}
                    label={
                      stem.replacedInstrumentId
                        ? `${stem.name} → ${INSTRUMENT_OPTIONS.find((i) => i.id === stem.replacedInstrumentId)?.label ?? stem.name}`
                        : stem.name
                    }
                    color={waveColors.wave}
                    progressColor={waveColors.progress}
                    height={48}
                    muted={stem.muted}
                    volume={stem.volume}
                    showTimeline={idx === 0}
                    onTimeUpdate={idx === 0 ? handleTimeUpdate : undefined}
                    onReady={handleWsReady}
                    wsRef={getWsRef(stem.name)}
                  />
                </div>
              );
            })}

            {/* Save current mix (no mastering) */}
            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveMix}
                disabled={isSavingMix}
                className="flex items-center gap-2 rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingMix ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {isSavingMix ? "Saving Mix..." : "Save Mix"}
              </button>
            </div>
          </div>
        </SectionCard>
      )}

      {/* AI Replace Modal */}
      {replaceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <h3 className="mb-4 text-lg font-semibold text-white">
              AI Replace:{" "}
              <span className="capitalize text-indigo-400">
                {replaceModal.stemName}
              </span>
            </h3>

            <label
              htmlFor="instrument-select"
              className="mb-1 block text-xs font-medium text-zinc-400"
            >
              Target Instrument
            </label>
            <select
              id="instrument-select"
              value={replaceModal.instrumentId}
              onChange={(e) =>
                setReplaceModal({
                  ...replaceModal,
                  instrumentId: e.target.value,
                })
              }
              className="mb-6 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
            >
              {INSTRUMENT_OPTIONS.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.label}
                </option>
              ))}
            </select>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setReplaceModal(null)}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmReplace}
                disabled={replaceMut.isPending}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {replaceMut.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
                Replace
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vibe Panel + Mix & Master */}
      <SectionCard title="Auto-Mastering Vibe">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {VIBE_OPTIONS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setVibe(v.id)}
                  className={`rounded-lg border p-3 text-left transition ${
                    vibe === v.id
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
                  }`}
                >
                  <p
                    className={`text-sm font-medium ${
                      vibe === v.id ? "text-indigo-300" : "text-zinc-300"
                    }`}
                  >
                    {v.label}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">{v.desc}</p>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={handleMixMaster}
                disabled={isMastering || stems.length === 0}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isMastering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {isMastering ? "Mastering..." : "Mix & Master"}
              </button>

              {masterResult && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-emerald-400">
                    ✓ Master ready
                  </span>
                  <audio
                    controls
                    src={buildMediaUrl(masterResult)}
                    className="h-8"
                  />
                  <a
                    href={buildMediaUrl(masterResult)}
                    download="remix-master.wav"
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600/20 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-600/30"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </a>
                  <button
                    onClick={handleSaveToGallery}
                    disabled={gallerySaving}
                    className="flex items-center gap-1.5 rounded-lg bg-indigo-600/20 px-3 py-1.5 text-xs font-medium text-indigo-300 transition hover:bg-indigo-600/30 disabled:opacity-50"
                  >
                    {gallerySaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Save to Gallery
                  </button>
                </div>
              )}
            </div>
          </div>
        </SectionCard>
    </div>
  );
}
