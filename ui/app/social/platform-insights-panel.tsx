"use client";

import { useState } from "react";
import { fetchJson } from "@/lib/api";

type PlatformKey = "linkedin" | "reddit" | "twitter";

type CardSpec = {
  key: PlatformKey;
  label: string;
  toolName: string;
  scopeLabel: string;
  scopeField: string;
  scopePlaceholder: string;
  note: string;
};

const CARDS: CardSpec[] = [
  {
    key: "linkedin",
    label: "LinkedIn",
    toolName: "linkedin-profile-analytics",
    scopeLabel: "Organization ID",
    scopeField: "organization_id",
    scopePlaceholder: "12345 or urn:li:organization:12345",
    note: "Org-owned pages only. Personal-profile analytics are not exposed via API.",
  },
  {
    key: "reddit",
    label: "Reddit",
    toolName: "reddit-subreddit-health",
    scopeLabel: "Subreddit",
    scopeField: "subreddit",
    scopePlaceholder: "python",
    note: "Reddit does not expose post impressions or view counts.",
  },
  {
    key: "twitter",
    label: "Twitter / X",
    toolName: "twitter-account-analytics",
    scopeLabel: "Username",
    scopeField: "username",
    scopePlaceholder: "jack",
    note: "Free tier returns public_metrics only (followers, tweets). Detailed impressions require paid tier.",
  },
];

function PlatformCard({ spec }: { spec: CardSpec }) {
  const [scope, setScope] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchInsights = async () => {
    if (!scope.trim()) {
      setError(`${spec.scopeLabel} is required.`);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await fetchJson<{
        ok?: boolean;
        tool?: string;
        text?: string;
      }>(`/api/admin/tools/${spec.toolName}/invoke`, {
        method: "POST",
        body: JSON.stringify({ [spec.scopeField]: scope.trim() }),
      });
      const text = result?.text;
      if (typeof text === "string") {
        try {
          setData(JSON.parse(text));
        } catch {
          setData(text);
        }
      } else {
        setData(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-testid={`insights-card-${spec.key}`}
      className="rounded-lg border border-border bg-card p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">{spec.label}</h4>
        <span className="text-xs text-muted-foreground">{spec.toolName}</span>
      </div>
      <p className="text-xs text-muted-foreground">{spec.note}</p>
      <label className="block text-xs font-medium">
        {spec.scopeLabel}
        <input
          aria-label={`${spec.label} ${spec.scopeLabel}`}
          type="text"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder={spec.scopePlaceholder}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
      </label>
      <button
        type="button"
        onClick={fetchInsights}
        disabled={loading}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60"
      >
        {loading ? "Fetching…" : "Fetch insights"}
      </button>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {data !== null && <InsightsResult data={data} />}
    </div>
  );
}

function formatMetricLabel(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatMetricValue(value: number | string | boolean): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString();
  }
  return String(value);
}

function isPrimitive(v: unknown): v is number | string | boolean {
  return (
    typeof v === "number" || typeof v === "string" || typeof v === "boolean"
  );
}

function extractMetricTiles(
  data: unknown,
): Array<{ key: string; value: number | string | boolean }> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const tiles: Array<{ key: string; value: number | string | boolean }> = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (isPrimitive(v)) {
      tiles.push({ key: k, value: v });
    }
  }
  return tiles;
}

function InsightsResult({ data }: { data: unknown }) {
  const tiles = extractMetricTiles(data);
  return (
    <div className="space-y-2" data-testid="insights-result">
      {tiles.length > 0 && (
        <div
          className="grid grid-cols-2 gap-2"
          data-testid="insights-metric-tiles"
        >
          {tiles.map((t) => (
            <div
              key={t.key}
              className="rounded-md border border-border bg-muted/30 p-2"
            >
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {formatMetricLabel(t.key)}
              </div>
              <div className="text-sm font-semibold tabular-nums">
                {formatMetricValue(t.value)}
              </div>
            </div>
          ))}
        </div>
      )}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted-foreground">
          Raw response
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/40 p-2">
          {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function PlatformInsightsPanel() {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold">Platform Insights</h3>
        <p className="text-xs text-muted-foreground">
          Pull native analytics from each platform&apos;s API via MCP tools.
          Subject to each platform&apos;s API tier limits.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {CARDS.map((c) => (
          <PlatformCard key={c.key} spec={c} />
        ))}
      </div>
    </div>
  );
}
