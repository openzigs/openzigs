"use client";

import { Check, X } from "lucide-react";

export interface BRollSuggestionView {
  id: string;
  /** Time (s) at which the b-roll inserts. */
  timestamp: number;
  /** Suggestion duration (s). */
  duration: number;
  /** Search query that produced this suggestion. */
  query: string;
  /** Optional thumbnail. */
  thumbnailUrl?: string;
  /** Source of the suggestion (stock provider, archive, etc). */
  source: string;
  /** AI-assigned relevance score (0–1). */
  relevanceScore?: number;
  /** Has the user accepted/rejected? */
  status?: "pending" | "accepted" | "rejected";
}

export interface BRollCardProps {
  suggestion: BRollSuggestionView;
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Thumbnail card for a single B-roll suggestion. Shows the thumbnail (or a
 * placeholder), insertion timestamp, query, source, relevance score, and
 * explicit accept/reject buttons. Issue #835.
 */
export function BRollCard({ suggestion, onAccept, onReject }: BRollCardProps) {
  const status = suggestion.status ?? "pending";
  const score = suggestion.relevanceScore;
  const scoreLabel =
    typeof score === "number" ? `${Math.round(score * 100)}%` : null;

  return (
    <div
      className={`flex gap-2 rounded-lg border p-2 text-[11px] ${
        status === "accepted"
          ? "border-emerald-500/60 bg-emerald-500/5"
          : status === "rejected"
            ? "border-red-500/60 bg-red-500/5 opacity-60"
            : "border-border"
      }`}
      data-testid={`broll-card-${suggestion.id}`}
    >
      <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded bg-muted">
        {suggestion.thumbnailUrl ? (
          <img
            src={suggestion.thumbnailUrl}
            alt={`B-roll thumbnail for ${suggestion.query}`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[9px] text-muted-foreground">
            No preview
          </div>
        )}
        {scoreLabel && (
          <span
            className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] font-medium text-white"
            aria-label={`Relevance score ${scoreLabel}`}
          >
            {scoreLabel}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{suggestion.query}</span>
          <span className="shrink-0 text-[9px] text-muted-foreground">
            @ {fmtTime(suggestion.timestamp)}
          </span>
        </div>
        <p className="truncate text-[10px] text-muted-foreground">
          {suggestion.source} · {suggestion.duration.toFixed(1)}s
        </p>
        <div className="mt-1 flex gap-1">
          <button
            type="button"
            onClick={() => onAccept?.(suggestion.id)}
            disabled={status === "accepted"}
            aria-label={`Accept B-roll for ${suggestion.query}`}
            className="flex items-center gap-0.5 rounded bg-emerald-600/20 px-1.5 py-0.5 text-[10px] text-emerald-600 hover:bg-emerald-600/30 disabled:opacity-40"
          >
            <Check className="h-3 w-3" /> Accept
          </button>
          <button
            type="button"
            onClick={() => onReject?.(suggestion.id)}
            disabled={status === "rejected"}
            aria-label={`Reject B-roll for ${suggestion.query}`}
            className="flex items-center gap-0.5 rounded bg-red-600/20 px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-600/30 disabled:opacity-40"
          >
            <X className="h-3 w-3" /> Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export interface BRollPreviewStripProps {
  suggestions: BRollSuggestionView[];
  /** Total video duration (s) used to position markers. */
  totalDuration: number;
  /** Click handler that receives suggestion id. */
  onMarkerClick?: (id: string) => void;
}

/**
 * Horizontal preview strip showing each B-roll insertion as a marker on a
 * timeline. Marker x-position = timestamp / totalDuration. Issue #835.
 */
export function BRollPreviewStrip({
  suggestions,
  totalDuration,
  onMarkerClick,
}: BRollPreviewStripProps) {
  if (totalDuration <= 0) return null;
  return (
    <div
      className="relative h-8 w-full rounded bg-muted"
      role="group"
      aria-label="B-roll insertion timeline"
      data-testid="broll-preview-strip"
    >
      {suggestions.map((s) => {
        const left = Math.max(
          0,
          Math.min(100, (s.timestamp / totalDuration) * 100),
        );
        const width = Math.max(
          0.5,
          Math.min(100 - left, (s.duration / totalDuration) * 100),
        );
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onMarkerClick?.(s.id)}
            aria-label={`B-roll ${s.query} at ${s.timestamp.toFixed(1)}s`}
            className="absolute top-1 h-6 rounded bg-blue-500/70 hover:bg-blue-500"
            style={{ left: `${left}%`, width: `${width}%` }}
            data-testid={`broll-marker-${s.id}`}
            title={`${s.query} (${s.timestamp.toFixed(1)}s)`}
          />
        );
      })}
    </div>
  );
}
