"use client";

import { memo, useState, useRef } from "react";
import { Play, Download, X, Maximize2 } from "lucide-react";

const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

type ChatVideoBlockProps = {
  src: string;
  title?: string;
};

/**
 * Inline video player for chat messages.
 * Renders a compact preview with play button, then full-size lightbox.
 */
export const ChatVideoBlock = memo(function ChatVideoBlock({ src, title }: ChatVideoBlockProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [error, setError] = useState(false);

  const authedSrc = src.includes("/api/") && AUTH_TOKEN
    ? `${src}${src.includes("?") ? "&" : "?"}token=${AUTH_TOKEN}`
    : src;

  if (error) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Play className="h-4 w-4" />
        <span>Failed to load video</span>
        {title && <span className="italic">({title})</span>}
      </div>
    );
  }

  return (
    <>
      <div className="group relative my-2 inline-block max-w-md cursor-pointer overflow-hidden rounded-lg border border-border shadow-sm transition-shadow hover:shadow-md">
        <video
          ref={videoRef}
          src={authedSrc}
          className="max-h-64 w-auto"
          preload="metadata"
          onError={() => setError(true)}
          onClick={() => setLightboxOpen(true)}
        />
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-100 transition-opacity group-hover:opacity-80"
          onClick={() => setLightboxOpen(true)}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-lg">
            <Play className="ml-0.5 h-6 w-6 text-black" />
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent px-2 py-1 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="truncate text-xs text-white/90">{title || "Video"}</span>
          <div className="flex gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
              className="rounded p-1 text-white/80 hover:bg-white/20 hover:text-white"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
            <a
              href={authedSrc}
              download={title || "video.mp4"}
              onClick={(e) => e.stopPropagation()}
              className="rounded p-1 text-white/80 hover:bg-white/20 hover:text-white"
            >
              <Download className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <video
              src={authedSrc}
              className="max-h-[85vh] max-w-[85vw] rounded-lg shadow-2xl"
              controls
              autoPlay
            />
            <div className="absolute right-2 top-2 flex gap-1">
              <a
                href={authedSrc}
                download={title || "video.mp4"}
                className="rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
              >
                <Download className="h-5 w-5" />
              </a>
              <button
                onClick={() => setLightboxOpen(false)}
                className="rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {title && (
              <p className="mt-2 text-center text-sm text-white/80">{title}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
});
