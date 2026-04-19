"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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
  FileText,
  Clock,
  HardDrive,
  Ban,
  Settings2,
  PenTool,
} from "lucide-react";
import type { WizardState, RenderJobStatus, DirectorManifestSummary, RenderSettings, RenderQuality, ImageProvider, ImageModel } from "./types";
import { QUALITY_PRESETS } from "./types";
import type { ModelInfo } from "@/lib/types";
import { TelegramNotifyToggle } from "@/components/telegram-notify-toggle";

interface ReviewProduceStepProps {
  state: WizardState;
  onManifestGenerated: (manifest: DirectorManifestSummary) => void;
  onRenderStarted: (jobId: string) => void;
  onModelChange: (model: string) => void;
  onRenderSettingsChange: (settings: RenderSettings) => void;
  onImageProviderChange: (provider: ImageProvider) => void;
  onImageModelChange: (model: ImageModel) => void;
  onSlideStyleChange: (enabled: boolean) => void;
  onAssetsOnlyModeChange: (enabled: boolean) => void;
  onQuizEnabledChange?: (enabled: boolean) => void;
  onBrandVoiceChange: (voiceId: string | null) => void;
}

type ProduceAcceptedResponse = {
  produceJobId: string;
};

type ProduceJobStatus = {
  status: "running" | "complete" | "failed";
  elapsedMs?: number;
  error?: string;
  manifest?: Record<string, unknown>;
  tokensUsed?: number;
  clipsProcessed?: number;
  totalDuration?: number;
  visionAnalysisEnabled?: boolean;
  processingTimeMs?: number;
  progressLog?: Array<{ phase: string; message: string; timestamp: number }>;
  draftId?: string;
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
  onImageProviderChange,
  onImageModelChange,
  onSlideStyleChange,
  onAssetsOnlyModeChange,
  onQuizEnabledChange,
  onBrandVoiceChange,
}: ReviewProduceStepProps) => {
  const { socket } = useSocket();
  const router = useRouter();
  const [phase, setPhase] = useState<"review" | "producing" | "produced" | "rendering">("review");
  const [produceJobId, setProduceJobId] = useState<string | null>(null);
  const [completedDraftId, setCompletedDraftId] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [framesInfo, setFramesInfo] = useState<string | null>(null);
  const [enableVisionAnalysis, setEnableVisionAnalysis] = useState(true);
  const [produceElapsedSec, setProduceElapsedSec] = useState(0);
  const [notifyViaTelegram, setNotifyViaTelegram] = useState(false);

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

  // Fetch brand voices for voice selector
  const voicesQuery = useQuery({
    queryKey: ["brand-voices"],
    queryFn: () => fetchJson<{ voices: Array<{ id: string; name: string; active: boolean }> }>("/api/admin/brand-voice"),
  });
  const voices = voicesQuery.data?.voices ?? [];

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

  // Elapsed seconds timer during production
  useEffect(() => {
    if (phase !== "producing") {
      setProduceElapsedSec(0);
      return;
    }
    const interval = setInterval(() => setProduceElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // Produce mutation — submits produce request, gets back a job ID (202 Accepted)
  const produceMutation = useMutation({
    mutationFn: () => {
      if (state.mode === "presentation") {
        if (state.sourceFiles.length > 1) {
          throw new Error("Presentation mode supports one source document. Remove extra files and try again.");
        }
        // Presentation mode: source document → storyboard → images → TTS → manifest
        const sourceFile = state.sourceFiles[0];
        const ext = sourceFile?.name.split(".").pop()?.toLowerCase() ?? "";
        // Include all uploaded visual assets; backend will compute final
        // speech-aligned placements from the finalized narration.
        const visualAssets = state.visualAssets
          .map((a) => ({
            path: a.path,
            description: a.description,
            type: a.type,
            placement: a.placement,
          }));
        return fetchJson<ProduceAcceptedResponse>("/api/admin/director/produce", {
          method: "POST",
          body: JSON.stringify({
            mode: "presentation",
            inputFile: sourceFile?.path,
            sourceType: ext === "md" || ext === "markdown" ? "markdown" : "text",
            topic: state.topic || undefined,
            musicTrackPath: state.musicTrack?.filePath,
            template: state.templateId,
            model: state.model || undefined,
            imageProvider: state.imageProvider,
            imageModel: state.imageModel,
            slideStyle: state.slideStyle || undefined,
            assetsOnlyMode: state.assetsOnlyMode || undefined,
            quizEnabled: state.quizEnabled,
            visualAssets: visualAssets.length > 0 ? visualAssets : undefined,
            brandVoiceId: state.brandVoiceId || undefined,
            imageClipDurationSeconds: state.imageClipDurationSeconds,
            notifyViaTelegram: notifyViaTelegram || undefined,
          }),
        });
      }
      // Highlight / Script mode
      return fetchJson<ProduceAcceptedResponse>("/api/admin/director/produce", {
        method: "POST",
        body: JSON.stringify({
          clips: state.clips.map((c) => c.path),
          mode: state.mode,
          scriptPath: state.scriptFile?.path,
          musicTrackPath: state.musicTrack?.filePath,
          template: state.templateId,
          model: state.model || undefined,
          enableVisionAnalysis,
          brandVoiceId: state.brandVoiceId || undefined,
          notifyViaTelegram: notifyViaTelegram || undefined,
        }),
      });
    },
    onSuccess: (data) => {
      setProduceJobId(data.produceJobId);
      // phase is already "producing" from handleProduce
    },
    onError: (err) => {
      setPhase("review");
      showToast(`Production failed: ${(err as Error).message}`, "error");
    },
  });

  // Poll for produce job completion
  const produceJobQuery = useQuery({
    queryKey: ["produce-job", produceJobId],
    queryFn: () => fetchJson<ProduceJobStatus>(`/api/admin/director/produce/${produceJobId}`),
    enabled: !!produceJobId && phase === "producing",
    refetchInterval: 3000,
  });

  // React to produce job status changes
  useEffect(() => {
    if (!produceJobQuery.data) return;
    const data = produceJobQuery.data;

    if (data.status === "complete" && data.manifest) {
      const manifest = data.manifest;
      const summary: DirectorManifestSummary = {
        projectTitle: (manifest.projectTitle as string) || "Untitled",
        templateId: (manifest.templateId as string) || "unknown",
        timelineEntries: Array.isArray(manifest.timeline) ? manifest.timeline.length : 0,
        totalDuration: data.totalDuration ?? 0,
        tokensUsed: data.tokensUsed ?? 0,
      };
      onManifestGenerated(summary);
      if (data.draftId) setCompletedDraftId(data.draftId);
      setPhase("produced");
      showToast("Production manifest generated", "success");
    } else if (data.status === "failed") {
      setPhase("review");
      setProduceJobId(null);
      showToast(`Production failed: ${data.error || "Unknown error"}`, "error");
    }
  }, [produceJobQuery.data, onManifestGenerated]);

  // Render mutation — submits manifest
  const renderMutation = useMutation({
    mutationFn: () =>
      fetchJson<RenderResponse>("/api/admin/director/render", {
        method: "POST",
        body: JSON.stringify({
          manifest: produceJobQuery.data?.manifest,
          codec: state.renderSettings.codec,
          crf: state.renderSettings.crf,
          quality: state.renderSettings.quality,
          notifyViaTelegram: notifyViaTelegram || undefined,
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
      case "finalizing":
        return <Loader2 className="h-4 w-4 animate-spin text-teal-400" />;
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
          value={state.mode === "highlight" ? "Highlight Reel" : state.mode === "script" ? "Script-Driven" : state.mode === "presentation" ? "Presentation" : "Not set"}
        />
        <SummaryCard
          icon={<Film className="h-4 w-4" />}
          label={state.mode === "presentation" ? "Source" : "Clips"}
          value={
            state.mode === "presentation"
              ? state.sourceFiles.length > 0
                ? state.sourceFiles[0].name
                : "None"
              : `${state.clips.length} file${state.clips.length !== 1 ? "s" : ""}`
          }
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
        {state.mode === "presentation" && state.topic.trim() && (
          <SummaryCard
            icon={<FileText className="h-4 w-4" />}
            label="Preamble"
            value={state.topic.length > 40 ? state.topic.slice(0, 37) + "…" : state.topic}
          />
        )}
        {state.mode === "presentation" && (
          <SummaryCard
            icon={<Settings2 className="h-4 w-4" />}
            label="Presenter Quizzes"
            value={state.quizEnabled ? "Enabled" : "Disabled"}
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

      {/* Brand Voice Selection */}
      {phase === "review" && voices.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <PenTool className="h-3.5 w-3.5" />
            Brand Voice
          </label>
          <select
            value={state.brandVoiceId ?? ""}
            onChange={(e) => onBrandVoiceChange(e.target.value || null)}
            className="w-full rounded-xl border border-border bg-card text-sm text-foreground px-3 py-2.5"
          >
            <option value="">Default (active voice)</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}{v.active ? " ✓" : ""}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground/60">
            Apply a specific brand voice style to narration and captions.
          </p>
        </div>
      )}

      {/* Image Generation Model — only shown for presentation mode */}
      {phase === "review" && state.mode === "presentation" && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Image Provider</label>
            <select
              value={state.imageProvider}
              onChange={(e) => onImageProviderChange(e.target.value as ImageProvider)}
              className="w-full rounded-xl border border-border bg-card text-sm text-foreground px-3 py-2.5"
            >
              <option value="auto">Auto (try cloud, fall back to local)</option>
              <option value="local">Local Sidecar</option>
              <option value="cloud">Cloud (Vertex AI Imagen 3)</option>
            </select>
          </div>
          {/* Assets-Only Mode — shown when user has uploaded visual assets */}
          {state.visualAssets.length > 0 && (
            <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Film className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm text-foreground font-medium">Use My Images</p>
                  <p className="text-[11px] text-muted-foreground">
                    Your uploaded assets become the slides. AI only generates an intro and outro image.
                    Great for presentations built entirely around your own visuals.
                  </p>
                </div>
              </div>
              <button
                onClick={() => onAssetsOnlyModeChange(!state.assetsOnlyMode)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-3 ${
                  state.assetsOnlyMode ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    state.assetsOnlyMode ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}

          {/* Slide Style Toggle — only for cloud provider */}
          {state.imageProvider === "cloud" && (
            <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-blue-500/10 text-blue-400">
                  <Layout className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm text-foreground font-medium">Slide-Style Images</p>
                  <p className="text-[11px] text-muted-foreground">
                    Render short text phrases directly into generated images for a PowerPoint-style look.
                    Best for title slides and key takeaways.
                  </p>
                </div>
              </div>
              <button
                onClick={() => onSlideStyleChange(!state.slideStyle)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-3 ${
                  state.slideStyle ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    state.slideStyle ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}

          {/* Quiz-enabled toggle — Presenter Mode (SI-1 #276) */}
          {state.mode === "presentation" && (
            <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Settings2 className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm text-foreground font-medium">Enable Pop Quizzes</p>
                  <p className="text-[11px] text-muted-foreground">
                    Auto-generate quiz questions between chapters in Presenter Mode.
                    Questions are powered by the Teacher Agent.
                  </p>
                </div>
              </div>
              <button
                onClick={() => onQuizEnabledChange?.(!state.quizEnabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-3 ${
                  state.quizEnabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    state.quizEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Image Model (Local Sidecar)</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { id: "sdxl-base" as const, name: "SDXL Base", desc: "Character LoRA, ~6s/image, 1024×1024" },
                { id: "flux-schnell" as const, name: "FLUX.1 Schnell", desc: "High quality, ~8s/image, 1024×1024" },
              ]).map((m) => {
                const isActive = state.imageModel === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => onImageModelChange(m.id)}
                    className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                      isActive
                        ? "border-primary/50 bg-primary/5"
                        : "border-border hover:border-muted-foreground/30"
                    }`}
                  >
                    <p className={`text-sm font-medium ${isActive ? "text-primary" : "text-foreground"}`}>
                      {m.name}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{m.desc}</p>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              Only used when provider is &ldquo;Local Sidecar&rdquo; or &ldquo;Auto&rdquo; falls back to local.
              Requires the image generation sidecar to be running.
            </p>
          </div>
        </div>
      )}

      {/* Render Quality Settings */}
      {phase === "review" && (
        <div className="space-y-3">
          {/* Vision Analysis Toggle */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-violet-500/10 text-violet-400">
                <Film className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm text-foreground font-medium">AI Vision Analysis</p>
                <p className="text-[11px] text-muted-foreground">
                  Analyzes keyframes with AI for richer scene descriptions. Adds 2–5 min but
                  produces smarter edits with better effects.
                </p>
              </div>
            </div>
            <button
              onClick={() => setEnableVisionAnalysis(!enableVisionAnalysis)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-3 ${
                enableVisionAnalysis ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  enableVisionAnalysis ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Telegram Notification Toggle */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
            <TelegramNotifyToggle
              checked={notifyViaTelegram}
              onChange={setNotifyViaTelegram}
            />
          </div>

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
          {state.mode === "presentation" && state.sourceFiles.length === 0 && (
            <Warning text="No source document added. Go back to Step 2 and add a .txt or .md file." />
          )}
          {state.mode !== "presentation" && state.clips.length === 0 && (
            <Warning text="No video clips added. Go back to Step 2." />
          )}
          {state.musicTrack && !state.musicTrack.filePath && (
            <Warning text="Music track selected but not downloaded. Go back to Step 4 and re-select the track." />
          )}
        </>
      )}

      {/* Produce Phase */}
      {phase === "review" && state.mode && (state.mode === "presentation" ? state.sourceFiles.length > 0 : state.clips.length > 0) && (
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
          <p className="text-sm text-foreground font-medium">
            {state.mode === "presentation"
              ? "Reading document & generating storyboard…"
              : "Analyzing clips & building timeline…"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {state.mode === "presentation"
              ? "The AI is reading your document, creating a storyboard, generating images, and synthesizing voiceover."
              : "This uses AI to detect scenes, transcribe audio, and assemble the timeline."}
          </p>
          {enableVisionAnalysis && (
            <div className="mt-3 rounded-lg bg-amber-500/5 border border-amber-500/20 px-4 py-2">
              <p className="text-xs text-amber-300">
                <strong>Vision analysis enabled</strong> — each keyframe is being analyzed by AI for
                rich scene descriptions. This typically takes 2–5 minutes but produces
                significantly better edits.
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground/60 mt-3 font-mono">
            {Math.floor(produceElapsedSec / 60)}:{String(produceElapsedSec % 60).padStart(2, "0")} elapsed
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
              {state.mode === "presentation" && (
                <>
                  <dt className="text-muted-foreground">Presenter Quizzes</dt>
                  <dd className="text-foreground">{state.quizEnabled ? "Enabled" : "Disabled"}</dd>
                </>
              )}
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

          {completedDraftId && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <span className="text-emerald-300">Saved to Drafts —</span>
              <Link
                href={`/director/studio/${completedDraftId}`}
                className="text-primary hover:underline font-medium"
              >
                Open in Studio →
              </Link>
            </div>
          )}

          {!completedDraftId && (
            <button
              onClick={async () => {
                if (!produceJobQuery.data?.manifest) return;
                const manifest = produceJobQuery.data.manifest;
                const title = (manifest as Record<string, unknown>).projectTitle as string || "Untitled";
                const res = await fetchJson<{ id: string }>("/api/admin/director/drafts", {
                  method: "POST",
                  body: JSON.stringify({
                    title,
                    manifest,
                    productionMode: state.mode ?? "presentation",
                  }),
                });
                router.push(`/director/studio/${res.id}`);
              }}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-border text-sm text-foreground py-3 hover:bg-muted/50 transition"
            >
              <PenTool className="h-4 w-4" />
              Open in Studio
            </button>
          )}
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
