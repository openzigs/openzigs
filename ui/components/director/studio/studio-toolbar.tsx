"use client";

import { useState, useCallback, useEffect } from "react";
import {
  ArrowLeft,
  Save,
  Film,
  Loader2,
  Check,
  Youtube,
  ExternalLink,
  Subtitles,
  ChevronDown,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { RenderHistory } from "./render-history";
import { VersionHistory } from "./version-history";
import { ThumbnailPanel } from "./thumbnail-panel";
import { YouTubeMetadataEditor } from "./youtube-metadata-editor";
import { YouTubePublishHistory } from "./youtube-publish-history";
import type { YouTubeMetadata } from "./youtube-metadata-editor";
import type { DirectorManifest } from "../types";

interface StudioToolbarProps {
  title: string;
  draftId: string;
  manifest: DirectorManifest | null;
  onSave: () => Promise<void>;
  onRestore: (manifest: DirectorManifest) => void;
  dirty?: boolean;
  lastSaved?: string | null;
}

export function StudioToolbar({
  title,
  draftId,
  manifest,
  onSave,
  onRestore,
  dirty,
  lastSaved,
}: StudioToolbarProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<{
    status: string;
    videoUrl?: string;
  } | null>(null);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave();
      setSaved(true);
      showToast("Draft saved", "success");
      setTimeout(() => setSaved(false), 2000);
    } catch {
      showToast("Failed to save draft", "error");
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const handleRender = useCallback(async () => {
    if (!manifest) return;
    setRendering(true);
    try {
      // Save first so the latest manifest is persisted
      await onSave();
      const res = await fetchJson<{ jobId: string }>(
        "/api/admin/director/render",
        {
          method: "POST",
          body: JSON.stringify({ manifest, draftId, quality: "standard" }),
        },
      );
      await fetchJson(`/api/admin/director/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({ status: "rendering" }),
      });
      showToast(`Render queued (${res.jobId})`, "success");
    } catch {
      showToast("Render failed to start", "error");
    } finally {
      setRendering(false);
    }
  }, [manifest, draftId, onSave]);

  // Poll YouTube publish status
  useEffect(() => {
    if (!draftId) return;
    fetchJson<{ status: string; videoUrl?: string }>(
      `/api/admin/director/youtube/publish/${draftId}/status`,
    )
      .then(setPublishStatus)
      .catch(() => {
        /* silent */
      });
  }, [draftId]);

  const handleYouTubePublish = useCallback(
    async (metadata: YouTubeMetadata) => {
      setPublishing(true);
      try {
        await onSave();
        const res = await fetchJson<{
          id: string;
          status: string;
          error?: string;
        }>("/api/admin/director/youtube/publish", {
          method: "POST",
          body: JSON.stringify({
            draftId,
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            categoryId: metadata.categoryId,
            privacyStatus: metadata.privacyStatus,
          }),
        });
        if (res.status === "failed") {
          showToast(res.error ?? "Publish failed", "error");
        } else {
          showToast("Publishing to YouTube…", "success");
          setYtOpen(false);
          // Re-fetch status
          const status = await fetchJson<{ status: string; videoUrl?: string }>(
            `/api/admin/director/youtube/publish/${draftId}/status`,
          );
          setPublishStatus(status);
        }
      } catch {
        showToast("Failed to start YouTube publish", "error");
      } finally {
        setPublishing(false);
      }
    },
    [draftId, onSave],
  );

  const handleSaveVersion = useCallback(async () => {
    await onSave();
    const label = window.prompt("Version label (leave blank for auto)") ?? "";
    await fetchJson(`/api/admin/director/drafts/${draftId}/versions`, {
      method: "POST",
      body: JSON.stringify({ label: label.trim() || undefined }),
    });
  }, [draftId, onSave]);

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-background px-4 py-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push("/director")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <div className="h-4 w-px bg-border" />
        <h2 className="text-sm font-medium text-foreground truncate max-w-[300px]">
          {title}
        </h2>
        {dirty && (
          <span className="ml-1 text-[10px] text-muted-foreground italic">
            unsaved
          </span>
        )}
        {lastSaved && !dirty && (
          <span className="ml-1 text-[10px] text-muted-foreground">saved</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : saved ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saved ? "Saved" : "Save"}
        </button>
        {draftId && (
          <VersionHistory
            draftId={draftId}
            onRestore={onRestore}
            onSaveVersion={handleSaveVersion}
          />
        )}
        {draftId && <ThumbnailPanel draftId={draftId} />}
        {draftId && <RenderHistory draftId={draftId} />}
        {draftId && (
          <YouTubePublishHistory
            draftId={draftId}
            onStatusChange={() => {
              fetchJson<{ status: string; videoUrl?: string }>(
                `/api/admin/director/youtube/publish/${draftId}/status`,
              )
                .then(setPublishStatus)
                .catch(() => {});
            }}
          />
        )}

        {/* Export Subtitles */}
        {draftId && (
          <div className="relative">
            <button
              onClick={() => setSubtitleMenuOpen(!subtitleMenuOpen)}
              className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition"
            >
              <Subtitles className="h-3.5 w-3.5" />
              Subtitles
              <ChevronDown className="h-3 w-3" />
            </button>
            {subtitleMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-36 rounded-md border border-border bg-popover p-1 shadow-md">
                <a
                  href={`${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? ""}/api/admin/director/drafts/${draftId}/subtitles/srt${process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ? `?token=${encodeURIComponent(process.env.NEXT_PUBLIC_OPENZIGS_TOKEN)}` : ""}`}
                  download
                  onClick={() => setSubtitleMenuOpen(false)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-foreground hover:bg-accent transition"
                >
                  Export .srt
                </a>
                <a
                  href={`${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? ""}/api/admin/director/drafts/${draftId}/subtitles/vtt${process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ? `?token=${encodeURIComponent(process.env.NEXT_PUBLIC_OPENZIGS_TOKEN)}` : ""}`}
                  download
                  onClick={() => setSubtitleMenuOpen(false)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-foreground hover:bg-accent transition"
                >
                  Export .vtt
                </a>
              </div>
            )}
          </div>
        )}

        {/* YouTube Publish */}
        {draftId &&
        publishStatus?.status === "published" &&
        publishStatus.videoUrl ? (
          <a
            href={publishStatus.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-md bg-red-600/10 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-600/20 transition"
          >
            <Youtube className="h-3.5 w-3.5" />
            View on YouTube
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : draftId ? (
          <button
            onClick={() => setYtOpen(true)}
            disabled={publishing}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition disabled:opacity-50"
          >
            {publishing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Youtube className="h-3.5 w-3.5" />
            )}
            {publishing ? "Publishing…" : "Publish"}
          </button>
        ) : null}

        <button
          onClick={handleRender}
          disabled={rendering || !manifest}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
        >
          {rendering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Film className="h-3.5 w-3.5" />
          )}
          Render
        </button>
      </div>

      {/* YouTube Metadata Editor Modal */}
      <YouTubeMetadataEditor
        draftId={draftId}
        defaultTitle={title}
        open={ytOpen}
        onClose={() => setYtOpen(false)}
        onPublish={handleYouTubePublish}
        publishing={publishing}
        warning={
          publishStatus?.status === "published"
            ? "This draft has already been published to YouTube. Publishing again will create a new video."
            : undefined
        }
      />
    </div>
  );
}
