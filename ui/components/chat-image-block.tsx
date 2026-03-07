"use client";

import { memo, useState, useCallback } from "react";
import { Download, X, ZoomIn, Loader2 } from "lucide-react";

const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

type ChatImageBlockProps = {
  src?: string;
  alt?: string;
};

/**
 * Renders images in chat messages with:
 * - Thumbnail preview sized to chat bubble
 * - Click-to-expand lightbox with full-size view
 * - Download button
 * - Loading / error states
 *
 * Resolves relative `/api/...` paths against the configured API base.
 */
export const ChatImageBlock = memo(function ChatImageBlock({ src, alt }: ChatImageBlockProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  // Keep API-relative URLs same-origin so Next.js rewrites can proxy to backend.
  // This avoids browser CORP restrictions when UI runs on :3001 and API on :3000.
  const resolvedSrc = src ?? "";

  // Build auth query string for image URLs served by our backend
  const authedSrc = resolvedSrc.includes("/api/") && AUTH_TOKEN
    ? `${resolvedSrc}${resolvedSrc.includes("?") ? "&" : "?"}token=${AUTH_TOKEN}`
    : resolvedSrc;

  const handleDownload = useCallback(async () => {
    try {
      const response = await fetch(authedSrc);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = alt || "keyframe.jpg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: open in new tab
      window.open(authedSrc, "_blank");
    }
  }, [authedSrc, alt]);

  if (!src) return null;

  if (error) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <span>Failed to load image</span>
        {alt && <span className="italic">({alt})</span>}
      </div>
    );
  }

  return (
    <>
      {/* Thumbnail */}
      <div className="group relative my-2 inline-block max-w-sm cursor-pointer overflow-hidden rounded-lg border border-border shadow-sm transition-shadow hover:shadow-md">
        {!loaded && (
          <div className="flex h-32 w-48 items-center justify-center bg-muted/50">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        <img
          src={authedSrc}
          alt={alt || "Image"}
          className={`max-h-64 w-auto object-contain ${loaded ? "block" : "hidden"}`}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          onClick={() => setLightboxOpen(true)}
        />
        {loaded && (
          <div className="absolute inset-0 flex items-end justify-between bg-gradient-to-t from-black/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100">
            <span className="truncate px-2 py-1 text-xs text-white/90">
              {alt || "Image"}
            </span>
            <div className="flex gap-1 px-2 py-1">
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
                className="rounded p-1 text-white/80 hover:bg-white/20 hover:text-white"
                title="View full size"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDownload(); }}
                className="rounded p-1 text-white/80 hover:bg-white/20 hover:text-white"
                title="Download"
              >
                <Download className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <img
              src={authedSrc}
              alt={alt || "Image"}
              className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
            />
            <div className="absolute right-2 top-2 flex gap-1">
              <button
                onClick={handleDownload}
                className="rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
                title="Download"
              >
                <Download className="h-5 w-5" />
              </button>
              <button
                onClick={() => setLightboxOpen(false)}
                className="rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {alt && (
              <p className="mt-2 text-center text-sm text-white/80">{alt}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
});
