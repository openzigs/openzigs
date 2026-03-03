"use client";

import { useState, useCallback, useRef, useEffect, useMemo, type SyntheticEvent } from "react";
import { RefreshCw, Loader2, Image, Clock, Type, Upload, PenLine, Mic, Play, Pause, Volume2, Sparkles, Wand2 } from "lucide-react";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { useActivity } from "@/lib/activity-context";
import type { InspectorState, DirectorManifest } from "../types";
import { FramingPanel } from "./framing-panel";
import { NarrationEditor, type NarrationDirective, type VoicePreset } from "./narration-editor";

interface SceneInspectorProps {
  inspector: InspectorState;
  manifest: DirectorManifest | null;
  draftId: string;
  onManifestUpdate: (manifest: DirectorManifest) => void;
}

interface UploadResult {
  filePath: string;
  kind: string;
  videoInfo?: { durationSec: number; width: number; height: number } | null;
}

interface DirectivesResponse {
  directives: NarrationDirective[];
  voices: VoicePreset[];
}

interface VoiceEngine {
  id: string;
  name: string;
  available: boolean;
  active: boolean;
}

export function SceneInspector({ inspector, manifest, draftId, onManifestUpdate }: SceneInspectorProps) {
  const { startActivity } = useActivity();
  const [editPrompt, setEditPrompt] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingBackground, setUploadingBackground] = useState(false);
  const [rewritingScript, setRewritingScript] = useState(false);
  const [showRewriteOffer, setShowRewriteOffer] = useState(false);
  const [lastVideoDuration, setLastVideoDuration] = useState<number | null>(null);
  const [narrationDirectives, setNarrationDirectives] = useState<NarrationDirective[]>([]);
  const [voicePresets, setVoicePresets] = useState<VoicePreset[]>([]);
  const [scriptText, setScriptText] = useState("");

  // Voice Lab state
  const [voiceEngines, setVoiceEngines] = useState<VoiceEngine[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<string>("auto");
  const [reRecording, setReRecording] = useState(false);
  const [voicePreviewPlaying, setVoicePreviewPlaying] = useState(false);
  const [f5Params, setF5Params] = useState({
    speed: 1.0,
    steps: 8,
    method: "rk4" as "euler" | "midpoint" | "rk4",
    cfgStrength: 1.0,
    swayCoef: -1.0,
  });
  const voicePreviewRef = useRef<HTMLAudioElement>(null);

  // Image generation state
  const [imageModel, setImageModel] = useState<"flux-schnell" | "flux-dev">("flux-schnell");
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [img2imgPrompt, setImg2imgPrompt] = useState("");
  const [img2imgStrength, setImg2imgStrength] = useState(0.6);
  const [enhancingImage, setEnhancingImage] = useState(false);
  const [suggestingParams, setSuggestingParams] = useState(false);
  const [addingDirectives, setAddingDirectives] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bgFileInputRef = useRef<HTMLInputElement>(null);
  const fps = manifest?.composition?.fps ?? 30;

  // Derive entry from the live manifest so updates (re-record, regenerate, etc.)
  // are immediately reflected instead of using the stale inspector snapshot.
  const entry = useMemo(() => {
    if (inspector.sceneIndex === null || !manifest) return inspector.entry;
    const timeline = manifest.timeline ?? [];
    const targetType = inspector.entry?.type;

    if (targetType === "intro_card" || targetType === "outro_card" || targetType === "title_card") {
      // Cards are matched by type + startAtFrame (since there can be multiple title_cards)
      return timeline.find((e) =>
        e.type === targetType && e.startAtFrame === inspector.entry?.startAtFrame,
      ) ?? timeline.find((e) => e.type === targetType) ?? inspector.entry;
    }

    const visualTypes = new Set(["image_scene", "video_clip"]);
    let sceneCount = 0;
    for (const e of timeline) {
      if (visualTypes.has(e.type)) {
        if (sceneCount === inspector.sceneIndex) return e;
        sceneCount++;
      }
    }
    return inspector.entry;
  }, [inspector.sceneIndex, inspector.entry, manifest]);

  // Fetch narration directives once
  useEffect(() => {
    fetchJson<DirectivesResponse>("/api/admin/director/narration/directives")
      .then((data) => {
        setNarrationDirectives(data.directives);
        setVoicePresets(data.voices);
      })
      .catch(() => {
        // Gracefully degrade — autocomplete just won't have server data
      });
  }, []);

  // Sync local script state with selected entry
  useEffect(() => {
    setScriptText(entry?.scriptText ?? "");
  }, [entry?.scriptText, inspector.sceneIndex]);

  // Fetch available voice engines
  useEffect(() => {
    fetchJson<{ engines: VoiceEngine[] }>("/api/admin/director/voice/engines")
      .then((data) => setVoiceEngines(data.engines))
      .catch(() => {});
  }, []);

  // Stop preview audio when scene changes
  useEffect(() => {
    const audio = voicePreviewRef.current;
    if (audio) {
      audio.pause();
      setVoicePreviewPlaying(false);
    }
  }, [inspector.sceneIndex]);

  const isVisualScene = entry?.type === "image_scene" || entry?.type === "video_clip";
  const isCardWithBackground = entry?.type === "intro_card" || entry?.type === "outro_card";
  const hasScript = isVisualScene || isCardWithBackground;

  /** Find and update the entry in the manifest timeline by matching the inspector's scene. */
  const updateTimelineEntry = useCallback(
    (updater: (entry: Record<string, unknown>) => Record<string, unknown>) => {
      if (inspector.sceneIndex === null || !manifest) return;
      const updated = { ...manifest, timeline: [...(manifest.timeline ?? [])] };
      // For visual scenes, count only image_scene/video_clip
      // For card types, count all types to find the right index
      const visualTypes = new Set(["image_scene", "video_clip"]);
      const targetType = entry?.type;

      if (targetType && (targetType === "intro_card" || targetType === "outro_card")) {
        // Cards: find by type since there's typically only one of each
        for (let i = 0; i < updated.timeline.length; i++) {
          if (updated.timeline[i].type === targetType) {
            updated.timeline[i] = updater(updated.timeline[i]) as typeof updated.timeline[number];
            break;
          }
        }
      } else {
        // Visual scenes: count by scene index
        let sceneCount = 0;
        for (let i = 0; i < updated.timeline.length; i++) {
          if (visualTypes.has(updated.timeline[i].type)) {
            if (sceneCount === inspector.sceneIndex) {
              updated.timeline[i] = updater(updated.timeline[i]) as typeof updated.timeline[number];
              break;
            }
            sceneCount++;
          }
        }
      }
      onManifestUpdate(updated);
      return updated;
    },
    [inspector.sceneIndex, manifest, entry?.type, onManifestUpdate],
  );

  const handleReRecord = useCallback(async () => {
    if (inspector.sceneIndex === null || !scriptText.trim()) return;
    setReRecording(true);
    const done = startActivity(`rerecord:${inspector.sceneIndex}`, "voice", `Re-recording scene ${(inspector.sceneIndex ?? 0) + 1} voiceover`);
    try {
      const body: Record<string, unknown> = {
        draftId,
        text: scriptText,
      };
      if (selectedEngine !== "auto") body.engine = selectedEngine;
      if (selectedEngine === "f5tts") body.f5ttsParams = f5Params;

      const result = await fetchJson<{
        sceneIndex: number;
        voiceoverPath: string;
        durationSec: number;
        engine: string;
      }>(`/api/admin/director/scenes/${inspector.sceneIndex}/re-record`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      // Update manifest with new voiceover
      const updated = updateTimelineEntry((e) => ({
        ...e,
        voiceover: result.voiceoverPath,
        scriptText,
        duration: Math.max(Math.round((result.durationSec + 0.35) * fps), fps),
      }));

      if (updated) {
        await fetchJson(`/api/admin/director/drafts/${draftId}`, {
          method: "PUT",
          body: JSON.stringify({ manifest: updated }),
        });
      }

      // Auto-load the new voiceover for preview
      const audio = voicePreviewRef.current;
      if (audio) {
        const fileName = result.voiceoverPath.split("/").pop() ?? "";
        audio.src = buildMediaUrl(`/api/admin/director/files/${encodeURIComponent(fileName)}`);
        audio.load();
      }
    } catch (err) {
      console.error("Re-record failed:", err);
    } finally {
      done();
      setReRecording(false);
    }
  }, [inspector.sceneIndex, scriptText, draftId, selectedEngine, f5Params, fps, updateTimelineEntry, startActivity]);

  const toggleVoicePreview = useCallback(() => {
    const audio = voicePreviewRef.current;
    if (!audio) return;
    if (voicePreviewPlaying) {
      audio.pause();
      setVoicePreviewPlaying(false);
    } else {
      audio.play().then(() => setVoicePreviewPlaying(true)).catch(() => {});
    }
  }, [voicePreviewPlaying]);

  const handleSuggestF5Params = useCallback(async () => {
    if (!scriptText.trim()) return;
    setSuggestingParams(true);
    const done = startActivity("suggest-f5", "ai", "AI analyzing voice parameters");
    try {
      const result = await fetchJson<{
        speed: number;
        steps: number;
        method: "euler" | "midpoint" | "rk4";
        cfgStrength: number;
        swayCoef: number;
        reasoning: string;
      }>("/api/admin/director/voice/analyze-params", {
        method: "POST",
        body: JSON.stringify({ text: scriptText }),
      });
      setF5Params({
        speed: result.speed,
        steps: result.steps,
        method: result.method,
        cfgStrength: result.cfgStrength,
        swayCoef: result.swayCoef,
      });
    } catch (err) {
      console.error("F5-TTS param suggestion failed:", err);
    } finally {
      done();
      setSuggestingParams(false);
    }
  }, [scriptText, startActivity]);

  const handleAddDirectives = useCallback(async () => {
    if (!scriptText.trim()) return;
    setAddingDirectives(true);
    const done = startActivity("add-directives", "ai", "AI adding narration directives");
    try {
      const result = await fetchJson<{ enhanced: string; reasoning: string }>(
        "/api/admin/director/voice/add-directives",
        {
          method: "POST",
          body: JSON.stringify({
            text: scriptText,
            engine: selectedEngine === "auto" ? undefined : selectedEngine,
          }),
        },
      );
      setScriptText(result.enhanced);

      // Persist directive-enhanced text to manifest immediately so it isn't
      // lost when the entry re-syncs (useEffect sets scriptText from entry.scriptText).
      const updated = updateTimelineEntry((e) => ({ ...e, scriptText: result.enhanced }));
      if (updated) {
        await fetchJson(`/api/admin/director/drafts/${draftId}`, {
          method: "PUT",
          body: JSON.stringify({ manifest: updated }),
        });
      }
    } catch (err) {
      console.error("Add directives failed:", err);
    } finally {
      done();
      setAddingDirectives(false);
    }
  }, [scriptText, selectedEngine, startActivity, draftId, updateTimelineEntry]);

  const handleEnhancePrompt = useCallback(async () => {
    if (!editPrompt.trim()) return;
    setEnhancingPrompt(true);
    const done = startActivity("enhance-prompt", "ai", "AI enhancing image prompt");
    try {
      const result = await fetchJson<{ enhanced_prompt: string; thinking: string }>(
        `/api/admin/director/scenes/${inspector.sceneIndex}/enhance-prompt`,
        {
          method: "POST",
          body: JSON.stringify({ prompt: editPrompt }),
        },
      );
      setEditPrompt(result.enhanced_prompt);
    } catch (err) {
      console.error("Prompt enhancement failed:", err);
    } finally {
      done();
      setEnhancingPrompt(false);
    }
  }, [editPrompt, inspector.sceneIndex, startActivity]);

  const handleImg2Img = useCallback(async () => {
    if (inspector.sceneIndex === null || !img2imgPrompt.trim() || !manifest) return;
    setEnhancingImage(true);
    const done = startActivity(`img2img:${inspector.sceneIndex}`, "image", `Enhancing scene ${(inspector.sceneIndex ?? 0) + 1} image`);
    try {
      const result = await fetchJson<{ sceneIndex: number; imagePath: string; generationTimeMs: number }>(
        `/api/admin/director/scenes/${inspector.sceneIndex}/img2img`,
        {
          method: "POST",
          body: JSON.stringify({
            draftId,
            prompt: img2imgPrompt,
            strength: img2imgStrength,
            model: imageModel,
          }),
        },
      );
      updateTimelineEntry((e) => ({ ...e, src: result.imagePath }));
    } catch (err) {
      console.error("img2img failed:", err);
    } finally {
      done();
      setEnhancingImage(false);
    }
  }, [inspector.sceneIndex, img2imgPrompt, img2imgStrength, imageModel, draftId, manifest, updateTimelineEntry, startActivity]);

  const handleRegenerate = useCallback(async () => {
    if (inspector.sceneIndex === null || !editPrompt.trim() || !manifest) return;
    setRegenerating(true);
    const done = startActivity(`regen:${inspector.sceneIndex}`, "image", `Regenerating scene ${(inspector.sceneIndex ?? 0) + 1} image`);
    try {
      const result = await fetchJson<{ sceneIndex: number; imagePath: string }>(
        `/api/admin/director/scenes/${inspector.sceneIndex}/regenerate`,
        {
          method: "POST",
          body: JSON.stringify({ draftId, prompt: editPrompt, model: imageModel }),
        },
      );

      updateTimelineEntry((e) => ({ ...e, src: result.imagePath }));
    } catch (err) {
      console.error("Scene regeneration failed:", err);
    } finally {
      done();
      setRegenerating(false);
    }
  }, [inspector.sceneIndex, editPrompt, draftId, manifest, imageModel, updateTimelineEntry, startActivity]);

  const handleRewriteScript = useCallback(async () => {
    if (inspector.sceneIndex === null || !manifest) return;
    setRewritingScript(true);
    const done = startActivity(`rewrite:${inspector.sceneIndex}`, "ai", `Rewriting scene ${(inspector.sceneIndex ?? 0) + 1} script`);
    try {
      const result = await fetchJson<{ newScript: string }>(
        `/api/admin/director/scenes/${inspector.sceneIndex}/rewrite-script`,
        {
          method: "POST",
          body: JSON.stringify({
            draftId,
            videoDurationSec: lastVideoDuration,
            currentScript: entry?.scriptText,
          }),
        },
      );

      updateTimelineEntry((e) => ({ ...e, scriptText: result.newScript }));
      setScriptText(result.newScript);
      setShowRewriteOffer(false);
    } catch (err) {
      console.error("Script rewrite failed:", err);
    } finally {
      done();
      setRewritingScript(false);
    }
  }, [inspector.sceneIndex, manifest, draftId, lastVideoDuration, entry?.scriptText, updateTimelineEntry, startActivity]);

  const handleScriptSave = useCallback(
    async (newScript: string) => {
      const updated = updateTimelineEntry((e) => ({ ...e, scriptText: newScript }));
      if (updated) {
        try {
          await fetchJson(`/api/admin/director/drafts/${draftId}`, {
            method: "PUT",
            body: JSON.stringify({ manifest: updated }),
          });
        } catch (err) {
          console.error("Failed to persist script edit:", err);
        }
      }
    },
    [updateTimelineEntry, draftId],
  );

  const handleBackgroundUpload = useCallback(
    async (file: File) => {
      if (!manifest) return;
      setUploadingBackground(true);
      try {
        const result = await fetchJson<UploadResult>(
          `/api/admin/director/files/upload-asset?kind=image`,
          {
            method: "POST",
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name),
            },
            body: file,
          },
        );

        const updated = updateTimelineEntry((e) => ({
          ...e,
          backgroundSrc: result.filePath,
        }));
        if (updated) {
          await fetchJson(`/api/admin/director/drafts/${draftId}`, {
            method: "PUT",
            body: JSON.stringify({ manifest: updated }),
          });
        }
      } catch (err) {
        console.error("Background upload failed:", err);
      } finally {
        setUploadingBackground(false);
      }
    },
    [manifest, draftId, updateTimelineEntry],
  );

  if (!entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Image className="h-8 w-8" />
        <p className="text-sm">Select a scene in the timeline to inspect</p>
      </div>
    );
  }

  const startFrame = entry.startAtFrame ?? 0;
  const dur = entry.duration ?? entry.durationInFrames ?? 0;
  const startSec = (startFrame / fps).toFixed(1);
  const durSec = (dur / fps).toFixed(1);
  const backgroundSrc = (entry.backgroundSrc ?? entry.enhancedBackgroundSrc) as string | undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Scene {inspector.sceneIndex !== null ? inspector.sceneIndex + 1 : "—"}
        </h3>
        <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
          {entry.type.replace("_", " ")}
        </span>
      </div>

      {/* Image preview (visual scenes) */}
      {entry.src && (
        <div className="overflow-hidden rounded-lg border border-border">
          <img
            src={buildMediaUrl(`/api/admin/director/files/${encodeURIComponent(entry.src.split("/").pop() ?? "")}`)}
            alt="Scene"
            className="w-full object-cover"
          />
        </div>
      )}

      {/* Video preview (video_clip with source) — trimmed & cropped for Shorts */}
      {!entry.src && entry.source && (
        <VideoClipPreview
          source={entry.source}
          trimStartFrame={typeof entry.trimStart === "number" ? entry.trimStart : 0}
          durationFrames={dur}
          fps={fps}
          isVertical={manifest?.composition?.height === 1920}
          horizontalCropOffset={typeof entry.horizontalCropOffset === "number" ? entry.horizontalCropOffset : 50}
          fitMode={(entry.fitMode as "cover" | "contain") ?? "cover"}
        />
      )}

      {/* Background image preview (intro/outro cards) */}
      {isCardWithBackground && backgroundSrc && (
        <div className="overflow-hidden rounded-lg border border-border">
          <img
            src={buildMediaUrl(`/api/admin/director/files/${encodeURIComponent(backgroundSrc.split("/").pop() ?? "")}`)}
            alt="Background"
            className="w-full object-cover"
          />
        </div>
      )}

      {/* Timing */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1.5">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10px] text-muted-foreground">Start</p>
            <p className="text-xs font-medium">{startSec}s</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1.5">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10px] text-muted-foreground">Duration</p>
            <p className="text-xs font-medium">{durSec}s</p>
          </div>
        </div>
      </div>

      {/* Title (for title/intro/outro cards) */}
      {entry.title && (
        <div className="flex items-start gap-1.5">
          <Type className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10px] text-muted-foreground">Title</p>
            <p className="text-xs">{entry.title}</p>
          </div>
        </div>
      )}

      {/* Narration Editor (inline script editing with autocomplete) */}
      {hasScript && (
        <NarrationEditor
          value={scriptText}
          onChange={setScriptText}
          onSave={handleScriptSave}
          directives={narrationDirectives}
          voices={voicePresets}
        />
      )}

      {/* Voice Lab — per-scene re-record with engine selection */}
      {hasScript && entry?.voiceover && (
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-[11px] font-semibold text-foreground">Voice Lab</p>
          </div>

          {/* Current voiceover preview */}
          <div className="mb-3 flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
            <button
              onClick={toggleVoicePreview}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition"
            >
              {voicePreviewPlaying ? (
                <Pause className="h-3 w-3" />
              ) : (
                <Play className="h-3 w-3 ml-0.5" />
              )}
            </button>
            <span className="truncate text-[10px] text-muted-foreground">
              {(entry.voiceover as string).split("/").pop()}
            </span>
            <audio
              ref={voicePreviewRef}
              src={buildMediaUrl(`/api/admin/director/files/${encodeURIComponent((entry.voiceover as string).split("/").pop() ?? "")}`)}
              preload="auto"
              onEnded={() => setVoicePreviewPlaying(false)}
            />
          </div>

          {/* Engine selector */}
          <div className="mb-2">
            <label className="mb-1 block text-[10px] text-muted-foreground">Voice Engine</label>
            <select
              value={selectedEngine}
              onChange={(e) => setSelectedEngine(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="auto">Auto (best available)</option>
              {voiceEngines.map((eng) => (
                <option key={eng.id} value={eng.id} disabled={!eng.available}>
                  {eng.name}{eng.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          </div>

          {/* F5-TTS controls */}
          {selectedEngine === "f5tts" && (
            <div className="mb-3 space-y-2 rounded-md border border-border/50 bg-muted/30 p-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium text-muted-foreground">F5-TTS Settings</p>
                <button
                  onClick={handleSuggestF5Params}
                  disabled={suggestingParams || !scriptText.trim()}
                  className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50 transition"
                >
                  {suggestingParams ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-2.5 w-2.5" />
                  )}
                  AI Suggest
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Speed</label>
                  <span className="text-[10px] tabular-nums text-foreground">{f5Params.speed.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={f5Params.speed}
                  onChange={(e) => setF5Params((p) => ({ ...p, speed: parseFloat(e.target.value) }))}
                  className="w-full accent-primary"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Steps</label>
                  <span className="text-[10px] tabular-nums text-foreground">{f5Params.steps}</span>
                </div>
                <input
                  type="range"
                  min="4"
                  max="32"
                  step="1"
                  value={f5Params.steps}
                  onChange={(e) => setF5Params((p) => ({ ...p, steps: parseInt(e.target.value) }))}
                  className="w-full accent-primary"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">CFG Strength</label>
                  <span className="text-[10px] tabular-nums text-foreground">{f5Params.cfgStrength.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="5.0"
                  step="0.1"
                  value={f5Params.cfgStrength}
                  onChange={(e) => setF5Params((p) => ({ ...p, cfgStrength: parseFloat(e.target.value) }))}
                  className="w-full accent-primary"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Sway Coefficient</label>
                  <span className="text-[10px] tabular-nums text-foreground">{f5Params.swayCoef.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="-3.0"
                  max="3.0"
                  step="0.1"
                  value={f5Params.swayCoef}
                  onChange={(e) => setF5Params((p) => ({ ...p, swayCoef: parseFloat(e.target.value) }))}
                  className="w-full accent-primary"
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">Method</label>
                <select
                  value={f5Params.method}
                  onChange={(e) => setF5Params((p) => ({ ...p, method: e.target.value as "euler" | "midpoint" | "rk4" }))}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="rk4">RK4 (highest quality)</option>
                  <option value="midpoint">Midpoint</option>
                  <option value="euler">Euler (fastest)</option>
                </select>
              </div>
            </div>
          )}

          {/* AI Directives button */}
          <button
            onClick={handleAddDirectives}
            disabled={addingDirectives || !scriptText.trim()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition disabled:opacity-50"
          >
            {addingDirectives ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Adding directives…
              </>
            ) : (
              <>
                <Wand2 className="h-3.5 w-3.5" />
                AI Directives
              </>
            )}
          </button>

          {/* Re-record button */}
          <button
            onClick={handleReRecord}
            disabled={reRecording || !scriptText.trim()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
          >
            {reRecording ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Re-recording…
              </>
            ) : (
              <>
                <Mic className="h-3.5 w-3.5" />
                Re-record Voiceover
              </>
            )}
          </button>
        </div>
      )}

      {/* Script rewrite offer (shown after video replacement) */}
      {showRewriteOffer && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
          <p className="mb-2 text-[11px] font-medium text-foreground">
            Video replaced — rewrite narration?
          </p>
          <p className="mb-2 text-[10px] text-muted-foreground">
            The visual was swapped with a video{lastVideoDuration ? ` (${lastVideoDuration.toFixed(1)}s)` : ""}.
            Rewrite the script to match?
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleRewriteScript}
              disabled={rewritingScript}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
            >
              {rewritingScript ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PenLine className="h-3.5 w-3.5" />
              )}
              Rewrite
            </button>
            <button
              onClick={() => setShowRewriteOffer(false)}
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* Regenerate image */}
      {isVisualScene && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-[11px] font-medium text-foreground">Regenerate Image</p>

          {/* Model selector */}
          <div className="mb-2">
            <label className="mb-1 block text-[10px] text-muted-foreground">Flux Model</label>
            <select
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value as "flux-schnell" | "flux-dev")}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="flux-schnell">Flux Schnell (fast, 4 steps)</option>
              <option value="flux-dev">Flux Dev (high quality, 25 steps)</option>
            </select>
          </div>

          <div className="mb-1 flex items-center justify-between">
            <label className="text-[10px] text-muted-foreground">Prompt</label>
            <button
              onClick={handleEnhancePrompt}
              disabled={enhancingPrompt || !editPrompt.trim()}
              className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50 transition"
            >
              {enhancingPrompt ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Sparkles className="h-2.5 w-2.5" />
              )}
              AI Enhance
            </button>
          </div>
          <textarea
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            placeholder="Enter a new image prompt…"
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleRegenerate}
            disabled={regenerating || !editPrompt.trim()}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
          >
            {regenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Regenerate
          </button>
        </div>
      )}

      {/* Enhance existing image (img2img) */}
      {isVisualScene && entry.src && (
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-[11px] font-medium text-foreground">Enhance / Modify Image</p>
          </div>
          <p className="mb-2 text-[10px] text-muted-foreground">
            Modify the current image using img2img. Describe what to change or enhance.
          </p>
          <textarea
            value={img2imgPrompt}
            onChange={(e) => setImg2imgPrompt(e.target.value)}
            placeholder="e.g. Add dramatic lighting, make colors more vibrant…"
            rows={2}
            className="mb-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="mb-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-muted-foreground">Strength</label>
              <span className="text-[10px] tabular-nums text-foreground">{img2imgStrength.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="0.95"
              step="0.05"
              value={img2imgStrength}
              onChange={(e) => setImg2imgStrength(parseFloat(e.target.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-[9px] text-muted-foreground">
              <span>Subtle</span>
              <span>Strong</span>
            </div>
          </div>
          <button
            onClick={handleImg2Img}
            disabled={enhancingImage || !img2imgPrompt.trim()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
          >
            {enhancingImage ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Enhancing…
              </>
            ) : (
              <>
                <Wand2 className="h-3.5 w-3.5" />
                Enhance Image
              </>
            )}
          </button>
        </div>
      )}

      {/* Rewrite Script (standalone, for any scene) */}
      {isVisualScene && entry.scriptText && !showRewriteOffer && (
        <div className="rounded-lg border border-border p-3">
          <button
            onClick={handleRewriteScript}
            disabled={rewritingScript}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition disabled:opacity-50"
          >
            {rewritingScript ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PenLine className="h-3.5 w-3.5" />
            )}
            Rewrite Script
          </button>
        </div>
      )}

      {/* Background Image Upload (Intro/Outro cards) */}
      {isCardWithBackground && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-[11px] font-medium text-foreground">
            {backgroundSrc ? "Replace Background" : "Add Background Image"}
          </p>
          <input
            ref={bgFileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleBackgroundUpload(file);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => bgFileInputRef.current?.click()}
            disabled={uploadingBackground}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition disabled:opacity-50"
          >
            {uploadingBackground ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {backgroundSrc ? "Upload New Background" : "Upload Background"}
          </button>
        </div>
      )}

      {/* Replace with Upload (visual scenes BYOA) */}
      {isVisualScene && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-1 text-[11px] font-medium text-foreground">Replace Scene Visual</p>
          <p className="mb-2 text-[10px] text-muted-foreground">
            Upload a new image or video to replace Scene {inspector.sceneIndex !== null ? inspector.sceneIndex + 1 : "—"}&apos;s visual.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || inspector.sceneIndex === null || !manifest) return;
              setUploading(true);
              try {
                const isVideo = file.type.startsWith("video/");
                const kind = isVideo ? "video" : "image";
                const result = await fetchJson<UploadResult>(
                  `/api/admin/director/files/upload-asset?kind=${kind}`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": file.type || "application/octet-stream",
                      "x-file-name": encodeURIComponent(file.name),
                    },
                    body: file,
                  },
                );

                const updated = { ...manifest, timeline: [...(manifest.timeline ?? [])] };
                const visualTypes = new Set(["image_scene", "video_clip"]);
                let sceneCount = 0;
                for (let i = 0; i < updated.timeline.length; i++) {
                  if (visualTypes.has(updated.timeline[i].type)) {
                    if (sceneCount === inspector.sceneIndex) {
                      if (isVideo) {
                        // Promote image_scene → video_clip with probed duration
                        const videoDur = result.videoInfo?.durationSec;
                        const durationFrames = videoDur ? Math.round(videoDur * fps) : updated.timeline[i].duration;
                        updated.timeline[i] = {
                          ...updated.timeline[i],
                          type: "video_clip",
                          source: result.filePath,
                          src: result.filePath,
                          trimStart: 0,
                          volume: 0,
                          duration: durationFrames,
                        };
                        // Store duration for script rewrite offer
                        setLastVideoDuration(videoDur ?? null);
                        setShowRewriteOffer(true);
                      } else {
                        updated.timeline[i] = { ...updated.timeline[i], src: result.filePath };
                      }
                      break;
                    }
                    sceneCount++;
                  }
                }
                onManifestUpdate(updated);
                // Persist to draft
                await fetchJson(`/api/admin/director/drafts/${draftId}`, {
                  method: "PUT",
                  body: JSON.stringify({ manifest: updated }),
                });
              } catch (err) {
                console.error("Upload replacement failed:", err);
              } finally {
                setUploading(false);
                e.target.value = "";
              }
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload Replacement Image/Video
          </button>
        </div>
      )}

      {/* 9:16 Framing Panel (Shorts) */}
      {entry.type === "video_clip" && manifest?.composition?.height === 1920 && (
        <FramingPanel
          offset={typeof entry.horizontalCropOffset === "number" ? entry.horizontalCropOffset : 50}
          onChange={(offset) => {
            updateTimelineEntry((e) => ({ ...e, horizontalCropOffset: offset }));
          }}
          fitMode={(entry.fitMode as "cover" | "contain") ?? "cover"}
          onFitModeChange={(mode) => {
            updateTimelineEntry((e) => ({ ...e, fitMode: mode }));
          }}
        />
      )}
    </div>
  );
}

/**
 * Trimmed, cropped video preview for the Scene Inspector.
 * Shows only the viral-clip segment (trimStart → trimStart + duration)
 * and applies 9:16 vertical crop when the composition is vertical.
 */
function VideoClipPreview({
  source,
  trimStartFrame,
  durationFrames,
  fps,
  isVertical,
  horizontalCropOffset,
  fitMode = "cover",
}: {
  source: string;
  trimStartFrame: number;
  durationFrames: number;
  fps: number;
  isVertical: boolean;
  horizontalCropOffset: number;
  fitMode?: "cover" | "contain";
}) {
  const vidRef = useRef<HTMLVideoElement>(null);
  const trimStartSec = trimStartFrame / fps;
  const durationSec = durationFrames / fps;

  const handleLoaded = useCallback(
    (e: SyntheticEvent<HTMLVideoElement>) => {
      e.currentTarget.currentTime = trimStartSec;
    },
    [trimStartSec],
  );

  // Clamp playback to trimmed range
  useEffect(() => {
    const vid = vidRef.current;
    if (!vid) return;
    const endSec = trimStartSec + durationSec;
    const onTimeUpdate = () => {
      if (vid.currentTime >= endSec) {
        vid.pause();
        vid.currentTime = trimStartSec;
      }
    };
    vid.addEventListener("timeupdate", onTimeUpdate);
    return () => vid.removeEventListener("timeupdate", onTimeUpdate);
  }, [trimStartSec, durationSec]);

  const fileName = String(source).split("/").pop() ?? "";

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div
        className="relative mx-auto overflow-hidden bg-black"
        style={isVertical ? { aspectRatio: "9/16", maxHeight: 320, width: "auto" } : undefined}
      >
        <video
          ref={vidRef}
          src={buildMediaUrl(`/api/admin/director/files/${encodeURIComponent(fileName)}`)}
          className="h-full w-full"
          style={
            isVertical
              ? fitMode === "contain"
                ? { objectFit: "contain", backgroundColor: "#000" }
                : { objectFit: "cover", objectPosition: `${horizontalCropOffset}% center` }
              : { objectFit: "contain" }
          }
          muted
          playsInline
          controls
          onLoadedMetadata={handleLoaded}
        />
      </div>
      <div className="flex items-center justify-between bg-muted/50 px-2 py-1">
        <span className="truncate text-[10px] text-muted-foreground">{fileName}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {trimStartSec.toFixed(1)}s – {(trimStartSec + durationSec).toFixed(1)}s
        </span>
      </div>
    </div>
  );
}
