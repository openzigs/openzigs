"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Scissors, Upload, Loader2, Play, ExternalLink, Film } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

type ShortStyle = "react" | "summarize" | "highlight";
type SourceMode = "renders" | "upload";

const STYLE_OPTIONS: { value: ShortStyle; label: string; description: string }[] = [
  { value: "highlight", label: "Highlight Reel", description: "Extract the most viral-worthy moments" },
  { value: "react", label: "React Style", description: "Commentary-driven reaction format" },
  { value: "summarize", label: "Summary", description: "Condense the video into a quick recap" },
];

interface CompletedRender {
  draftId: string;
  draftTitle: string;
  productionMode: string | null;
  quality: string | null;
  status: string | null;
  outputPath: string | null;
  updatedAt: string;
}

interface ShortsResult {
  draftId: string;
  scriptText: string;
  processingTimeMs: number;
}

export function ShortsPanel() {
  const [sourceMode, setSourceMode] = useState<SourceMode>("renders");
  const [sourceVideo, setSourceVideo] = useState("");
  const [selectedRender, setSelectedRender] = useState<CompletedRender | null>(null);
  const [renders, setRenders] = useState<CompletedRender[]>([]);
  const [rendersLoading, setRendersLoading] = useState(false);
  const [style, setStyle] = useState<ShortStyle>("highlight");
  const [targetDuration, setTargetDuration] = useState(45);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<ShortsResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRendersLoading(true);
    fetchJson<{ renders: CompletedRender[] }>("/api/admin/director/renders")
      .then((data) => {
        setRenders(data.renders);
      })
      .catch(() => {
        // silently fall back to upload mode if renders can't be fetched
      })
      .finally(() => setRendersLoading(false));
  }, []);

  const handleFileUpload = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/admin/director/upload", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as { path?: string };
      if (data.path) {
        setSourceVideo(data.path);
        showToast(`Uploaded: ${file.name}`, "success");
      }
    } catch {
      showToast("Upload failed", "error");
    }
  }, []);

  const effectiveSource = sourceMode === "renders" ? (selectedRender?.outputPath ?? "") : sourceVideo;

  const handleGenerate = useCallback(async () => {
    if (!effectiveSource.trim()) {
      showToast(sourceMode === "renders" ? "Please select a render" : "Please provide a source video", "error");
      return;
    }
    setGenerating(true);
    setResult(null);
    try {
      const res = await fetchJson<ShortsResult>("/api/admin/director/shorts", {
        method: "POST",
        body: JSON.stringify({ sourceVideo: effectiveSource, style, targetDuration }),
      });
      setResult(res);
      showToast("Short created!", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create short", "error");
    } finally {
      setGenerating(false);
    }
  }, [effectiveSource, sourceMode, style, targetDuration]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">YouTube Shorts Generator</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Convert a long-form video into a vertical YouTube Short (15–60s).
        </p>
      </div>

      {/* Source video */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-foreground">Source Video</label>

        {/* Mode tabs */}
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          <button
            onClick={() => setSourceMode("renders")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 transition ${
              sourceMode === "renders"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Film className="h-3.5 w-3.5" />
            My Renders
          </button>
          <button
            onClick={() => setSourceMode("upload")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 transition border-l border-border ${
              sourceMode === "upload"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            Upload
          </button>
        </div>

        {sourceMode === "renders" ? (
          <div className="space-y-1.5">
            {rendersLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading renders...
              </div>
            ) : renders.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3">
                No presentations found. Create a presentation in the Video Wizard first.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-52 overflow-y-auto">
                {renders.map((r) => {
                  const hasRender = !!r.outputPath;
                  return (
                    <button
                      key={r.draftId}
                      onClick={() => hasRender && setSelectedRender(r)}
                      disabled={!hasRender}
                      className={`w-full text-left rounded-md border px-3 py-2.5 transition ${
                        selectedRender?.draftId === r.draftId
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : hasRender
                          ? "border-border hover:border-muted-foreground/40"
                          : "border-border opacity-50 cursor-not-allowed"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground truncate">{r.draftTitle}</span>
                        {hasRender ? (
                          <span className="text-[10px] text-green-500 shrink-0">Ready</span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground shrink-0">Render first</span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {new Date(r.updatedAt).toLocaleDateString()}
                        {r.quality && ` · ${r.quality}`}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={sourceVideo}
              onChange={(e) => setSourceVideo(e.target.value)}
              placeholder="/path/to/video.mp4 or upload..."
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileUpload(f);
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition"
            >
              <Upload className="h-4 w-4" />
              Upload
            </button>
          </div>
        )}
      </div>

      {/* Style */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">Style</label>
        <div className="grid grid-cols-3 gap-2">
          {STYLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStyle(opt.value)}
              className={`rounded-lg border p-3 text-left transition ${
                style === opt.value
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <p className="text-sm font-medium text-foreground">{opt.label}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{opt.description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Duration */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">
          Target Duration: {targetDuration}s
        </label>
        <input
          type="range"
          min={15}
          max={60}
          step={5}
          value={targetDuration}
          onChange={(e) => setTargetDuration(Number(e.target.value))}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>15s</span>
          <span>30s</span>
          <span>45s</span>
          <span>60s</span>
        </div>
      </div>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={generating || !effectiveSource.trim()}
        className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
      >
        {generating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating Short...
          </>
        ) : (
          <>
            <Scissors className="h-4 w-4" />
            Generate Short
          </>
        )}
      </button>

      {/* Result */}
      {result && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">Short Created</h3>
            <span className="text-[10px] text-muted-foreground">
              {(result.processingTimeMs / 1000).toFixed(1)}s
            </span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-3">{result.scriptText}</p>
          <a
            href={`/director/studio/${result.draftId}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition"
          >
            <Play className="h-3.5 w-3.5" />
            Open in Studio
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}
