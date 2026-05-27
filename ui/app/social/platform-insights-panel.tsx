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
    scopeLabel: "Organization URN",
    scopeField: "org_urn",
    scopePlaceholder: "urn:li:organization:12345",
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
    scopeLabel: "User ID",
    scopeField: "user_id",
    scopePlaceholder: "44196397",
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
      const result = await fetchJson<{ result?: { text?: string } }>(
        `/api/admin/tools/${spec.toolName}/invoke`,
        {
          method: "POST",
          body: JSON.stringify({ [spec.scopeField]: scope.trim() }),
        },
      );
      const text = result?.result?.text;
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
      {data !== null && (
        <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-[11px]">
          {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
        </pre>
      )}
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
