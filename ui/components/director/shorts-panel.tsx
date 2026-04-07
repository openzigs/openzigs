"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Scissors,
  Upload,
  Loader2,
  Sparkles,
  ArrowRight,
  Film,
} from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

type SourceMode = "renders" | "upload";

interface CompletedRender {
  draftId: string;
  draftTitle: string;
  productionMode: string | null;
  quality: string | null;
  status: string | null;
  outputPath: string | null;
  updatedAt: string;
}

export function ShortsPanel() {
  const router = useRouter();
  const [sourceMode, setSourceMode] = useState<SourceMode>("renders");
  const [sourceVideo, setSourceVideo] = useState("");
  const [selectedRender, setSelectedRender] = useState<CompletedRender | null>(
    null,
  );
  const [renders, setRenders] = useState<CompletedRender[]>([]);
  const [rendersLoading, setRendersLoading] = useState(false);
  const [navigating, setNavigating] = useState(false);
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

  const handleGoToStudio = useCallback(async () => {
    // If user selected a render that already has a draft, go directly
    if (sourceMode === "renders" && selectedRender) {
      router.push(`/director/studio/${selectedRender.draftId}?panel=shorts`);
      return;
    }

    // For uploads, create a draft first
    const source = sourceVideo.trim();
    if (!source) {
      showToast("Please provide a source video", "error");
      return;
    }

    setNavigating(true);
    try {
      const res = await fetchJson<{ id: string }>(
        "/api/admin/director/drafts",
        {
          method: "POST",
          body: JSON.stringify({
            title:
              source
                .split("/")
                .pop()
                ?.replace(/\.[^.]+$/, "") ?? "Untitled",
            manifest: {
              projectTitle:
                source
                  .split("/")
                  .pop()
                  ?.replace(/\.[^.]+$/, "") ?? "Untitled",
              composition: { fps: 30, width: 1920, height: 1080 },
              timeline: [
                {
                  type: "video_clip",
                  src: source,
                  source: source,
                  startAtFrame: 0,
                  durationInFrames: 900,
                },
              ],
            },
            productionMode: "shorts",
          }),
        },
      );
      router.push(`/director/studio/${res.id}?panel=shorts`);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to create draft",
        "error",
      );
    } finally {
      setNavigating(false);
    }
  }, [sourceMode, selectedRender, sourceVideo, router]);

  const hasSource =
    sourceMode === "renders"
      ? !!selectedRender?.outputPath
      : !!sourceVideo.trim();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          YouTube Shorts Generator
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select a video and let AI analyze it to propose the best short-form
          clips with virality scoring.
        </p>
      </div>

      {/* Source video */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-foreground">
          Source Video
        </label>

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
                No presentations found. Create a presentation in the Video
                Wizard first.
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
                        <span className="text-sm font-medium text-foreground truncate">
                          {r.draftTitle}
                        </span>
                        {hasRender ? (
                          <span className="text-[10px] text-green-500 shrink-0">
                            Ready
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            Render first
                          </span>
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

      {/* How it works */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">How it works</h3>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          AI will analyze your video and propose the best short-form clips with
          virality scores. You can review, edit, accept or reject each proposal
          before rendering — just like OpusClip.
        </p>
      </div>

      {/* CTA */}
      <button
        onClick={handleGoToStudio}
        disabled={navigating || !hasSource}
        className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
      >
        {navigating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing Studio...
          </>
        ) : (
          <>
            <Scissors className="h-4 w-4" />
            Generate Shorts in Studio
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    </div>
  );
}
