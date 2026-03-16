"use client";

import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { Key, Save, LogOut, RefreshCw, Link2, Copy, CheckCheck } from "lucide-react";
import { showToast } from "@/components/toast";

type LinkedInCredentials = {
  accessToken: string;
  configured: boolean;
  hasRefreshToken: boolean;
  expiresAt: string | null;
  oauthConfigured: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
};

type LinkedInStatus = {
  connected: boolean;
  message?: string;
  profile?: Record<string, unknown>;
};

const REDIRECT_URI = "http://localhost:3000/api/linkedin/oauth/callback";

export function LinkedInPanel() {
  const queryClient = useQueryClient();
  const [showAppConfig, setShowAppConfig] = useState(false);
  const [clientIdInput, setClientIdInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyRedirectUri = () => {
    navigator.clipboard.writeText(REDIRECT_URI).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => showToast("Failed to copy", "error"));
  };
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const credsQuery = useQuery({
    queryKey: ["linkedin-credentials"],
    queryFn: () => fetchJson<LinkedInCredentials>("/api/admin/linkedin/credentials"),
  });

  const statusQuery = useQuery({
    queryKey: ["linkedin-status"],
    queryFn: () => fetchJson<LinkedInStatus>("/api/admin/linkedin/status"),
    refetchInterval: 60_000,
  });

  // Handle OAuth callback redirect query params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("linkedin_oauth");
    if (oauthResult === "success") {
      showToast("LinkedIn connected via OAuth!", "success");
      queryClient.invalidateQueries({ queryKey: ["linkedin-credentials"] });
      queryClient.invalidateQueries({ queryKey: ["linkedin-status"] });
      const url = new URL(window.location.href);
      url.searchParams.delete("linkedin_oauth");
      window.history.replaceState({}, "", url.toString());
    } else if (oauthResult === "error") {
      const message = params.get("message") ?? "OAuth authorization failed";
      showToast(message, "error");
      const url = new URL(window.location.href);
      url.searchParams.delete("linkedin_oauth");
      url.searchParams.delete("message");
      window.history.replaceState({}, "", url.toString());
    }
  }, [queryClient]);

  const creds = credsQuery.data;
  const status = statusQuery.data;

  const handleSaveAppCredentials = async () => {
    if (isSaving || !clientIdInput.trim() || !clientSecretInput.trim()) return;
    setIsSaving(true);
    try {
      await fetchJson("/api/admin/linkedin/app-credentials", {
        method: "POST",
        body: JSON.stringify({ clientId: clientIdInput.trim(), clientSecret: clientSecretInput.trim() }),
      });
      showToast("LinkedIn App credentials saved", "success");
      setClientIdInput("");
      setClientSecretInput("");
      setShowAppConfig(false);
      await queryClient.invalidateQueries({ queryKey: ["linkedin-credentials"] });
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
      const data = await fetchJson<{ authUrl: string }>("/api/admin/linkedin/oauth/authorize");
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
      const result = await fetchJson<{ ok: boolean; expiresAt?: string; error?: string }>("/api/admin/linkedin/oauth/refresh", { method: "POST" });
      if (result.ok) {
        showToast(`Token refreshed — expires ${result.expiresAt ? new Date(result.expiresAt).toLocaleDateString() : "in 60 days"}`, "success");
        await queryClient.invalidateQueries({ queryKey: ["linkedin-credentials"] });
        await queryClient.invalidateQueries({ queryKey: ["linkedin-status"] });
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
      await fetchJson("/api/admin/linkedin/oauth/disconnect", { method: "POST" });
      showToast("LinkedIn disconnected", "info");
      await queryClient.invalidateQueries({ queryKey: ["linkedin-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["linkedin-status"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to disconnect";
      showToast(message, "error");
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* OAuth Connection */}
      <div className="rounded-xl border border-border bg-card/60 p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-card-foreground">LinkedIn API Credentials</h3>
          </div>
          <div className="flex items-center gap-2">
            {!creds?.oauthConfigured && !showAppConfig && (
              <button
                onClick={() => setShowAppConfig(true)}
                className="text-xs text-primary hover:underline"
              >
                Configure OAuth App
              </button>
            )}
            {creds?.oauthConfigured && !showAppConfig && (
              <button
                onClick={() => setShowAppConfig(true)}
                className="text-xs text-muted-foreground hover:text-primary hover:underline"
              >
                Edit App Credentials
              </button>
            )}
          </div>
        </div>

        {/* App credentials config (Client ID + Secret) */}
        {showAppConfig && (
          <div className="mb-4 space-y-3 rounded-lg border border-border/50 bg-background/50 p-3">
            <p className="text-xs text-muted-foreground">
              Create an app at{" "}
              <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                linkedin.com/developers/apps
              </a>
              {" "}then under <strong>Auth</strong> → <strong>OAuth 2.0 settings</strong>, add this exact redirect URL:
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <code className="flex-1 text-xs font-mono text-foreground">{REDIRECT_URI}</code>
              <button
                onClick={copyRedirectUri}
                className="shrink-0 text-muted-foreground hover:text-primary transition"
                title="Copy redirect URI"
              >
                {copied ? <CheckCheck className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Ensure the app has the <strong>Share on LinkedIn</strong> product added (under the <strong>Products</strong> tab). Then enter the Client ID and Client Secret below:
            </p>
            {(creds?.hasClientId || creds?.hasClientSecret) && (
              <div className="flex gap-3 text-xs">
                <span className={creds.hasClientId ? "text-emerald-400" : "text-muted-foreground"}>
                  {creds.hasClientId ? "✓" : "✗"} Client ID
                </span>
                <span className={creds.hasClientSecret ? "text-emerald-400" : "text-muted-foreground"}>
                  {creds.hasClientSecret ? "✓" : "✗"} Client Secret
                </span>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">Client ID</label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                value={clientIdInput}
                onChange={(e) => setClientIdInput(e.target.value)}
                placeholder={creds?.hasClientId ? "(already set — enter new value to update)" : "86abc123…"}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">Client Secret</label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                type="password"
                value={clientSecretInput}
                onChange={(e) => setClientSecretInput(e.target.value)}
                placeholder={creds?.hasClientSecret ? "(already set — enter new value to update)" : "your-client-secret"}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveAppCredentials}
                disabled={isSaving || !clientIdInput.trim() || !clientSecretInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/20 disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" />
                {isSaving ? "Saving…" : "Save App Credentials"}
              </button>
              <button
                onClick={() => { setShowAppConfig(false); setClientIdInput(""); setClientSecretInput(""); }}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-border/80"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Connected state */}
        {creds?.configured ? (
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
              {status?.connected && status.profile && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  API connected
                  {typeof status.profile.localizedFirstName === "string" && (
                    <span>— {status.profile.localizedFirstName} {typeof status.profile.localizedLastName === "string" ? status.profile.localizedLastName : ""}</span>
                  )}
                </div>
              )}
              {status && !status.connected && (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400" />
                  {status.message ?? "Token invalid"}
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
        ) : (
          <div className="space-y-3">
            {creds?.oauthConfigured ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Connect your LinkedIn account using OAuth 2.0. This grants access to post on your behalf with automatic token refresh.
                </p>
                <button
                  onClick={handleOAuthConnect}
                  disabled={isConnecting}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#0A66C2] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#004182] disabled:opacity-50"
                >
                  <Link2 className="h-4 w-4" />
                  {isConnecting ? "Redirecting to LinkedIn…" : "Connect with LinkedIn"}
                </button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                To connect via OAuth, click &quot;Configure OAuth App&quot; above to enter your LinkedIn app Client ID and Secret.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
