"use client";

import Link from "next/link";
import { buildUrl } from "@/lib/api";
import { Clock, Trash2, Brain } from "lucide-react";

interface PresentationSummary {
  id: string;
  title: string;
  thumbnail_path: string | null;
  duration_seconds: number;
  mode: string;
  quiz_enabled: boolean;
  created_at: string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function PresentationCard({
  presentation,
  onDelete,
}: {
  presentation: PresentationSummary;
  onDelete: () => void;
}) {
  const { id, title, thumbnail_path, duration_seconds, quiz_enabled, created_at } =
    presentation;

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:border-primary/30 hover:shadow-md">
      {/* Thumbnail */}
      <Link href={`/presenter/${id}`} className="block">
        <div className="relative aspect-video w-full bg-muted">
          {thumbnail_path ? (
            <img
              src={buildUrl(`/api/presentations/${id}/thumbnail`)}
              alt={title}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <span className="text-4xl">🎬</span>
            </div>
          )}
          <div className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {formatDuration(duration_seconds)}
          </div>
        </div>
      </Link>

      {/* Info */}
      <div className="p-3">
        <Link href={`/presenter/${id}`}>
          <h3 className="line-clamp-2 text-sm font-semibold text-foreground hover:text-primary">
            {title}
          </h3>
        </Link>

        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {new Date(created_at).toLocaleDateString()}
            </span>
            {quiz_enabled && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
                <Brain className="h-3 w-3" />
                Quiz
              </span>
            )}
          </div>

          <button
            onClick={onDelete}
            title="Remove from catalog"
            className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
