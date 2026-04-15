"use client";

import { useState } from "react";

interface SerpPreviewProps {
  title?: string;
  description?: string;
  url?: string;
  /** Whether to show truncation indicators */
  showTruncation?: boolean;
}

/** Approximate pixel width limits for Google SERP */
const TITLE_MAX_CHARS = 60;
const DESC_MAX_CHARS = 160;

/**
 * Google-style SERP Preview component (#882).
 *
 * Renders a realistic preview of how a page would appear in Google search
 * results, including truncation indicators for titles and descriptions
 * that exceed Google's display limits.
 */
export function SerpPreview({
  title = "",
  description = "",
  url = "",
  showTruncation = true,
}: SerpPreviewProps) {
  const isTitleTruncated = title.length > TITLE_MAX_CHARS;
  const isDescTruncated = description.length > DESC_MAX_CHARS;

  const displayTitle = isTitleTruncated
    ? title.slice(0, TITLE_MAX_CHARS) + "..."
    : title;
  const displayDesc = isDescTruncated
    ? description.slice(0, DESC_MAX_CHARS) + "..."
    : description;

  // Format the URL breadcrumb like Google does
  const formatUrl = (rawUrl: string): string => {
    try {
      const parsed = new URL(rawUrl);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const host = parsed.hostname;
      if (parts.length === 0) return host;
      return `${host} › ${parts.join(" › ")}`;
    } catch {
      return rawUrl;
    }
  };

  return (
    <div className="max-w-[600px] font-sans">
      {/* URL breadcrumb */}
      {url && (
        <div className="flex items-center gap-1 mb-0.5">
          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0">
            <span className="text-[10px] font-bold text-muted-foreground">
              {(() => {
                try {
                  return new URL(url).hostname.charAt(0).toUpperCase();
                } catch {
                  return "?";
                }
              })()}
            </span>
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs text-muted-foreground truncate">
              {formatUrl(url)}
            </span>
          </div>
        </div>
      )}

      {/* Title */}
      <h3 className="text-[20px] leading-[1.3] font-normal text-[#1a0dab] dark:text-blue-400 cursor-pointer hover:underline">
        {displayTitle || (
          <span className="text-muted-foreground italic">No title</span>
        )}
      </h3>

      {/* Truncation badge for title */}
      {showTruncation && isTitleTruncated && (
        <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 mt-0.5">
          Title truncated ({title.length}/{TITLE_MAX_CHARS} chars)
        </span>
      )}

      {/* Description */}
      <p className="text-[14px] leading-[1.58] text-[#4d5156] dark:text-muted-foreground mt-0.5">
        {displayDesc || <span className="italic">No description</span>}
      </p>

      {/* Truncation badge for description */}
      {showTruncation && isDescTruncated && (
        <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 mt-0.5">
          Description truncated ({description.length}/{DESC_MAX_CHARS} chars)
        </span>
      )}
    </div>
  );
}

/**
 * Interactive SERP preview with editable title/description (#882).
 */
export function SerpPreviewEditor({
  initialTitle = "",
  initialDescription = "",
  url = "",
}: {
  initialTitle?: string;
  initialDescription?: string;
  url?: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <SerpPreview
          title={title}
          description={description}
          url={url}
          showTruncation
        />
      </div>

      <div className="grid gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Title ({title.length}/{TITLE_MAX_CHARS} chars)
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`w-full rounded-md border px-3 py-2 text-sm bg-background ${
              title.length > TITLE_MAX_CHARS
                ? "border-yellow-500"
                : "border-input"
            }`}
            placeholder="Page title"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Description ({description.length}/{DESC_MAX_CHARS} chars)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={`w-full rounded-md border px-3 py-2 text-sm bg-background resize-none ${
              description.length > DESC_MAX_CHARS
                ? "border-yellow-500"
                : "border-input"
            }`}
            placeholder="Meta description"
          />
        </div>
      </div>
    </div>
  );
}
