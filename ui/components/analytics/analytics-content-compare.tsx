"use client";

import { useMemo, useState } from "react";
import { ArrowLeftRight, Trophy } from "lucide-react";

export interface ContentMetrics {
  id: string;
  title: string;
  views?: number;
  likes?: number;
  comments?: number;
  /** 0–1 fraction. */
  engagement?: number;
  /** Watch time in seconds. */
  watchTime?: number;
}

export interface AnalyticsContentCompareProps {
  posts: ContentMetrics[];
  initialA?: string;
  initialB?: string;
}

interface MetricRow {
  key: keyof Omit<ContentMetrics, "id" | "title">;
  label: string;
  format: (v: number | undefined) => string;
}

const METRICS: MetricRow[] = [
  {
    key: "views",
    label: "Views",
    format: (v) => (v == null ? "—" : v.toLocaleString()),
  },
  {
    key: "likes",
    label: "Likes",
    format: (v) => (v == null ? "—" : v.toLocaleString()),
  },
  {
    key: "comments",
    label: "Comments",
    format: (v) => (v == null ? "—" : v.toLocaleString()),
  },
  {
    key: "engagement",
    label: "Engagement",
    format: (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`),
  },
  {
    key: "watchTime",
    label: "Watch Time",
    format: (v) => {
      if (v == null) return "—";
      const m = Math.floor(v / 60);
      const s = Math.floor(v % 60);
      return `${m}m ${s}s`;
    },
  },
];

/**
 * Side-by-side comparison of two posts across key engagement metrics, with a
 * winner badge per row. Issue #831.
 */
export function AnalyticsContentCompare({
  posts,
  initialA,
  initialB,
}: AnalyticsContentCompareProps) {
  const [aId, setAId] = useState<string | undefined>(initialA ?? posts[0]?.id);
  const [bId, setBId] = useState<string | undefined>(initialB ?? posts[1]?.id);

  const a = useMemo(() => posts.find((p) => p.id === aId), [posts, aId]);
  const b = useMemo(() => posts.find((p) => p.id === bId), [posts, bId]);

  if (posts.length < 2) {
    return (
      <div
        className="rounded-lg border border-dashed border-border p-3 text-center text-[11px] text-muted-foreground"
        data-testid="content-compare-empty"
      >
        Need at least 2 posts to compare.
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid="analytics-content-compare"
    >
      <div className="mb-3 flex items-center gap-2">
        <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[11px] font-medium">Compare Posts</h3>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label="Post A"
          value={aId ?? ""}
          onChange={(e) => setAId(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-[11px]"
        >
          {posts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <select
          aria-label="Post B"
          value={bId ?? ""}
          onChange={(e) => setBId(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-[11px]"
        >
          {posts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>

      {a && b && a.id !== b.id && (
        <table className="mt-3 w-full text-[11px]">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1 font-medium">Metric</th>
              <th className="py-1 font-medium">A</th>
              <th className="py-1 font-medium">B</th>
              <th className="py-1 font-medium">Winner</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const va = a[m.key];
              const vb = b[m.key];
              let winner: "A" | "B" | "tie" | null = null;
              if (typeof va === "number" && typeof vb === "number") {
                winner = va > vb ? "A" : va < vb ? "B" : "tie";
              }
              return (
                <tr
                  key={m.key}
                  className="border-b border-border/40 last:border-0"
                  data-testid={`compare-row-${m.key}`}
                >
                  <td className="py-1 font-medium">{m.label}</td>
                  <td className="py-1 tabular-nums">{m.format(va)}</td>
                  <td className="py-1 tabular-nums">{m.format(vb)}</td>
                  <td className="py-1">
                    {winner === "A" && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-500">
                        <Trophy className="h-3 w-3" /> A
                      </span>
                    )}
                    {winner === "B" && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-500">
                        <Trophy className="h-3 w-3" /> B
                      </span>
                    )}
                    {winner === "tie" && (
                      <span className="text-muted-foreground">tie</span>
                    )}
                    {winner === null && (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {a && b && a.id === b.id && (
        <p
          className="mt-3 text-center text-[10px] text-muted-foreground"
          data-testid="compare-same-post"
        >
          Pick two different posts to compare.
        </p>
      )}
    </div>
  );
}
