"use client";

import { useState, useCallback, useRef } from "react";
import { RefreshCw, Loader2, Image, Clock, Type, Mic, Upload } from "lucide-react";
import { fetchJson } from "@/lib/api";
import type { InspectorState, DirectorManifest } from "../types";
import { FramingPanel } from "./framing-panel";

interface SceneInspectorProps {
  inspector: InspectorState;
  manifest: DirectorManifest | null;
  draftId: string;
  onManifestUpdate: (manifest: DirectorManifest) => void;
}

export function SceneInspector({ inspector, manifest, draftId, onManifestUpdate }: SceneInspectorProps) {
  const [editPrompt, setEditPrompt] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fps = manifest?.composition.fps ?? 30;

  const entry = inspector.entry;

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

      // Update the manifest locally with the new image path
      const updated = { ...manifest, timeline: [...manifest.timeline] };
      const visualTypes = new Set(["image_scene", "video_clip"]);
      let sceneCount = 0;
      for (let i = 0; i < updated.timeline.length; i++) {
        if (visualTypes.has(updated.timeline[i].type)) {
          if (sceneCount === inspector.sceneIndex) {
            updated.timeline[i] = { ...updated.timeline[i], src: result.imagePath };
            break;
          }
          sceneCount++;
        }
      }
      onManifestUpdate(updated);
    } catch (err) {
      console.error("Scene regeneration failed:", err);
    } finally {
      setRegenerating(false);
    }
  }, [inspector.sceneIndex, editPrompt, draftId, manifest, onManifestUpdate]);

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

      {/* Image preview */}
      {entry.src && (
        <div className="overflow-hidden rounded-lg border border-border">
          <img
            src={`/api/admin/director/files/${encodeURIComponent(entry.src.split("/").pop() ?? "")}`}
            alt="Scene"
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

      {/* Voiceover / Script text */}
      {(entry.scriptText || entry.voiceover) && (
        <div className="flex items-start gap-1.5">
          <Mic className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10px] text-muted-foreground">Narration</p>
            <p className="text-xs leading-relaxed">{entry.scriptText ?? "Audio attached"}</p>
          </div>
        </div>
      )}

      {/* Regenerate image */}
      {(entry.type === "image_scene" || entry.type === "video_clip") && (
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

      {/* Replace with Upload (BYOA) */}
      {(entry.type === "image_scene" || entry.type === "video_clip") && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-[11px] font-medium text-foreground">Replace with Upload</p>
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
                const kind = file.type.startsWith("video/") ? "video" : "image";
                const result = await fetchJson<{ filePath: string }>(
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

                // Update manifest with the new file path
                const updated = { ...manifest, timeline: [...manifest.timeline] };
                const visualTypes = new Set(["image_scene", "video_clip"]);
                let sceneCount = 0;
                for (let i = 0; i < updated.timeline.length; i++) {
                  if (visualTypes.has(updated.timeline[i].type)) {
                    if (sceneCount === inspector.sceneIndex) {
                      updated.timeline[i] = { ...updated.timeline[i], src: result.filePath };
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
            Upload Replacement
          </button>
        </div>
      )}

      {/* 9:16 Framing Panel (Shorts) */}
      {entry.type === "video_clip" && manifest?.composition?.height === 1920 && (
        <FramingPanel
          offset={typeof entry.horizontalCropOffset === "number" ? entry.horizontalCropOffset : 50}
          onChange={(offset) => {
            if (inspector.sceneIndex === null || !manifest) return;
            const updated = { ...manifest, timeline: [...manifest.timeline] };
            const visualTypes = new Set(["image_scene", "video_clip"]);
            let sceneCount = 0;
            for (let i = 0; i < updated.timeline.length; i++) {
              if (visualTypes.has(updated.timeline[i].type)) {
                if (sceneCount === inspector.sceneIndex) {
                  updated.timeline[i] = { ...updated.timeline[i], horizontalCropOffset: offset };
                  break;
                }
                sceneCount++;
              }
            }
            onManifestUpdate(updated);
            // Debounced persist is handled by parent on save
          }}
        />
      )}
    </div>
  );
}
