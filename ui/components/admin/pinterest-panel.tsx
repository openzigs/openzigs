"use client";

import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { TrendingUp, Eye, MousePointerClick, Bookmark, Activity, ExternalLink, Copy, Key, Save, LogOut, RefreshCw, Link2 } from "lucide-react";
import { showToast } from "@/components/toast";

type PinterestCredentials = {
  accessToken: string;
  adAccountId: string;
  configured: boolean;
  hasRefreshToken: boolean;
  expiresAt: string | null;
  oauthConfigured: boolean;
};

type PinterestStatus = {
  connected: boolean;
  message?: string;
  profile?: {
    username?: string;
    account_type?: string;
    profile_image?: string;
    website_url?: string;
  };
};

type TrendKeyword = {
  keyword: string;
  pct_growth_wow: number;
  pct_growth_mom: number;
  pct_growth_yoy?: number;
};

type PinterestStats = {
  start_date: string;
  end_date: string;
  data: Record<string, unknown>;
};

function formatGrowth(value: number | undefined): string {
  if (value === undefined || value === null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value}%`;
}

function growthColor(value: number | undefined): string {
  if (value === undefined || value === null) return "text-muted-foreground";
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-muted-foreground";
}

export function PinterestPanel() {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [adAccountInput, setAdAccountInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [showTokenField, setShowTokenField] = useState(false);
  const [showAppConfig, setShowAppConfig] = useState(false);
  const [appIdInput, setAppIdInput] = useState("");
  const [appSecretInput, setAppSecretInput] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const credsQuery = useQuery({
    queryKey: ["pinterest-credentials"],
    queryFn: () => fetchJson<PinterestCredentials>("/api/admin/pinterest/credentials"),
  });

  // Handle OAuth callback redirect query params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("pinterest_oauth");
    if (oauthResult === "success") {
      showToast("Pinterest connected via OAuth!", "success");
      queryClient.invalidateQueries({ queryKey: ["pinterest-credentials"] });
      queryClient.invalidateQueries({ queryKey: ["pinterest-status"] });
      queryClient.invalidateQueries({ queryKey: ["pinterest-trends"] });
      queryClient.invalidateQueries({ queryKey: ["pinterest-stats"] });
      // Clean URL
      const url = new URL(window.location.href);
      url.searchParams.delete("pinterest_oauth");
      window.history.replaceState({}, "", url.toString());
    } else if (oauthResult === "error") {
      const message = params.get("message") ?? "OAuth authorization failed";
      showToast(message, "error");
      const url = new URL(window.location.href);
      url.searchParams.delete("pinterest_oauth");
      url.searchParams.delete("message");
      window.history.replaceState({}, "", url.toString());
    }
  }, [queryClient]);

  const statusQuery = useQuery({
    queryKey: ["pinterest-status"],
    queryFn: () => fetchJson<PinterestStatus>("/api/admin/pinterest/status"),
    refetchInterval: 60_000,
  });

  const trendsQuery = useQuery({
    queryKey: ["pinterest-trends"],
    queryFn: () => fetchJson<{ trends?: TrendKeyword[] }>("/api/admin/pinterest/trends?region=US&limit=10"),
    enabled: statusQuery.data?.connected === true,
    refetchInterval: 300_000,
  });

  const statsQuery = useQuery({
    queryKey: ["pinterest-stats"],
    queryFn: () => fetchJson<PinterestStats>("/api/admin/pinterest/stats?days=7"),
    enabled: statusQuery.data?.connected === true,
    refetchInterval: 300_000,
  });

  const status = statusQuery.data;
  const trends = trendsQuery.data?.trends ?? [];
  const stats = statsQuery.data;
  const creds = credsQuery.data;

  const handleSaveCredentials = async () => {
    if (isSaving || !tokenInput.trim()) return;
    setIsSaving(true);
    try {
      await fetchJson("/api/admin/pinterest/credentials", {
        method: "POST",
        body: JSON.stringify({
          accessToken: tokenInput.trim(),
          adAccountId: adAccountInput.trim(),
        }),
      });
      showToast("Pinterest credentials saved. Verifying connection…", "info");
      setTokenInput("");
      setAdAccountInput("");
      setShowTokenField(false);
      await queryClient.invalidateQueries({ queryKey: ["pinterest-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["pinterest-status"] });
      await queryClient.invalidateQueries({ queryKey: ["pinterest-trends"] });
      await queryClient.invalidateQueries({ queryKey: ["pinterest-stats"] });
      await queryClient.invalidateQueries({ queryKey: ["env"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save credentials";
      showToast(message, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAppCredentials = async () => {
    if (isSaving || !appIdInput.trim() || !appSecretInput.trim()) return;
    setIsSaving(true);
    try {
      await fetchJson("/api/admin/pinterest/app-credentials", {
        method: "POST",
        body: JSON.stringify({ appId: appIdInput.trim(), appSecret: appSecretInput.trim() }),
      });
      showToast("Pinterest App credentials saved", "success");
      setAppIdInput("");
      setAppSecretInput("");
      setShowAppConfig(false);
      await queryClient.invalidateQueries({ queryKey: ["pinterest-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["env"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save app credentials";
      showToast(message, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleOAuthConnect = async () => {
    setIsConnecting(true);
    try {
      const data = await fetchJson<{ authUrl: string }>("/api/admin/pinterest/oauth/authorize");
      window.location.href = data.authUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start OAuth flow";
      showToast(message, "error");
      setIsConnecting(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const result = await fetchJson<{ ok: boolean; expiresAt?: string; error?: string }>("/api/admin/pinterest/oauth/refresh", { method: "POST" });
      if (result.ok) {
        showToast(`Token refreshed — expires ${result.expiresAt ? new Date(result.expiresAt).toLocaleDateString() : "in 30 days"}`, "success");
        await queryClient.invalidateQueries({ queryKey: ["pinterest-credentials"] });
        await queryClient.invalidateQueries({ queryKey: ["pinterest-status"] });
      } else {
        showToast(result.error ?? "Refresh failed", "error");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to refresh token";
      showToast(message, "error");
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await fetchJson("/api/admin/pinterest/oauth/disconnect", { method: "POST" });
      showToast("Pinterest disconnected", "info");
      await queryClient.invalidateQueries({ queryKey: ["pinterest-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["pinterest-status"] });
      await queryClient.invalidateQueries({ queryKey: ["pinterest-trends"] });
      await queryClient.invalidateQueries({ queryKey: ["pinterest-stats"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to disconnect";
      showToast(message, "error");
    } finally {
      setIsDisconnecting(false);
    }
  };

  const copyKeyword = (keyword: string) => {
    navigator.clipboard.writeText(keyword).then(() => {
      showToast(`Copied "${keyword}" to clipboard`, "info");
    }).catch(() => {
      showToast("Failed to copy", "error");
    });
  };

  return (
    <div className="space-y-6">
      {/* OAuth Connection */}
      <div className="rounded-xl border border-border bg-card/60 p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-card-foreground">Pinterest API Credentials</h3>
          </div>
          <div className="flex items-center gap-2">
            {creds?.configured && !showTokenField && (
              <button
                onClick={() => setShowTokenField(true)}
                className="text-xs text-muted-foreground hover:text-primary hover:underline"
              >
                Manual token
              </button>
            )}
            {!creds?.oauthConfigured && !showAppConfig && (
              <button
                onClick={() => setShowAppConfig(true)}
                className="text-xs text-primary hover:underline"
              >
                Configure OAuth App
              </button>
            )}
          </div>
        </div>

        {/* App credentials config (App ID + Secret) */}
        {showAppConfig && (
          <div className="mb-4 space-y-3 rounded-lg border border-border/50 bg-background/50 p-3">
            <p className="text-xs text-muted-foreground">
              Create an app at{" "}
              <a href="https://developers.pinterest.com/apps/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                developers.pinterest.com/apps
              </a>{" "}
              and enter the App ID and App Secret below. Set the redirect URI to:{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
                http://localhost:3000/api/pinterest/oauth/callback
              </code>
            </p>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">App ID</label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                value={appIdInput}
                onChange={(e) => setAppIdInput(e.target.value)}
                placeholder="1234567890"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">App Secret</label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                type="password"
                value={appSecretInput}
                onChange={(e) => setAppSecretInput(e.target.value)}
                placeholder="your-app-secret"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveAppCredentials}
                disabled={isSaving || !appIdInput.trim() || !appSecretInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/20 disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" />
                {isSaving ? "Saving…" : "Save App Credentials"}
              </button>
              <button
                onClick={() => { setShowAppConfig(false); setAppIdInput(""); setAppSecretInput(""); }}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-border/80"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* OAuth connect / connected state */}
        {creds?.configured && !showTokenField ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-card-foreground">
                  Access Token: <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{creds.accessToken}</code>
                </span>
                {creds.hasRefreshToken && (
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-400">OAuth</span>
                )}
              </div>
              {creds.adAccountId && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-card-foreground">
                    Ad Account: <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{creds.adAccountId}</code>
                  </span>
                </div>
              )}
              {creds.expiresAt && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  Token expires: {new Date(creds.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  {creds.hasRefreshToken && (
                    <span className="text-emerald-400">(auto-refresh available)</span>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              {creds.hasRefreshToken && (
                <button
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-primary"
                >
                  <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
                  {isRefreshing ? "Refreshing…" : "Refresh Token"}
                </button>
              )}
              <button
                onClick={handleDisconnect}
                disabled={isDisconnecting}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-red-400 transition hover:border-red-400/30 hover:bg-red-400/5"
              >
                <LogOut className="h-3 w-3" />
                {isDisconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        ) : !showTokenField ? (
          <div className="space-y-3">
            {creds?.oauthConfigured ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Connect your Pinterest account using OAuth 2.0. This grants access to all Pinterest API features with automatic token refresh.
                </p>
                <button
                  onClick={handleOAuthConnect}
                  disabled={isConnecting}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#E60023] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#AD081B] disabled:opacity-50"
                >
                  <Link2 className="h-4 w-4" />
                  {isConnecting ? "Redirecting to Pinterest…" : "Connect with Pinterest"}
                </button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                To connect via OAuth, click &quot;Configure OAuth App&quot; above. Or paste a token manually.{" "}
                <button
                  onClick={() => setShowTokenField(true)}
                  className="text-primary hover:underline"
                >
                  Paste token manually
                </button>
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Paste a manually-generated token from{" "}
              <a
                href="https://developers.pinterest.com/apps/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                developers.pinterest.com/apps
              </a>{" "}
              (trial tokens expire in 24h — use OAuth instead for 30-day tokens with auto-refresh).
            </p>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">Access Token</label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="pina_..."
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">Ad Account ID <span className="text-muted-foreground/50">(optional — for keyword metrics)</span></label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                value={adAccountInput}
                onChange={(e) => setAdAccountInput(e.target.value)}
                placeholder="549770123456"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveCredentials}
                disabled={isSaving || !tokenInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/20 disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" />
                {isSaving ? "Saving…" : "Save & Connect"}
              </button>
              <button
                onClick={() => { setShowTokenField(false); setTokenInput(""); setAdAccountInput(""); }}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-border/80"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {/* Connection Status */}
      <div className="rounded-xl border border-border bg-card/60 p-4">
        <h3 className="text-sm font-semibold text-card-foreground mb-2">Pinterest Account</h3>
        {statusQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Checking connection…</p>
        ) : status?.connected ? (
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="text-sm text-card-foreground">
              Connected{status.profile?.username ? ` as @${status.profile.username}` : ""}
            </span>
            {status.profile?.website_url && (
              <a
                href={status.profile.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" />
                Website
              </a>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="text-sm text-muted-foreground">
              {status?.message ?? "Not connected"}.{" "}
              Set <code className="rounded bg-muted px-1 py-0.5 text-xs">PINTEREST_ACCESS_TOKEN</code> to connect.
            </span>
          </div>
        )}
      </div>

      {/* Quick Stats */}
      {status?.connected && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={<Eye className="h-4 w-4 text-blue-400" />}
            label="Impressions"
            value={extractMetric(stats?.data, "IMPRESSION")}
            loading={statsQuery.isLoading}
          />
          <StatCard
            icon={<MousePointerClick className="h-4 w-4 text-purple-400" />}
            label="Pin Clicks"
            value={extractMetric(stats?.data, "PIN_CLICK")}
            loading={statsQuery.isLoading}
          />
          <StatCard
            icon={<Bookmark className="h-4 w-4 text-rose-400" />}
            label="Saves"
            value={extractMetric(stats?.data, "SAVE")}
            loading={statsQuery.isLoading}
          />
          <StatCard
            icon={<Activity className="h-4 w-4 text-emerald-400" />}
            label="Engagement"
            value={extractMetric(stats?.data, "ENGAGEMENT")}
            loading={statsQuery.isLoading}
          />
        </div>
      )}

      {/* Trending Keywords */}
      {status?.connected && (
        <div className="rounded-xl border border-border bg-card/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-card-foreground">Trending Keywords (US)</h3>
          </div>
          {trendsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading trends…</p>
          ) : trends.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trend data available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2 pr-4">Keyword</th>
                    <th className="pb-2 pr-4 text-right">WoW</th>
                    <th className="pb-2 pr-4 text-right">MoM</th>
                    <th className="pb-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {trends.map((t) => (
                    <tr key={t.keyword} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-4 font-medium text-card-foreground">{t.keyword}</td>
                      <td className={`py-2 pr-4 text-right ${growthColor(t.pct_growth_wow)}`}>
                        {formatGrowth(t.pct_growth_wow)}
                      </td>
                      <td className={`py-2 pr-4 text-right ${growthColor(t.pct_growth_mom)}`}>
                        {formatGrowth(t.pct_growth_mom)}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => copyKeyword(t.keyword)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/30 hover:text-primary transition"
                          title="Copy keyword to clipboard"
                        >
                          <Copy className="h-3 w-3" />
                          Copy
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="text-lg font-semibold text-card-foreground">
        {loading ? "…" : value}
      </p>
    </div>
  );
}

/** Extract a summarized metric value from Pinterest analytics response. */
function extractMetric(
  data: Record<string, unknown> | undefined,
  metricKey: string,
): string {
  if (!data) return "—";
  try {
    // Pinterest analytics returns { all: { daily_metrics: [...], summary_metrics: { ... } } }
    const all = data.all as Record<string, unknown> | undefined;
    if (all?.summary_metrics) {
      const summary = all.summary_metrics as Record<string, number>;
      const val = summary[metricKey];
      if (typeof val === "number") return formatNumber(val);
    }
    // Fallback: try direct key access
    if (typeof data[metricKey] === "number") return formatNumber(data[metricKey] as number);
    return "—";
  } catch {
    return "—";
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
