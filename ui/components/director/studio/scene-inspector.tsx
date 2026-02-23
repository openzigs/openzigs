"use client";

import { useState, useCallback, useRef, useEffect, type SyntheticEvent } from "react";
import { RefreshCw, Loader2, Image, Clock, Type, Upload, PenLine } from "lucide-react";
import { fetchJson } from "@/lib/api";
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

export function SceneInspector({ inspector, manifest, draftId, onManifestUpdate }: SceneInspectorProps) {
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bgFileInputRef = useRef<HTMLInputElement>(null);
  const fps = manifest?.composition?.fps ?? 30;

  const entry = inspector.entry;

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

  const handleRegenerate = useCallback(async () => {
    if (inspector.sceneIndex === null || !editPrompt.trim() || !manifest) return;
    setRegenerating(true);
    try {
      const result = await fetchJson<{ sceneIndex: number; imagePath: string }>(
        `/api/admin/director/scenes/${inspector.sceneIndex}/regenerate`,
        {
          method: "POST",
          body: JSON.stringify({ draftId, prompt: editPrompt }),
        },
      );

      updateTimelineEntry((e) => ({ ...e, src: result.imagePath }));
    } catch (err) {
      console.error("Scene regeneration failed:", err);
    } finally {
      setRegenerating(false);
    }
  }, [inspector.sceneIndex, editPrompt, draftId, manifest, updateTimelineEntry]);

  const handleRewriteScript = useCallback(async () => {
    if (inspector.sceneIndex === null || !manifest) return;
    setRewritingScript(true);
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
      setRewritingScript(false);
    }
  }, [inspector.sceneIndex, manifest, draftId, lastVideoDuration, entry?.scriptText, updateTimelineEntry]);

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
            src={`/api/admin/director/files/${encodeURIComponent(entry.src.split("/").pop() ?? "")}`}
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
            src={`/api/admin/director/files/${encodeURIComponent(backgroundSrc.split("/").pop() ?? "")}`}
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
          src={`/api/admin/director/files/${encodeURIComponent(fileName)}`}
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
