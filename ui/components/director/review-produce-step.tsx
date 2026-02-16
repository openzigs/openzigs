"use client";

import { useState, useEffect, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { showToast } from "@/components/toast";
import {
  Clapperboard,
  Film,
  Mic,
  Music,
  Layout,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileVideo,
  Clock,
  HardDrive,
  Ban,
  Settings2,
} from "lucide-react";
import type { WizardState, RenderJobStatus, DirectorManifestSummary, RenderSettings, RenderQuality } from "./types";
import { QUALITY_PRESETS } from "./types";
import type { ModelInfo } from "@/lib/types";

interface ReviewProduceStepProps {
  state: WizardState;
  onManifestGenerated: (manifest: DirectorManifestSummary) => void;
  onRenderStarted: (jobId: string) => void;
  onModelChange: (model: string) => void;
  onRenderSettingsChange: (settings: RenderSettings) => void;
}

type ProduceResponse = {
  manifest: Record<string, unknown>;
  tokensUsed: number;
  clipsProcessed: number;
  totalDuration: number;
};

type RenderResponse = {
  jobId: string;
  status: string;
};

type RenderProgressEvent = {
  jobId: string;
  status: string;
  progress: number;
  framesRendered?: number;
  totalFrames?: number;
};

export const ReviewProduceStep = ({
  state,
  onManifestGenerated,
  onRenderStarted,
  onModelChange,
  onRenderSettingsChange,
}: ReviewProduceStepProps) => {
  const { socket } = useSocket();
  const [phase, setPhase] = useState<"review" | "producing" | "produced" | "rendering">("review");
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [framesInfo, setFramesInfo] = useState<string | null>(null);

  // Fetch available models for the model picker
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<{ models: ModelInfo[]; selectedModel?: string | null }>("/api/models"),
  });

  // Fetch director config for the default model
  const directorConfigQuery = useQuery({
    queryKey: ["director-config"],
    queryFn: () => fetchJson<{ defaultModel: string }>("/api/admin/director/config"),
  });

  const models = modelsQuery.data?.models ?? [];

  // Poll render job status
  const jobQuery = useQuery({
    queryKey: ["director-job", state.renderJobId],
    queryFn: () => fetchJson<RenderJobStatus>(`/api/admin/director/jobs/${state.renderJobId}`),
    enabled: !!state.renderJobId && phase === "rendering",
    refetchInterval: 2000,
  });

  // Socket.IO — render progress events
  useEffect(() => {
    if (!socket || !state.renderJobId) return;

    const onProgress = (data: RenderProgressEvent) => {
      if (data.jobId !== state.renderJobId) return;
      setRenderProgress(data.progress);
      setRenderStatus(data.status);
      if (data.framesRendered != null && data.totalFrames != null) {
        setFramesInfo(`${data.framesRendered} / ${data.totalFrames} frames`);
      }
    };

    const onComplete = (data: { jobId: string }) => {
      if (data.jobId !== state.renderJobId) return;
      setRenderProgress(1);
      setRenderStatus("complete");
    };

    socket.on("render:progress", onProgress);
    socket.on("render:complete", onComplete);

    return () => {
      socket.off("render:progress", onProgress);
      socket.off("render:complete", onComplete);
    };
  }, [socket, state.renderJobId]);

  // Produce mutation — ingests clips → LLM → manifest
  const produceMutation = useMutation({
    mutationFn: () =>
      fetchJson<ProduceResponse>("/api/admin/director/produce", {
        method: "POST",
        body: JSON.stringify({
          clips: state.clips.map((c) => c.path),
          mode: state.mode,
          scriptPath: state.scriptFile?.path,
          musicTrackPath: state.musicTrack?.filePath,
          template: state.templateId,
          model: state.model || undefined,
        }),
      }),
    onSuccess: (data) => {
      const manifest = data.manifest as Record<string, unknown>;
      const summary: DirectorManifestSummary = {
        projectTitle: (manifest.projectTitle as string) || "Untitled",
        templateId: (manifest.templateId as string) || "unknown",
        timelineEntries: Array.isArray(manifest.timeline) ? manifest.timeline.length : 0,
        totalDuration: data.totalDuration,
        tokensUsed: data.tokensUsed,
      };
      onManifestGenerated(summary);
      setPhase("produced");
      showToast("Production manifest generated", "success");
    },
    onError: (err) => {
      showToast(`Production failed: ${(err as Error).message}`, "error");
    },
  });

  // Render mutation — submits manifest
  const renderMutation = useMutation({
    mutationFn: () =>
      fetchJson<RenderResponse>("/api/admin/director/render", {
        method: "POST",
        body: JSON.stringify({
          manifest: produceMutation.data?.manifest,
          codec: state.renderSettings.codec,
          crf: state.renderSettings.crf,
          quality: state.renderSettings.quality,
        }),
      }),
    onSuccess: (data) => {
      onRenderStarted(data.jobId);
      setPhase("rendering");
      showToast("Render job started", "success");
    },
    onError: (err) => {
      showToast(`Render failed: ${(err as Error).message}`, "error");
    },
  });

  // Abort mutation
  const abortMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/director/jobs/${state.renderJobId}/abort`, { method: "POST" }),
    onSuccess: () => {
      showToast("Render aborted", "info");
      setRenderStatus("aborted");
    },
  });

  const handleProduce = useCallback(() => {
    setPhase("producing");
    produceMutation.mutate();
  }, [produceMutation]);

  const handleRender = useCallback(() => {
    renderMutation.mutate();
  }, [renderMutation]);

  const isComplete = renderStatus === "complete" || jobQuery.data?.status === "complete";
  const isFailed = renderStatus === "failed" || jobQuery.data?.status === "failed";
  const isAborted = renderStatus === "aborted" || jobQuery.data?.status === "aborted";
  const progressPct = Math.round((renderProgress || jobQuery.data?.progress || 0) * 100);

  const statusLabel = renderStatus || jobQuery.data?.status || "queued";
  const statusIcon = (() => {
    switch (statusLabel) {
      case "bundling":
        return <Loader2 className="h-4 w-4 animate-spin text-amber-400" />;
      case "rendering":
        return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />;
      case "encoding":
        return <Loader2 className="h-4 w-4 animate-spin text-violet-400" />;
      case "complete":
        return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-red-400" />;
      case "aborted":
        return <Ban className="h-4 w-4 text-amber-400" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  })();

  const formatBytes = (bytes: number | null) => {
    if (!bytes) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground mb-1">
          {phase === "review" && "Review & Produce"}
          {phase === "producing" && "Producing…"}
          {phase === "produced" && "Ready to Render"}
          {phase === "rendering" && "Rendering Video"}
        </h2>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          {phase === "review" && "Review your selections, then produce the video manifest using AI."}
          {phase === "producing" && "Ingesting clips, analyzing content, and building the timeline…"}
          {phase === "produced" && "Manifest generated. Start rendering to create the final video."}
          {phase === "rendering" && "Your video is being rendered. This may take a few minutes."}
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3">
        <SummaryCard
          icon={<Clapperboard className="h-4 w-4" />}
          label="Mode"
          value={state.mode === "highlight" ? "Highlight Reel" : state.mode === "script" ? "Script-Driven" : "Not set"}
        />
        <SummaryCard
          icon={<Film className="h-4 w-4" />}
          label="Clips"
          value={`${state.clips.length} file${state.clips.length !== 1 ? "s" : ""}`}
        />
        <SummaryCard
          icon={<Layout className="h-4 w-4" />}
          label="Template"
          value={state.templateId || "Default"}
        />
        <SummaryCard
          icon={<Music className="h-4 w-4" />}
          label="Music"
          value={state.musicTrack?.name || "None"}
        />
        {state.mode === "script" && state.scriptFile && (
          <SummaryCard
            icon={<Mic className="h-4 w-4" />}
            label="Script"
            value={state.scriptFile.name}
          />
        )}
        {state.manifest && (
          <SummaryCard
            icon={<FileVideo className="h-4 w-4" />}
            label="Timeline"
            value={`${state.manifest.timelineEntries} entries`}
          />
        )}
      </div>

      {/* Model Selection */}
      {phase === "review" && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">LLM for Production</label>
          <select
            value={state.model}
            onChange={(e) => onModelChange(e.target.value)}
            className="w-full rounded-xl border border-border bg-card text-sm text-foreground px-3 py-2.5"
          >
            <option value="">
              {directorConfigQuery.data?.defaultModel
                ? `Director Default (${directorConfigQuery.data.defaultModel})`
                : "System Default"}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground/60">
            High-capability models (GPT-4.1, Claude Sonnet 4) produce better video timelines.
          </p>
        </div>
      )}

      {/* Render Quality Settings */}
      {phase === "review" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <label className="text-xs font-medium text-muted-foreground">Render Quality</label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(QUALITY_PRESETS) as [RenderQuality, typeof QUALITY_PRESETS[RenderQuality]][]).map(
              ([key, preset]) => {
                const isActive = state.renderSettings.quality === key;
                return (
                  <button
                    key={key}
                    onClick={() =>
                      onRenderSettingsChange({
                        ...state.renderSettings,
                        quality: key,
                        crf: preset.crf,
                      })
                    }
                    className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                      isActive
                        ? "border-primary/50 bg-primary/5"
                        : "border-border hover:border-muted-foreground/30"
                    }`}
                  >
                    <p className={`text-sm font-medium ${isActive ? "text-primary" : "text-foreground"}`}>
                      {preset.label}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{preset.description}</p>
                  </button>
                );
              },
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/60">
            CRF {state.renderSettings.crf} • Codec: {state.renderSettings.codec}
          </p>
        </div>
      )}

      {/* Validation Warnings */}
      {phase === "review" && (
        <>
          {!state.mode && (
            <Warning text="No production mode selected. Go back to Step 1." />
          )}
          {state.clips.length === 0 && (
            <Warning text="No video clips added. Go back to Step 2." />
          )}
          {state.musicTrack && !state.musicTrack.filePath && (
            <Warning text="Music track selected but not downloaded. Go back to Step 4 and re-select the track." />
          )}
        </>
      )}

      {/* Produce Phase */}
      {phase === "review" && state.mode && state.clips.length > 0 && (
        <button
          onClick={handleProduce}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground py-3 text-sm font-medium hover:opacity-90 transition"
        >
          <Clapperboard className="h-4 w-4" />
          Produce Manifest
        </button>
      )}

      {phase === "producing" && (
        <div className="rounded-xl border border-border bg-card px-6 py-8 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-3" />
          <p className="text-sm text-foreground font-medium">Analyzing clips &amp; building timeline…</p>
          <p className="text-xs text-muted-foreground mt-1">
            This uses AI to detect scenes, transcribe audio, and assemble the timeline.
          </p>
        </div>
      )}

      {/* Produced → Render */}
      {phase === "produced" && state.manifest && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-medium text-foreground mb-2">Manifest Summary</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Project</dt>
              <dd className="text-foreground">{state.manifest.projectTitle}</dd>
              <dt className="text-muted-foreground">Template</dt>
              <dd className="text-foreground">{state.manifest.templateId}</dd>
              <dt className="text-muted-foreground">Timeline Entries</dt>
              <dd className="text-foreground">{state.manifest.timelineEntries}</dd>
              <dt className="text-muted-foreground">Total Duration</dt>
              <dd className="text-foreground">{state.manifest.totalDuration.toFixed(1)}s</dd>
              <dt className="text-muted-foreground">Tokens Used</dt>
              <dd className="text-foreground">{state.manifest.tokensUsed.toLocaleString()}</dd>
            </dl>
          </div>

          <button
            onClick={handleRender}
            disabled={renderMutation.isPending}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white py-3 text-sm font-medium hover:bg-emerald-500 transition disabled:opacity-50"
          >
            {renderMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Start Render
          </button>
        </div>
      )}

      {/* Render Phase — Progress Bar */}
      {phase === "rendering" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            {/* Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                {statusIcon}
                <span className="capitalize text-foreground font-medium">{statusLabel}</span>
              </div>
              <span className="text-sm font-mono text-muted-foreground">{progressPct}%</span>
            </div>

            {/* Progress Bar */}
            <div className="h-3 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isComplete
                    ? "bg-emerald-500"
                    : isFailed
                      ? "bg-red-500"
                      : isAborted
                        ? "bg-amber-500"
                        : "bg-primary"
                }`}
                style={{ width: `${progressPct}%` }}
              />
            </div>

            {/* Frames info */}
            {framesInfo && (
              <p className="text-xs text-muted-foreground text-center">{framesInfo}</p>
            )}

            {/* Complete state */}
            {isComplete && jobQuery.data && (
              <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
                {jobQuery.data.outputPath && (
                  <span className="flex items-center gap-1">
                    <FileVideo className="h-3 w-3" />
                    {jobQuery.data.outputPath}
                  </span>
                )}
                {jobQuery.data.durationSec && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {jobQuery.data.durationSec.toFixed(1)}s
                  </span>
                )}
                {jobQuery.data.fileSizeBytes && (
                  <span className="flex items-center gap-1">
                    <HardDrive className="h-3 w-3" />
                    {formatBytes(jobQuery.data.fileSizeBytes)}
                  </span>
                )}
              </div>
            )}

            {/* Error state */}
            {isFailed && jobQuery.data?.error && (
              <p className="text-xs text-red-400">{jobQuery.data.error}</p>
            )}
          </div>

          {/* Abort button */}
          {!isComplete && !isFailed && !isAborted && (
            <button
              onClick={() => abortMutation.mutate()}
              disabled={abortMutation.isPending}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-border text-sm text-muted-foreground py-2 hover:bg-muted/50 transition disabled:opacity-50"
            >
              <Ban className="h-3 w-3" />
              Abort Render
            </button>
          )}
        </div>
      )}
    </div>
  );
};

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-muted text-muted-foreground">
        {icon}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm text-foreground font-medium truncate max-w-[160px]">{value}</p>
      </div>
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2.5">
      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
      <p className="text-xs text-amber-300">{text}</p>
    </div>
  );
}
