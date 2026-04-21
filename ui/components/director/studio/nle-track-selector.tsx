"use client";

import {
  Download,
  FileVideo,
  FileAudio,
  Subtitles,
  Clapperboard,
} from "lucide-react";

export type ExportTrack = "video" | "audio" | "captions" | "broll";

const TRACKS: { id: ExportTrack; label: string; icon: typeof FileVideo }[] = [
  { id: "video", label: "Video", icon: FileVideo },
  { id: "audio", label: "Audio", icon: FileAudio },
  { id: "captions", label: "Captions", icon: Subtitles },
  { id: "broll", label: "B-Roll", icon: Clapperboard },
];

export interface NleTrackSelectorProps {
  value: Set<ExportTrack>;
  onChange: (next: Set<ExportTrack>) => void;
  disabled?: boolean;
}

/**
 * Checkbox group letting users include/exclude tracks before NLE export.
 * Issue #833.
 */
export function NleTrackSelector({
  value,
  onChange,
  disabled = false,
}: NleTrackSelectorProps) {
  const toggle = (id: ExportTrack) => {
    const next = new Set(value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <fieldset
      className="rounded-lg border border-border p-2"
      data-testid="nle-track-selector"
    >
      <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Tracks
      </legend>
      <div className="grid grid-cols-2 gap-1">
        {TRACKS.map(({ id, label, icon: Icon }) => {
          const checked = value.has(id);
          return (
            <label
              key={id}
              className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] ${
                disabled ? "cursor-not-allowed opacity-50" : "hover:bg-muted"
              } ${checked ? "border border-primary bg-primary/5" : "border border-transparent"}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(id)}
                disabled={disabled}
                className="h-3 w-3"
                aria-label={`Include ${label} track`}
              />
              <Icon className="h-3 w-3" />
              <span>{label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface DownloadFileOptions {
  /** URL or blob to download. */
  url: string;
  /** Filename hint for the browser. */
  filename: string;
}

/**
 * Trigger a browser download for a file URL by synthesizing a temporary
 * `<a download>`. Used after NLE export completes (#833).
 */
export function downloadFile({ url, filename }: DownloadFileOptions): void {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Some browsers require the anchor to be in the DOM for click() to fire.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export interface DownloadButtonProps {
  url?: string;
  filename: string;
  disabled?: boolean;
  label?: string;
}

export function NleDownloadButton({
  url,
  filename,
  disabled = false,
  label = "Download export",
}: DownloadButtonProps) {
  return (
    <button
      type="button"
      onClick={() => url && downloadFile({ url, filename })}
      disabled={disabled || !url}
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Download className="h-3 w-3" />
      {label}
    </button>
  );
}
