"use client";

import { useState, useCallback, useRef, type ChangeEvent } from "react";
import { Upload, X, FileVideo, FileText, FolderOpen, Plus, Loader2, BookOpen } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { MediaFile, ProductionMode } from "./types";

interface MediaUploadStepProps {
  mode: ProductionMode;
  clips: MediaFile[];
  scriptFile: MediaFile | null;
  topic: string;
  sourceFiles: MediaFile[];
  onClipsChange: (clips: MediaFile[]) => void;
  onScriptChange: (file: MediaFile | null) => void;
  onTopicChange: (topic: string) => void;
  onSourceFilesChange: (files: MediaFile[]) => void;
}

export const MediaUploadStep = ({
  mode,
  clips,
  scriptFile,
  topic,
  sourceFiles,
  onClipsChange,
  onScriptChange,
  onTopicChange,
  onSourceFilesChange,
}: MediaUploadStepProps) => {
  const [pathInput, setPathInput] = useState("");
  const [sourcePathInput, setSourcePathInput] = useState("");
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [uploadingScript, setUploadingScript] = useState(false);
  const [uploadingSource, setUploadingSource] = useState(false);
  const clipInputRef = useRef<HTMLInputElement>(null);
  const scriptInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(async (file: File, kind: "video" | "script"): Promise<MediaFile> => {
    const result = await fetchJson<{
      filePath: string;
      fileName: string;
      size: number;
      mimeType: string;
    }>(`/api/admin/director/files/upload?kind=${kind}`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
        "x-file-type": file.type || "application/octet-stream",
      },
      body: file,
    });

    return {
      name: file.name,
      path: result.filePath,
      size: result.size,
      type: result.mimeType,
    };
  }, []);

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

  // ── Source document helpers (Presentation mode) ───────────
  const addSourceByPath = useCallback(() => {
    const trimmed = sourcePathInput.trim();
    if (!trimmed) return;

    const name = trimmed.split("/").pop() ?? trimmed;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = ext === "md" || ext === "markdown" ? "text/markdown" : "text/plain";
    const nextFile = { name, path: trimmed, size: 0, type: mimeType };
    if (sourceFiles.length > 0 && sourceFiles[0]?.path !== trimmed) {
      showToast("Replaced existing source document", "success");
    }
    onSourceFilesChange([nextFile]);
    setSourcePathInput("");
  }, [sourcePathInput, sourceFiles, onSourceFilesChange, showToast]);

  const handleSourceKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSourceByPath();
    }
  };

  const onSourceFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploadingSource(true);
    try {
      const file = files[0];
      const uploaded = await uploadFile(file, "script"); // reuse script upload kind for text files
      onSourceFilesChange([
        { ...uploaded, type: file.name.endsWith(".md") ? "text/markdown" : "text/plain" },
      ]);
      showToast("Source file uploaded", "success");
    } catch {
      showToast("Failed to upload source file(s)", "error");
    } finally {
      setUploadingSource(false);
      if (sourceInputRef.current) sourceInputRef.current.value = "";
    }
  }, [onSourceFilesChange, uploadFile, showToast]);

  const removeSourceFile = useCallback(
    (index: number) => {
      onSourceFilesChange(sourceFiles.filter((_, i) => i !== index));
    },
    [sourceFiles, onSourceFilesChange],
  );

  const onClipFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploadingVideo(true);
    try {
      const nextClips = [...clips];
      for (const file of Array.from(files)) {
        const uploaded = await uploadFile(file, "video");
        if (!nextClips.some((c) => c.path === uploaded.path)) {
          nextClips.push(uploaded);
        }
      }
      onClipsChange(nextClips);
      showToast(`Added ${files.length} video file${files.length === 1 ? "" : "s"}`, "success");
    } catch {
      showToast("Failed to upload one or more video files", "error");
    } finally {
      setUploadingVideo(false);
      if (clipInputRef.current) clipInputRef.current.value = "";
    }
  }, [clips, onClipsChange, uploadFile]);

  const onScriptFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingScript(true);
    try {
      const uploaded = await uploadFile(file, "script");
      onScriptChange({ ...uploaded, type: "text/plain" });
      showToast("Script file uploaded", "success");
    } catch {
      showToast("Failed to upload script file", "error");
    } finally {
      setUploadingScript(false);
      if (scriptInputRef.current) scriptInputRef.current.value = "";
    }
  }, [onScriptChange, uploadFile]);

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground mb-1">
          {mode === "presentation" ? "Source Document & Style" : mode === "highlight" ? "Add Video Clips" : "Add B-Roll & Script"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {mode === "presentation"
            ? "Add your source document and optionally describe the style. The AI will transform it into a narrated presentation with generated visuals."
            : mode === "highlight"
              ? "Add your raw video clips. The AI will analyze, reorder, and edit them into a highlight reel."
              : "Add B-Roll footage and your script file. A voiceover will be generated and visuals aligned to narration."}
        </p>
      </div>

      {mode === "presentation" ? (
        /* ── Presentation Mode: Source Document + Style Instructions ── */
        <div className="space-y-6">
          {/* ── Source Document Input ─────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Source Document</h3>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">
              Add a <code className="bg-muted px-1 rounded">.txt</code> or <code className="bg-muted px-1 rounded">.md</code> file.
              The AI will read it and generate a visual storyboard with images, narration, and animations.
            </p>

            {/* Path input + buttons */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  value={sourcePathInput}
                  onChange={(e) => setSourcePathInput(e.target.value)}
                  onKeyDown={handleSourceKeyDown}
                  placeholder="Enter file path (e.g. ~/Documents/my-doc.md)"
                  className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-border bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <button
                onClick={addSourceByPath}
                disabled={!sourcePathInput.trim()}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
              <button
                onClick={() => sourceInputRef.current?.click()}
                disabled={uploadingSource}
                className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {uploadingSource ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Choose File
              </button>
            </div>

            {/* Hidden file input */}
            <input
              ref={sourceInputRef}
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              onChange={onSourceFileChange}
              className="hidden"
            />

            {/* Source files list */}
            {sourceFiles.length > 0 ? (
              <div className="space-y-1.5">
                {sourceFiles.map((file, index) => (
                  <div
                    key={file.path}
                    className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5 group"
                  >
                    <FileText className="h-4 w-4 text-emerald-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{file.path}</p>
                    </div>
                    <button
                      onClick={() => removeSourceFile(index)}
                      className="p-1 rounded-lg text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center">
                <FileText className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">
                  No source file added yet. Enter a path above or use the file picker.
                </p>
              </div>
            )}
          </div>

          {/* ── Style & Instructions (preamble) ──────────────── */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Style &amp; Instructions <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <textarea
              value={topic}
              onChange={(e) => onTopicChange(e.target.value)}
              placeholder="e.g., Create a professional dark-themed presentation with clean vector illustrations. Target audience: engineering leadership. Tone: authoritative but approachable."
              rows={3}
              className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
            />
            <p className="text-[11px] text-muted-foreground/60">
              This preamble guides the AI&apos;s tone, visual style, and audience targeting when building the storyboard.
            </p>
          </div>

          {/* Pipeline info */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
            <p className="text-xs text-amber-400 font-medium mb-1">What happens next</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>&bull; The LLM reads your document and creates a structured storyboard with scenes, narration, and visual descriptions</li>
              <li>&bull; Stable Diffusion generates an image for each scene</li>
              <li>&bull; Text-to-Speech synthesizes per-scene voiceover</li>
              <li>&bull; Ken Burns animations and crossfade transitions are applied automatically</li>
            </ul>
          </div>
        </div>
      ) : (
        /* ── Highlight / Script Mode: File Inputs ───────────── */
        <>
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
        <button
          onClick={() => clipInputRef.current?.click()}
          disabled={uploadingVideo}
          className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {uploadingVideo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Choose Video
        </button>
        {mode === "script" && (
          <>
            <button
              onClick={addScriptByPath}
              disabled={!pathInput.trim()}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FileText className="h-3.5 w-3.5" />
              Set Script
            </button>
            <button
              onClick={() => scriptInputRef.current?.click()}
              disabled={uploadingScript}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {uploadingScript ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
              Choose Script
            </button>
          </>
        )}
      </div>

      <input
        ref={clipInputRef}
        type="file"
        accept="video/*"
        multiple
        onChange={onClipFileChange}
        className="hidden"
      />

      <input
        ref={scriptInputRef}
        type="file"
        accept=".txt,.md,.rtf,.srt,text/plain"
        onChange={onScriptFileChange}
        className="hidden"
      />

      {/* Drop Zone */}
      <div
        className="relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted/30 px-6 py-12 transition-colors hover:border-primary/50 hover:bg-muted/50"
      >
        <Upload className="h-8 w-8 text-muted-foreground mb-3" />
        <p className="text-sm font-medium text-foreground">Paste file paths or choose files above</p>
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
      </>
      )}
    </div>
  );
};
