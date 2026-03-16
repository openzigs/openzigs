"use client";

import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { Key, Save, ChevronDown, ChevronRight, CheckCircle2, AlertCircle } from "lucide-react";
import { showToast } from "@/components/toast";

type SocialBrainCredentials = {
  webhookVerifyToken: { configured: boolean; preview: string };
  instagram: { configured: boolean; accessToken: string; businessAccountId: string };
  facebook: { configured: boolean; pageToken: string; appId: string; hasAppSecret: boolean; pageId: string };
  twitter: { configured: boolean; bearerToken: string; apiKey: string; hasApiSecret: boolean; accessToken: string; hasAccessTokenSecret: boolean };
  reddit: { configured: boolean; clientId: string; hasClientSecret: boolean };
};

type SocialBrainSettings = {
  enabled: boolean;
  confidenceThreshold: "high" | "medium" | "low";
  commentAutomation: boolean;
  handoff: {
    preferredChannel?: string;
    discordChannelId?: string;
    telegramChatId?: string;
    autoArchiveMinutes?: number;
  };
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

  // Settings state
  const [sbEnabled, setSbEnabled] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState<"high" | "medium" | "low">("high");
  const [commentAutomation, setCommentAutomation] = useState(false);
  const [handoffChannel, setHandoffChannel] = useState("");
  const [discordChannelId, setDiscordChannelId] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");

  const [isSavingCreds, setIsSavingCreds] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  const credsQuery = useQuery({
    queryKey: ["social-brain-credentials"],
    queryFn: () => fetchJson<SocialBrainCredentials>("/api/admin/social-brain/credentials"),
  });

  const settingsQuery = useQuery({
    queryKey: ["social-brain-settings"],
    queryFn: () => fetchJson<SocialBrainSettings>("/api/admin/social-brain/settings"),
    staleTime: 10_000,
  });

  // Populate settings from query when loaded
  const settings = settingsQuery.data;

  useEffect(() => {
    if (!settings) return;
    setSbEnabled(settings.enabled);
    setConfidenceThreshold(settings.confidenceThreshold);
    setCommentAutomation(settings.commentAutomation);
    setHandoffChannel(settings.handoff?.preferredChannel ?? "");
    setDiscordChannelId(settings.handoff?.discordChannelId ?? "");
    setTelegramChatId(settings.handoff?.telegramChatId ?? "");
  }, [settings]);

  const creds = credsQuery.data;

  const handleSaveCreds = async (section: "webhook" | "instagram" | "facebook" | "twitter" | "reddit") => {
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

  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      await fetchJson("/api/admin/social-brain/settings", {
        method: "POST",
        body: JSON.stringify({
          enabled: sbEnabled,
          confidenceThreshold,
          commentAutomation,
          handoff: {
            preferredChannel: handoffChannel || undefined,
            discordChannelId: discordChannelId || undefined,
            telegramChatId: telegramChatId || undefined,
          },
        }),
      });
      showToast("Settings saved", "success");
      await queryClient.invalidateQueries({ queryKey: ["social-brain-settings"] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save settings", "error");
    } finally {
      setIsSavingSettings(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* General Settings */}
      <div className="rounded-xl border border-border bg-card/60 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-card-foreground">General Settings</h3>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-foreground">Enable Social Brain</p>
            <p className="text-xs text-muted-foreground">Activates AI-powered DM automation and comment responses</p>
          </div>
          <button
            onClick={() => setSbEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${sbEnabled ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${sbEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-foreground">Comment Automation</p>
            <p className="text-xs text-muted-foreground">Auto-reply and DM triggers based on keyword rules</p>
          </div>
          <button
            onClick={() => setCommentAutomation((v) => !v)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${commentAutomation ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${commentAutomation ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">AI Confidence Threshold</label>
          <select
            value={confidenceThreshold}
            onChange={(e) => setConfidenceThreshold(e.target.value as "high" | "medium" | "low")}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="high">High — only auto-reply when very confident</option>
            <option value="medium">Medium — balance automation and escalation</option>
            <option value="low">Low — maximize automation, escalate rarely</option>
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Handoff Channel</label>
            <select
              value={handoffChannel}
              onChange={(e) => setHandoffChannel(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">None</option>
              <option value="discord">Discord</option>
              <option value="telegram">Telegram</option>
            </select>
          </div>
          {handoffChannel === "discord" && (
            <InputRow label="Discord Channel ID" value={discordChannelId} onChange={setDiscordChannelId} placeholder="1234567890" />
          )}
          {handoffChannel === "telegram" && (
            <InputRow label="Telegram Chat ID" value={telegramChatId} onChange={setTelegramChatId} placeholder="-100123456789" />
          )}
        </div>

        <div className="flex justify-end">
          <button
            onClick={handleSaveSettings}
            disabled={isSavingSettings}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {isSavingSettings ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>

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
    </div>
  );
}
