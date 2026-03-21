"use client";

import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { Key, Save, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Link2, RefreshCw, LogOut, Copy, CheckCheck } from "lucide-react";
import { showToast } from "@/components/toast";

type SocialBrainCredentials = {
  webhookVerifyToken: { configured: boolean; preview: string };
  instagram: { configured: boolean; accessToken: string; businessAccountId: string };
  facebook: { configured: boolean; pageToken: string; appId: string; hasAppSecret: boolean; pageId: string };
  twitter: { configured: boolean; bearerToken: string; apiKey: string; hasApiSecret: boolean; accessToken: string; hasAccessTokenSecret: boolean };
  reddit: { configured: boolean; clientId: string; hasClientSecret: boolean };
  youtube: { configured: boolean; apiKey: string; channelId: string; channelHandle: string; oauthConfigured: boolean; hasRefreshToken: boolean; expiresAt: string | null; hasAccessToken: boolean };
};

function StatusBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="flex items-center gap-1 text-xs text-green-500 font-medium">
      <CheckCircle2 className="h-3 w-3" /> Connected
    </span>
  ) : (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <AlertCircle className="h-3 w-3" /> Not configured
    </span>
  );
}

function CollapsibleSection({ title, badge, children, defaultOpen = false }: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border bg-card/60">
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <Key className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-card-foreground">{title}</span>
          {badge}
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="border-t border-border/50 px-4 pb-4 pt-3">{children}</div>}
    </div>
  );
}

function InputRow({ label, value, onChange, placeholder, type = "text", hint }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SocialBrainPanel() {
  const queryClient = useQueryClient();

  // Credentials state
  const [webhookToken, setWebhookToken] = useState("");
  const [igToken, setIgToken] = useState("");
  const [igAccountId, setIgAccountId] = useState("");
  const [fbPageToken, setFbPageToken] = useState("");
  const [fbAppId, setFbAppId] = useState("");
  const [fbAppSecret, setFbAppSecret] = useState("");
  const [fbPageId, setFbPageId] = useState("");
  const [twBearer, setTwBearer] = useState("");
  const [twApiKey, setTwApiKey] = useState("");
  const [twApiSecret, setTwApiSecret] = useState("");
  const [twAccessToken, setTwAccessToken] = useState("");
  const [twAccessTokenSecret, setTwAccessTokenSecret] = useState("");
  const [redditClientId, setRedditClientId] = useState("");
  const [redditClientSecret, setRedditClientSecret] = useState("");
  const [ytApiKey, setYtApiKey] = useState("");
  const [ytChannelId, setYtChannelId] = useState("");
  const [ytChannelHandle, setYtChannelHandle] = useState("");

  // YouTube OAuth state
  const [ytClientId, setYtClientId] = useState("");
  const [ytClientSecret, setYtClientSecret] = useState("");
  const [showYtAppConfig, setShowYtAppConfig] = useState(false);
  const [isYtSavingApp, setIsYtSavingApp] = useState(false);
  const [isYtConnecting, setIsYtConnecting] = useState(false);
  const [isYtRefreshing, setIsYtRefreshing] = useState(false);
  const [isYtDisconnecting, setIsYtDisconnecting] = useState(false);
  const [ytCopied, setYtCopied] = useState(false);

  const YT_REDIRECT_URI = "http://localhost:3000/api/youtube/oauth/callback";
  const copyYtRedirectUri = () => {
    navigator.clipboard.writeText(YT_REDIRECT_URI).then(() => {
      setYtCopied(true);
      setTimeout(() => setYtCopied(false), 2000);
    }).catch(() => showToast("Failed to copy", "error"));
  };

  const ytCredsQuery = useQuery({
    queryKey: ["youtube-credentials"],
    queryFn: () => fetchJson<{ appConfigured: boolean; clientId: string; oauthConnected: boolean; hasRefreshToken: boolean; expiresAt: string | null; accessToken: string }>("/api/admin/youtube/credentials"),
  });
  const ytCreds = ytCredsQuery.data;

  // Handle YouTube OAuth callback redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("youtube_oauth");
    if (oauthResult === "success") {
      showToast("YouTube connected via OAuth!", "success");
      queryClient.invalidateQueries({ queryKey: ["youtube-credentials"] });
      queryClient.invalidateQueries({ queryKey: ["social-brain-credentials"] });
      const url = new URL(window.location.href);
      url.searchParams.delete("youtube_oauth");
      window.history.replaceState({}, "", url.toString());
    } else if (oauthResult === "error") {
      const message = params.get("message") ?? "YouTube OAuth authorization failed";
      showToast(message, "error");
      const url = new URL(window.location.href);
      url.searchParams.delete("youtube_oauth");
      url.searchParams.delete("message");
      window.history.replaceState({}, "", url.toString());
    }
  }, [queryClient]);

  const handleYtSaveAppCredentials = async () => {
    if (isYtSavingApp || !ytClientId.trim() || !ytClientSecret.trim()) return;
    setIsYtSavingApp(true);
    try {
      await fetchJson("/api/admin/youtube/app-credentials", {
        method: "POST",
        body: JSON.stringify({ clientId: ytClientId.trim(), clientSecret: ytClientSecret.trim() }),
      });
      showToast("YouTube OAuth app credentials saved", "success");
      setYtClientId("");
      setYtClientSecret("");
      setShowYtAppConfig(false);
      await queryClient.invalidateQueries({ queryKey: ["youtube-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["env"] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save app credentials", "error");
    } finally {
      setIsYtSavingApp(false);
    }
  };

  const handleYtOAuthConnect = async () => {
    setIsYtConnecting(true);
    try {
      const data = await fetchJson<{ url: string }>("/api/admin/youtube/oauth/authorize");
      window.location.href = data.url;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start OAuth flow", "error");
      setIsYtConnecting(false);
    }
  };

  const handleYtRefresh = async () => {
    setIsYtRefreshing(true);
    try {
      const result = await fetchJson<{ ok: boolean; expiresAt?: string; error?: string }>("/api/admin/youtube/oauth/refresh", { method: "POST" });
      if (result.ok) {
        showToast(`YouTube token refreshed — expires ${result.expiresAt ? new Date(result.expiresAt).toLocaleString() : "in ~1 hour"}`, "success");
        await queryClient.invalidateQueries({ queryKey: ["youtube-credentials"] });
        await queryClient.invalidateQueries({ queryKey: ["social-brain-credentials"] });
      } else {
        showToast(result.error ?? "Refresh failed", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to refresh token", "error");
    } finally {
      setIsYtRefreshing(false);
    }
  };

  const handleYtDisconnect = async () => {
    setIsYtDisconnecting(true);
    try {
      await fetchJson("/api/admin/youtube/oauth/disconnect", { method: "POST" });
      showToast("YouTube OAuth disconnected", "info");
      await queryClient.invalidateQueries({ queryKey: ["youtube-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["social-brain-credentials"] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to disconnect", "error");
    } finally {
      setIsYtDisconnecting(false);
    }
  };

  const [isSavingCreds, setIsSavingCreds] = useState(false);

  const credsQuery = useQuery({
    queryKey: ["social-brain-credentials"],
    queryFn: () => fetchJson<SocialBrainCredentials>("/api/admin/social-brain/credentials"),
  });

  const creds = credsQuery.data;

  const handleSaveCreds = async (section: "webhook" | "instagram" | "facebook" | "twitter" | "reddit" | "youtube") => {
    setIsSavingCreds(true);
    try {
      const payload: Record<string, string> = {};
      if (section === "webhook" && webhookToken) payload.webhookVerifyToken = webhookToken;
      if (section === "instagram") {
        if (igToken) payload.instagramAccessToken = igToken;
        if (igAccountId) payload.instagramBusinessAccountId = igAccountId;
      }
      if (section === "facebook") {
        if (fbPageToken) payload.facebookPageToken = fbPageToken;
        if (fbAppId) payload.facebookAppId = fbAppId;
        if (fbAppSecret) payload.facebookAppSecret = fbAppSecret;
        if (fbPageId) payload.facebookPageId = fbPageId;
      }
      if (section === "twitter") {
        if (twBearer) payload.twitterBearerToken = twBearer;
        if (twApiKey) payload.twitterApiKey = twApiKey;
        if (twApiSecret) payload.twitterApiSecret = twApiSecret;
        if (twAccessToken) payload.twitterAccessToken = twAccessToken;
        if (twAccessTokenSecret) payload.twitterAccessTokenSecret = twAccessTokenSecret;
      }
      if (section === "reddit") {
        if (redditClientId) payload.redditClientId = redditClientId;
        if (redditClientSecret) payload.redditClientSecret = redditClientSecret;
      }
      if (section === "youtube") {
        if (ytApiKey) payload.youtubeApiKey = ytApiKey;
        if (ytChannelId) payload.youtubeChannelId = ytChannelId;
        if (ytChannelHandle) payload.youtubeChannelHandle = ytChannelHandle;
      }
      if (Object.keys(payload).length === 0) {
        showToast("No values to save", "error");
        return;
      }
      await fetchJson("/api/admin/social-brain/credentials", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast("Credentials saved", "success");
      await queryClient.invalidateQueries({ queryKey: ["social-brain-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["env"] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save", "error");
    } finally {
      setIsSavingCreds(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Manage platform API credentials here. For AI behavior settings (model, response style, confidence, handoff), go to the{" "}
        <a href="/social" className="text-primary hover:underline">Social Brain</a> Settings tab.
      </p>

      {/* Webhook Verify Token */}
      <CollapsibleSection
        title="Webhook Verify Token"
        badge={<StatusBadge configured={creds?.webhookVerifyToken.configured ?? false} />}
        defaultOpen={!creds?.webhookVerifyToken.configured}
      >
        <div className="space-y-3">
          {creds?.webhookVerifyToken.configured && (
            <p className="text-xs text-muted-foreground">Current: <code className="font-mono bg-muted/30 px-1 rounded">{creds.webhookVerifyToken.preview}</code></p>
          )}
          <InputRow
            label="SOCIAL_WEBHOOK_VERIFY_TOKEN"
            value={webhookToken}
            onChange={setWebhookToken}
            placeholder="Enter a secret token for Meta webhook verification"
            hint="Used by Meta (Instagram/Facebook) to verify your webhook endpoint. Set the same value in Meta Developer Console."
          />
          <div className="flex justify-end">
            <button
              onClick={() => handleSaveCreds("webhook")}
              disabled={isSavingCreds || !webhookToken.trim()}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          </div>
          <div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Webhook URLs (same Cloudflare tunnel for all):</p>
            <p><code className="font-mono">https://&lt;your-domain&gt;/api/social/webhooks/instagram</code></p>
            <p><code className="font-mono">https://&lt;your-domain&gt;/api/social/webhooks/facebook</code></p>
            <p className="pt-1">No separate tunnel needed — all routes are served on port 3000.</p>
          </div>
        </div>
      </CollapsibleSection>

      {/* Instagram */}
      <CollapsibleSection
        title="Instagram (Meta Graph API)"
        badge={<StatusBadge configured={creds?.instagram.configured ?? false} />}
        defaultOpen={!creds?.instagram.configured}
      >
        <div className="space-y-3">
          {creds?.instagram.configured && (
            <p className="text-xs text-muted-foreground">Access token: <code className="font-mono bg-muted/30 px-1 rounded">{creds.instagram.accessToken}</code></p>
          )}
          {creds?.instagram.businessAccountId && (
            <p className="text-xs text-muted-foreground">Business account: <code className="font-mono">{creds.instagram.businessAccountId}</code></p>
          )}
          <InputRow label="Instagram Access Token" value={igToken} onChange={setIgToken} placeholder="EAAM…" hint="Long-lived user token from Meta Developer Console (graph.instagram.com/v19.0)" />
          <InputRow label="Instagram Business Account ID" value={igAccountId} onChange={setIgAccountId} placeholder="17841439350400283" hint="Your Instagram Business or Creator account ID (optional — used for account-level queries)" />
          <div className="flex justify-end">
            <button
              onClick={() => handleSaveCreds("instagram")}
              disabled={isSavingCreds || (!igToken.trim() && !igAccountId.trim())}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* Facebook */}
      <CollapsibleSection
        title="Facebook Page (Meta Graph API)"
        badge={<StatusBadge configured={creds?.facebook.configured ?? false} />}
        defaultOpen={!creds?.facebook.configured}
      >
        <div className="space-y-3">
          {creds?.facebook.configured && (
            <p className="text-xs text-muted-foreground">Page token: <code className="font-mono bg-muted/30 px-1 rounded">{creds.facebook.pageToken}</code></p>
          )}
          <InputRow label="Facebook Page Access Token" value={fbPageToken} onChange={setFbPageToken} placeholder="EAAM…" hint="Page-level access token — required for posting and Messenger" />
          <InputRow label="Facebook App ID" value={fbAppId} onChange={setFbAppId} placeholder="908978228709054" hint={creds?.facebook.appId ? `Current: ${creds.facebook.appId}` : "Your Meta App ID"} />
          <InputRow label="Facebook App Secret" value={fbAppSecret} onChange={setFbAppSecret} type="password" placeholder="••••••••" hint={creds?.facebook.hasAppSecret ? "App secret is set (••••)" : "Required for webhook verification"} />
          <InputRow label="Facebook Page ID" value={fbPageId} onChange={setFbPageId} placeholder="955369944333833" hint={creds?.facebook.pageId ? `Current: ${creds.facebook.pageId}` : "Your Facebook Page numeric ID"} />
          <div className="flex justify-end">
            <button
              onClick={() => handleSaveCreds("facebook")}
              disabled={isSavingCreds || (!fbPageToken.trim() && !fbAppId.trim() && !fbAppSecret.trim() && !fbPageId.trim())}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* Twitter */}
      <CollapsibleSection
        title="Twitter / X"
        badge={<StatusBadge configured={creds?.twitter.configured ?? false} />}
        defaultOpen={!creds?.twitter.configured}
      >
        <div className="space-y-3">
          {creds?.twitter.configured && (
            <p className="text-xs text-muted-foreground">Bearer token: <code className="font-mono bg-muted/30 px-1 rounded">{creds.twitter.bearerToken}</code></p>
          )}
          <InputRow label="Bearer Token" value={twBearer} onChange={setTwBearer} placeholder="AAAAAAAAAA…" hint="For read-only API access (search, user lookup)" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InputRow label="API Key" value={twApiKey} onChange={setTwApiKey} placeholder="hh4sC…" hint={creds?.twitter.apiKey ? `Current: ${creds.twitter.apiKey}` : "Consumer key"} />
            <InputRow label="API Secret" value={twApiSecret} onChange={setTwApiSecret} type="password" placeholder="••••••••" hint={creds?.twitter.hasApiSecret ? "API secret is set" : "Consumer secret"} />
            <InputRow label="Access Token" value={twAccessToken} onChange={setTwAccessToken} placeholder="893433…" hint={creds?.twitter.accessToken ? `Current: ${creds.twitter.accessToken}` : "User access token"} />
            <InputRow label="Access Token Secret" value={twAccessTokenSecret} onChange={setTwAccessTokenSecret} type="password" placeholder="••••••••" hint={creds?.twitter.hasAccessTokenSecret ? "Access token secret is set" : "Required for write operations"} />
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => handleSaveCreds("twitter")}
              disabled={isSavingCreds || (!twBearer.trim() && !twApiKey.trim() && !twApiSecret.trim() && !twAccessToken.trim() && !twAccessTokenSecret.trim())}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* Reddit */}
      <CollapsibleSection
        title="Reddit"
        badge={<StatusBadge configured={creds?.reddit.configured ?? false} />}
        defaultOpen={!creds?.reddit.configured}
      >
        <div className="space-y-3">
          {creds?.reddit.configured && (
            <p className="text-xs text-muted-foreground">Client ID: <code className="font-mono bg-muted/30 px-1 rounded">{creds.reddit.clientId}</code></p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InputRow label="Client ID" value={redditClientId} onChange={setRedditClientId} placeholder="AbCdEfGhIjKlMn" hint="From reddit.com/prefs/apps" />
            <InputRow label="Client Secret" value={redditClientSecret} onChange={setRedditClientSecret} type="password" placeholder="••••••••" hint={creds?.reddit.hasClientSecret ? "Client secret is set" : "Required for OAuth"} />
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => handleSaveCreds("reddit")}
              disabled={isSavingCreds || (!redditClientId.trim() && !redditClientSecret.trim())}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* YouTube */}
      <CollapsibleSection
        title="YouTube (Data API v3 + OAuth)"
        badge={<StatusBadge configured={creds?.youtube.configured ?? false} />}
        defaultOpen={!creds?.youtube.configured}
      >
        <div className="space-y-3">
          {creds?.youtube.configured && (
            <p className="text-xs text-muted-foreground">API Key: <code className="font-mono bg-muted/30 px-1 rounded">{creds.youtube.apiKey}</code></p>
          )}
          {creds?.youtube.channelId && (
            <p className="text-xs text-muted-foreground">Channel ID: <code className="font-mono">{creds.youtube.channelId}</code></p>
          )}
          {creds?.youtube.channelHandle && (
            <p className="text-xs text-muted-foreground">Channel Handle: <code className="font-mono">{creds.youtube.channelHandle}</code></p>
          )}
          <InputRow label="YouTube API Key" value={ytApiKey} onChange={setYtApiKey} type="password" placeholder="AIzaSy…" hint="From Google Cloud Console → APIs & Services → Credentials" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InputRow label="Channel ID" value={ytChannelId} onChange={setYtChannelId} placeholder="UCxxxxxxxxxxxxxxxxxxxxxx" hint="YouTube Studio → Settings → Channel → Advanced settings" />
            <InputRow label="Channel Handle" value={ytChannelHandle} onChange={setYtChannelHandle} placeholder="@YourChannel" hint="Alternative to Channel ID — your @handle" />
          </div>
          <div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
            <p>Provide either <strong>Channel ID</strong> or <strong>Channel Handle</strong> so the poller knows which channel to monitor for comments.</p>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => handleSaveCreds("youtube")}
              disabled={isSavingCreds || (!ytApiKey.trim() && !ytChannelId.trim() && !ytChannelHandle.trim())}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          </div>

          {/* YouTube OAuth Section */}
          <div className="mt-4 border-t border-border/50 pt-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-card-foreground">OAuth 2.0 (Write Access)</h4>
              <div className="flex items-center gap-2">
                {!ytCreds?.appConfigured && !showYtAppConfig && (
                  <button onClick={() => setShowYtAppConfig(true)} className="text-xs text-primary hover:underline">
                    Configure OAuth App
                  </button>
                )}
                {ytCreds?.appConfigured && !showYtAppConfig && (
                  <button onClick={() => setShowYtAppConfig(true)} className="text-xs text-muted-foreground hover:text-primary hover:underline">
                    Edit App Credentials
                  </button>
                )}
              </div>
            </div>

            {/* App credentials config (Client ID + Secret) */}
            {showYtAppConfig && (
              <div className="mb-4 space-y-3 rounded-lg border border-border/50 bg-background/50 p-3">
                <p className="text-xs text-muted-foreground">
                  Create OAuth 2.0 credentials at{" "}
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    Google Cloud Console → Credentials
                  </a>
                  . Choose <strong>Web application</strong> and add this redirect URI:
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                  <code className="flex-1 text-xs font-mono text-foreground">{YT_REDIRECT_URI}</code>
                  <button onClick={copyYtRedirectUri} className="shrink-0 text-muted-foreground hover:text-primary transition" title="Copy redirect URI">
                    {ytCopied ? <CheckCheck className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Ensure the <strong>YouTube Data API v3</strong> is enabled in your Google Cloud project.
                </p>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-medium text-muted-foreground">Client ID</label>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                    value={ytClientId}
                    onChange={(e) => setYtClientId(e.target.value)}
                    placeholder={ytCreds?.appConfigured ? "(already set — enter new value to update)" : "123456789-abc.apps.googleusercontent.com"}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-medium text-muted-foreground">Client Secret</label>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50"
                    type="password"
                    value={ytClientSecret}
                    onChange={(e) => setYtClientSecret(e.target.value)}
                    placeholder={ytCreds?.appConfigured ? "(already set — enter new value to update)" : "GOCSPX-…"}
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleYtSaveAppCredentials}
                    disabled={isYtSavingApp || !ytClientId.trim() || !ytClientSecret.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/20 disabled:opacity-40"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {isYtSavingApp ? "Saving…" : "Save App Credentials"}
                  </button>
                  <button
                    onClick={() => { setShowYtAppConfig(false); setYtClientId(""); setYtClientSecret(""); }}
                    className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-border/80"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Connected state */}
            {ytCreds?.oauthConnected ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                    <span className="text-card-foreground">
                      OAuth Token: <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{ytCreds.accessToken}</code>
                    </span>
                    {ytCreds.hasRefreshToken && (
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-400">OAuth</span>
                    )}
                  </div>
                  {ytCreds.expiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Token expires: {new Date(ytCreds.expiresAt).toLocaleString()}
                      {ytCreds.hasRefreshToken && <span className="text-emerald-400 ml-1">(auto-refresh enabled)</span>}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {ytCreds.hasRefreshToken && (
                    <button
                      onClick={handleYtRefresh}
                      disabled={isYtRefreshing}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-primary"
                    >
                      <RefreshCw className={`h-3 w-3 ${isYtRefreshing ? "animate-spin" : ""}`} />
                      {isYtRefreshing ? "Refreshing…" : "Refresh Token"}
                    </button>
                  )}
                  <button
                    onClick={handleYtDisconnect}
                    disabled={isYtDisconnecting}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-red-400 transition hover:border-red-400/30 hover:bg-red-400/5"
                  >
                    <LogOut className="h-3 w-3" />
                    {isYtDisconnecting ? "Disconnecting…" : "Disconnect"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {ytCreds?.appConfigured ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Connect your YouTube/Google account via OAuth 2.0 to enable comment replies and video uploads.
                    </p>
                    <button
                      onClick={handleYtOAuthConnect}
                      disabled={isYtConnecting}
                      className="inline-flex items-center gap-2 rounded-lg bg-[#FF0000] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#CC0000] disabled:opacity-50"
                    >
                      <Link2 className="h-4 w-4" />
                      {isYtConnecting ? "Redirecting to Google…" : "Connect with YouTube"}
                    </button>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    To enable comment replies and video uploads, click &quot;Configure OAuth App&quot; above to enter your Google OAuth Client ID and Secret.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </CollapsibleSection>
    </div>
  );
}
