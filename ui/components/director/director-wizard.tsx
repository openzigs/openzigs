"use client";

import { useState, useCallback, useMemo } from "react";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import {
  WIZARD_STEPS,
  createInitialState,
  type WizardState,
  type ProductionMode,
  type MediaFile,
  type SelectedAsset,
  type DirectorManifestSummary,
  type RenderSettings,
  type ImageProvider,
  type ImageModel,
} from "./types";
import { ModeSelectionStep } from "./mode-selection-step";
import { MediaUploadStep } from "./media-upload-step";
import { TemplatePickerStep } from "./template-picker-step";
import { SoundBrowserStep } from "./sound-browser-step";
import { ReviewProduceStep } from "./review-produce-step";
import { VisualAssetsStep } from "./visual-assets-step";
import type { VisualAsset } from "./types";

export const DirectorWizard = () => {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(createInitialState);

  // ── Step validity checks ──────────────────────────────────
  const canAdvance = useMemo(() => {
    switch (step) {
      case 1:
        return state.mode !== null;
      case 2:
        return state.mode === "presentation" ? state.sourceFiles.length > 0 : state.clips.length > 0;
      case 3:
        return true; // template selection is optional (uses default)
      case 4:
        return true; // music is optional
      case 5:
        return true; // visual assets are optional
      case 6:
        return false; // no "next" from final step
      default:
        return false;
    }
  }, [step, state.mode, state.clips.length, state.sourceFiles.length]);

  // ── State updaters ────────────────────────────────────────
  const setMode = useCallback((mode: ProductionMode) => {
    setState((s) => ({ ...s, mode }));
  }, []);

  const setClips = useCallback((clips: MediaFile[]) => {
    setState((s) => ({ ...s, clips }));
  }, []);

  const setScriptFile = useCallback((scriptFile: MediaFile | null) => {
    setState((s) => ({ ...s, scriptFile }));
  }, []);

  const setTopic = useCallback((topic: string) => {
    setState((s) => ({ ...s, topic }));
  }, []);

  const setSourceFiles = useCallback((sourceFiles: MediaFile[]) => {
    setState((s) => ({ ...s, sourceFiles }));
  }, []);

  const setTemplateId = useCallback((templateId: string | null) => {
    setState((s) => ({ ...s, templateId }));
  }, []);

  const setMusicTrack = useCallback((musicTrack: SelectedAsset | null) => {
    setState((s) => ({ ...s, musicTrack }));
  }, []);

  const setModel = useCallback((model: string) => {
    setState((s) => ({ ...s, model }));
  }, []);

  const setRenderSettings = useCallback((renderSettings: RenderSettings) => {
    setState((s) => ({ ...s, renderSettings }));
  }, []);

  const setImageProvider = useCallback((imageProvider: ImageProvider) => {
    setState((s) => ({ ...s, imageProvider }));
  }, []);

  const setImageModel = useCallback((imageModel: ImageModel) => {
    setState((s) => ({ ...s, imageModel }));
  }, []);

  const setSlideStyle = useCallback((slideStyle: boolean) => {
    setState((s) => ({ ...s, slideStyle }));
  }, []);

  const setAssetsOnlyMode = useCallback((assetsOnlyMode: boolean) => {
    setState((s) => ({ ...s, assetsOnlyMode }));
  }, []);

  const setQuizEnabled = useCallback((quizEnabled: boolean) => {
    setState((s) => ({ ...s, quizEnabled }));
  }, []);

  const setBrandVoiceId = useCallback((brandVoiceId: string | null) => {
    setState((s) => ({ ...s, brandVoiceId }));
  }, []);

  const setManifest = useCallback((manifest: DirectorManifestSummary) => {
    setState((s) => ({ ...s, manifest }));
  }, []);

  const setRenderJobId = useCallback((renderJobId: string) => {
    setState((s) => ({ ...s, renderJobId }));
  }, []);

  const setVisualAssets = useCallback((visualAssets: VisualAsset[]) => {
    setState((s) => ({ ...s, visualAssets }));
  }, []);

  const goNext = useCallback(() => {
    if (step < WIZARD_STEPS.length && canAdvance) setStep((s) => s + 1);
  }, [step, canAdvance]);

  const goBack = useCallback(() => {
    if (step > 1) setStep((s) => s - 1);
  }, [step]);

  const goToStep = useCallback(
    (n: number) => {
      // Only allow going to steps already visited or current + 1
      if (n >= 1 && n <= step) setStep(n);
    },
    [step]
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* ── Step indicator ──────────────────────────────────── */}
      <nav className="flex items-center justify-center gap-1 px-4 py-4 shrink-0">
        {WIZARD_STEPS.map((ws) => {
          const isActive = ws.id === step;
          const isPast = ws.id < step;
          return (
            <button
              key={ws.id}
              onClick={() => goToStep(ws.id)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isPast
                    ? "bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer"
                    : "bg-muted text-muted-foreground cursor-default"
              }`}
              disabled={ws.id > step}
            >
              {isPast ? (
                <Check className="h-3 w-3" />
              ) : (
                <span className="tabular-nums">{ws.id}</span>
              )}
              <span className="hidden sm:inline">{ws.label}</span>
            </button>
          );
        })}
      </nav>

      {/* ── Step content ────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {step === 1 && (
          <ModeSelectionStep selected={state.mode} onSelect={setMode} />
        )}
        {step === 2 && (
          <MediaUploadStep
            mode={state.mode!}
            clips={state.clips}
            scriptFile={state.scriptFile}
            topic={state.topic}
            sourceFiles={state.sourceFiles}
            onClipsChange={setClips}
            onScriptChange={setScriptFile}
            onTopicChange={setTopic}
            onSourceFilesChange={setSourceFiles}
          />
        )}
        {step === 3 && (
          <TemplatePickerStep
            selected={state.templateId}
            onSelect={setTemplateId}
          />
        )}
        {step === 4 && (
          <SoundBrowserStep
            selected={state.musicTrack}
            onSelect={setMusicTrack}
          />
        )}
        {step === 5 && (
          <VisualAssetsStep assets={state.visualAssets} onChange={setVisualAssets} />
        )}
        {step === 6 && (
          <ReviewProduceStep
            state={state}
            onManifestGenerated={setManifest}
            onRenderStarted={setRenderJobId}
            onModelChange={setModel}
            onRenderSettingsChange={setRenderSettings}
            onImageProviderChange={setImageProvider}
            onImageModelChange={setImageModel}
            onSlideStyleChange={setSlideStyle}
            onAssetsOnlyModeChange={setAssetsOnlyMode}
            onQuizEnabledChange={setQuizEnabled}
            onBrandVoiceChange={setBrandVoiceId}
          />
        )}
      </div>

      {/* ── Bottom navigation ───────────────────────────────── */}
      <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-between border-t border-border bg-background/90 px-6 py-3 backdrop-blur supports-[padding:max(0px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          onClick={goBack}
          disabled={step === 1}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>

        <p className="text-xs text-muted-foreground">
          Step {step} of {WIZARD_STEPS.length} &mdash;{" "}
          {WIZARD_STEPS[step - 1].description}
        </p>

        {step < WIZARD_STEPS.length ? (
          <button
            onClick={goNext}
            disabled={!canAdvance}
            className="flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 disabled:opacity-30 disabled:cursor-not-allowed transition"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <div className="w-12" /> // empty spacer
        )}
      </div>
    </div>
  );
};
