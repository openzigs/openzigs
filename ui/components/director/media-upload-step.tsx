"use client";

import { useState, useCallback } from "react";
import { Upload, X, FileVideo, FileText, FolderOpen, Plus } from "lucide-react";
import type { MediaFile, ProductionMode } from "./types";

interface MediaUploadStepProps {
  mode: ProductionMode;
  clips: MediaFile[];
  scriptFile: MediaFile | null;
  onClipsChange: (clips: MediaFile[]) => void;
  onScriptChange: (file: MediaFile | null) => void;
}

export const MediaUploadStep = ({
  mode,
  clips,
  scriptFile,
  onClipsChange,
  onScriptChange,
}: MediaUploadStepProps) => {
  const [pathInput, setPathInput] = useState("");

  const addClipByPath = useCallback(() => {
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    if (clips.some((c) => c.path === trimmed)) return;

    const name = trimmed.split("/").pop() ?? trimmed;
    onClipsChange([
      ...clips,
      { name, path: trimmed, size: 0, type: "video/*" },
    ]);
    setPathInput("");
  }, [pathInput, clips, onClipsChange]);

  const addScriptByPath = useCallback(() => {
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    const name = trimmed.split("/").pop() ?? trimmed;
    onScriptChange({ name, path: trimmed, size: 0, type: "text/plain" });
    setPathInput("");
  }, [pathInput, onScriptChange]);

  const removeClip = useCallback(
    (index: number) => {
      onClipsChange(clips.filter((_, i) => i !== index));
    },
    [clips, onClipsChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addClipByPath();
    }
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground mb-1">
          {mode === "highlight" ? "Add Video Clips" : "Add B-Roll & Script"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {mode === "highlight"
            ? "Add your raw video clips. The AI will analyze, reorder, and edit them into a highlight reel."
            : "Add B-Roll footage and your script file. A voiceover will be generated and visuals aligned to narration."}
        </p>
      </div>

      {/* Path Input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter file path (e.g. ~/Videos/clip1.mp4)"
            className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-border bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <button
          onClick={addClipByPath}
          disabled={!pathInput.trim()}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Clip
        </button>
        {mode === "script" && (
          <button
            onClick={addScriptByPath}
            disabled={!pathInput.trim()}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FileText className="h-3.5 w-3.5" />
            Set Script
          </button>
        )}
      </div>

      {/* Drop Zone */}
      <div
        className="relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted/30 px-6 py-12 transition-colors hover:border-primary/50 hover:bg-muted/50"
      >
        <Upload className="h-8 w-8 text-muted-foreground mb-3" />
        <p className="text-sm font-medium text-foreground">Paste file paths above</p>
        <p className="text-xs text-muted-foreground mt-1">
          Supports .mp4, .mov, .avi, .mkv, .webm video files
        </p>
      </div>

      {/* Clips List */}
      {clips.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              Video Clips ({clips.length})
            </h3>
            {clips.length > 1 && (
              <button
                onClick={() => onClipsChange([])}
                className="text-xs text-muted-foreground hover:text-destructive transition"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {clips.map((clip, index) => (
              <div
                key={clip.path}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 group"
              >
                <FileVideo className="h-4 w-4 text-violet-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{clip.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{clip.path}</p>
                </div>
                <button
                  onClick={() => removeClip(index)}
                  className="p-1 rounded-lg text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Script File (Mode B only) */}
      {mode === "script" && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">Script File</h3>
          {scriptFile ? (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5">
              <FileText className="h-4 w-4 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{scriptFile.name}</p>
                <p className="text-xs text-muted-foreground truncate">{scriptFile.path}</p>
              </div>
              <button
                onClick={() => onScriptChange(null)}
                className="p-1 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-3 text-center">
              <p className="text-xs text-muted-foreground">
                No script file set. Use the input above and click &quot;Set Script&quot;.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
