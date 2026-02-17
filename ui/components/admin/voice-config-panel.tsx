/**
 * VoiceConfigPanel — Full voice & audio configuration + sidecar monitoring
 * Combines provider selection, voice settings, and sidecar health into one panel.
 * Available in both chat and director modes.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  Activity,
  Cpu,
  Mic,
  Volume2,
  RefreshCw,
  Trash2,
  Play,
  Settings2,
  Power,
  Globe,
  Laptop,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* ── Types ── */

type SidecarHealth = {
  status: string;
  ttsLoaded: boolean;
  sttLoaded: boolean;
  ttsModel: string | null;
  sttModel: string | null;
};

type LocalVoice = {
  id: string;
  name: string;
  language: string;
  gender: string;
  style: string;
};

type VoiceHealthResponse = {
  provider: string;
  sidecar?: SidecarHealth;
  sidecarUrl?: string;
};

type VoiceListResponse = {
  provider: string;
  voices: LocalVoice[];
};

type VoiceConfigResponse = {
  enabled: boolean;
  provider: "google" | "local";
  voiceName: string;
  speakingRate: number;
  pitch: number;
  sidecarUrl: string;
  maxTextLength: number;
  maxCacheSizeMb: number;
};

type GoogleVoice = {
  id: string;
  type: "Standard" | "Neural2" | "Journey";
  description: string;
  pricingTier: "free-tier-preferred" | "paid-tier";
};

type GoogleVoiceSettingsResponse = {
  voiceName: string;
  recommendedFreeTierVoice: string;
  availableVoices: GoogleVoice[];
};

/* ── Component ── */

export function VoiceConfigPanel() {
  const queryClient = useQueryClient();
  const [previewVoice, setPreviewVoice] = useState<string | null>(null);
  const [isUnloading, setIsUnloading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Local form state
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<"google" | "local">("google");
  const [sidecarUrl, setSidecarUrl] = useState("http://localhost:5006");
  const [speakingRate, setSpeakingRate] = useState(1.0);
  const [pitch, setPitch] = useState(0.0);
  const [voiceName, setVoiceName] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  // Google TTS credentials (env var)
  const [googleCredsPath, setGoogleCredsPath] = useState("");
  const [isCredsDirty, setIsCredsDirty] = useState(false);
  const [isSavingCreds, setIsSavingCreds] = useState(false);

  /* ── Queries ── */

  const configQuery = useQuery({
    queryKey: ["voice-config"],
    queryFn: () => fetchJson<VoiceConfigResponse>("/api/admin/voice-config"),
  });

  const healthQuery = useQuery({
    queryKey: ["voice-health"],
    queryFn: () => fetchJson<VoiceHealthResponse>("/api/voice/health"),
    refetchInterval: 15000,
  });

  const voicesQuery = useQuery({
    queryKey: ["voice-local-voices"],
    queryFn: () => fetchJson<VoiceListResponse>("/api/voice/voices"),
  });

  const googleVoicesQuery = useQuery({
    queryKey: ["voice-settings"],
    queryFn: () => fetchJson<GoogleVoiceSettingsResponse>("/api/admin/voice-settings"),
  });

  const googleCredsQuery = useQuery({
    queryKey: ["voice-tts-credentials"],
    queryFn: () => fetchJson<{ value: string }>("/api/admin/voice-tts-credentials"),
  });

  const config = configQuery.data;
  const health = healthQuery.data;
  const sidecar = health?.sidecar;
  const voices = voicesQuery.data?.voices ?? [];
  const sidecarUp = sidecar?.status === "ok";
  const googleVoices = googleVoicesQuery.data?.availableVoices ?? [];

  /* ── Sync form state from server ── */

  useEffect(() => {
    if (config && !isDirty) {
      setEnabled(config.enabled);
      setProvider(config.provider);
      setSidecarUrl(config.sidecarUrl);
      setSpeakingRate(config.speakingRate);
      setPitch(config.pitch);
      setVoiceName(config.voiceName);
    }
  }, [config, isDirty]);

  useEffect(() => {
    if (googleCredsQuery.data && !isCredsDirty) {
      setGoogleCredsPath(googleCredsQuery.data.value);
    }
  }, [googleCredsQuery.data, isCredsDirty]);

  /* ── Handlers ── */

  const markDirty = () => setIsDirty(true);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await fetchJson("/api/admin/voice-config", {
        method: "POST",
        body: JSON.stringify({ enabled, provider, voiceName, sidecarUrl, speakingRate, pitch }),
      });
      await queryClient.invalidateQueries({ queryKey: ["voice-config"] });
      setIsDirty(false);
      showToast("Voice configuration saved. Restart required to apply.", "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      showToast(msg, "error");
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, enabled, provider, voiceName, sidecarUrl, speakingRate, pitch, queryClient]);

  const handleSaveGoogleCreds = useCallback(async () => {
    if (isSavingCreds) return;
    setIsSavingCreds(true);
    try {
      await fetchJson("/api/admin/voice-tts-credentials", {
        method: "POST",
        body: JSON.stringify({ value: googleCredsPath.trim() }),
      });
      await queryClient.invalidateQueries({ queryKey: ["voice-tts-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["env"] });
      setIsCredsDirty(false);
      showToast("Google Cloud TTS credentials saved. Restart required.", "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save credentials";
      showToast(msg, "error");
    } finally {
      setIsSavingCreds(false);
    }
  }, [isSavingCreds, googleCredsPath, queryClient]);

  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["voice-health"] });
    await queryClient.invalidateQueries({ queryKey: ["voice-local-voices"] });
    await queryClient.invalidateQueries({ queryKey: ["voice-config"] });
  }, [queryClient]);

  const handleUnload = useCallback(
    async (model: "tts" | "stt" | "all") => {
      setIsUnloading(true);
      try {
        await fetchJson("/api/voice/unload", {
          method: "POST",
          body: JSON.stringify({ model }),
        });
        showToast(`Unloaded ${model} model(s)`, "info");
        await handleRefresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to unload";
        showToast(msg, "error");
      } finally {
        setIsUnloading(false);
      }
    },
    [handleRefresh],
  );

  const handlePreview = useCallback(async (voiceId: string) => {
    setPreviewVoice(voiceId);
    try {
      const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
      const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
      const res = await fetch(`${API_BASE}/api/voice/preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: "Hello, this is a voice preview.", voiceName: voiceId }),
      });
      if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); setPreviewVoice(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPreviewVoice(null); };
      await audio.play();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Preview failed";
      showToast(msg, "error");
      setPreviewVoice(null);
    }
  }, []);

  if (configQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading voice configuration…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Voice Enable + Provider Selection ── */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Settings2 className="h-4 w-4" />
            Voice Configuration
          </h3>
          <div className="flex items-center gap-2">
            {isDirty && (
              <span className="text-[10px] font-medium text-amber-500">Unsaved changes</span>
            )}
            <Button
              variant="default"
              size="sm"
              className="text-xs"
              disabled={!isDirty || isSaving}
              onClick={handleSave}
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {/* Enabled toggle */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2">
            <div className="flex items-center gap-2">
              <Power className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-foreground">Voice Enabled</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => { setEnabled(!enabled); markDirty(); }}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                enabled ? "bg-moss" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                  enabled ? "translate-x-4" : "translate-x-0",
                )}
              />
            </button>
          </div>

          {/* Provider selection */}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <span className="text-xs font-medium text-foreground mr-2">Provider</span>
            <button
              type="button"
              onClick={() => { setProvider("local"); markDirty(); }}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition",
                provider === "local"
                  ? "bg-moss/15 text-moss border border-moss/30"
                  : "bg-background text-muted-foreground border border-border hover:bg-muted/50",
              )}
            >
              <Laptop className="h-3 w-3" />
              Local
            </button>
            <button
              type="button"
              onClick={() => { setProvider("google"); markDirty(); }}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition",
                provider === "google"
                  ? "bg-blue-500/15 text-blue-600 border border-blue-500/30"
                  : "bg-background text-muted-foreground border border-border hover:bg-muted/50",
              )}
            >
              <Globe className="h-3 w-3" />
              Google Cloud
            </button>
          </div>
        </div>

        {/* Provider-specific settings */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {provider === "local" && (
            <>
              {/* Sidecar URL */}
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Sidecar URL</label>
                <input
                  className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
                  value={sidecarUrl}
                  onChange={(e) => { setSidecarUrl(e.target.value); markDirty(); }}
                  placeholder="http://localhost:5006"
                />
              </div>

              {/* Local voice selection */}
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Default Voice</label>
                {voices.length > 0 ? (
                  <select
                    className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={voiceName}
                    onChange={(e) => { setVoiceName(e.target.value); markDirty(); }}
                  >
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} — {v.language} · {v.gender}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={voiceName}
                    onChange={(e) => { setVoiceName(e.target.value); markDirty(); }}
                    placeholder="af_heart"
                  />
                )}
              </div>
            </>
          )}

          {provider === "google" && (
            <>
              {/* Google voice selection */}
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Google TTS Voice</label>
                <select
                  className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
                  value={voiceName}
                  onChange={(e) => { setVoiceName(e.target.value); markDirty(); }}
                >
                  {googleVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.id} — {v.type} ({v.pricingTier === "free-tier-preferred" ? "free" : "paid"})
                    </option>
                  ))}
                </select>
              </div>

              {/* Google credentials path */}
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">
                  Credentials Path (<code className="text-[10px] font-mono">GOOGLE_APPLICATION_CREDENTIALS</code>)
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={googleCredsPath}
                    onChange={(e) => { setGoogleCredsPath(e.target.value); setIsCredsDirty(true); }}
                    placeholder="$HOME/.openzigs/gcp-tts-key.json"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs shrink-0"
                    disabled={!isCredsDirty || isSavingCreds}
                    onClick={handleSaveGoogleCreds}
                  >
                    {isSavingCreds ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Speaking rate (both providers) */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">
              Speaking Rate ({speakingRate.toFixed(2)}x)
            </label>
            <input
              type="range"
              min="0.25"
              max="4.0"
              step="0.05"
              className="mt-1 w-full accent-moss"
              value={speakingRate}
              onChange={(e) => { setSpeakingRate(parseFloat(e.target.value)); markDirty(); }}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>0.25x</span>
              <span>1.0x</span>
              <span>4.0x</span>
            </div>
          </div>

          {/* Pitch (both providers) */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">
              Pitch ({pitch > 0 ? "+" : ""}{pitch.toFixed(1)})
            </label>
            <input
              type="range"
              min="-20"
              max="20"
              step="0.5"
              className="mt-1 w-full accent-moss"
              value={pitch}
              onChange={(e) => { setPitch(parseFloat(e.target.value)); markDirty(); }}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>-20</span>
              <span>0</span>
              <span>+20</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Sidecar Status (always shown for local provider) ── */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="h-4 w-4" />
            Sidecar Status
          </h3>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {/* Provider badge */}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                (health?.provider === "local") ? "bg-moss" : (health?.provider === "google") ? "bg-blue-500" : "bg-muted-foreground/30",
              )}
            />
            <span className="text-xs font-medium text-foreground">
              {health?.provider === "local" ? "Local (Audio Sidecar)" : health?.provider === "google" ? "Google Cloud TTS" : "Not Configured"}
            </span>
          </div>

          {/* Sidecar online/offline */}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <span className={cn("h-2 w-2 rounded-full", sidecarUp ? "bg-moss" : "bg-destructive")} />
            <span className="text-xs font-medium text-foreground">
              Sidecar: {sidecarUp ? "Online" : "Offline"}
            </span>
            {health?.sidecarUrl && (
              <span className="ml-auto text-[10px] text-muted-foreground font-mono">{health.sidecarUrl}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Loaded Models ── */}
      {sidecarUp && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Cpu className="h-4 w-4" />
            Loaded Models
          </h3>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {/* TTS */}
            <div className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2">
              <div className="flex items-center gap-2">
                <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <span className="text-xs font-medium text-foreground">TTS</span>
                  <p className="text-[10px] text-muted-foreground">
                    {sidecar?.ttsLoaded ? sidecar.ttsModel ?? "Kokoro" : "Not loaded"}
                  </p>
                </div>
              </div>
              <span className={cn("h-2 w-2 rounded-full", sidecar?.ttsLoaded ? "bg-moss" : "bg-muted-foreground/30")} />
            </div>

            {/* STT */}
            <div className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2">
              <div className="flex items-center gap-2">
                <Mic className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <span className="text-xs font-medium text-foreground">STT</span>
                  <p className="text-[10px] text-muted-foreground">
                    {sidecar?.sttLoaded ? sidecar.sttModel ?? "Whisper" : "Not loaded"}
                  </p>
                </div>
              </div>
              <span className={cn("h-2 w-2 rounded-full", sidecar?.sttLoaded ? "bg-moss" : "bg-muted-foreground/30")} />
            </div>
          </div>

          {/* Unload buttons */}
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={isUnloading || (!sidecar?.ttsLoaded && !sidecar?.sttLoaded)}
              onClick={() => handleUnload("all")}
            >
              <Trash2 className="mr-1.5 h-3 w-3" />
              {isUnloading ? "Unloading…" : "Unload All"}
            </Button>
            {sidecar?.ttsLoaded && (
              <Button variant="outline" size="sm" className="text-xs" disabled={isUnloading} onClick={() => handleUnload("tts")}>
                Unload TTS
              </Button>
            )}
            {sidecar?.sttLoaded && (
              <Button variant="outline" size="sm" className="text-xs" disabled={isUnloading} onClick={() => handleUnload("stt")}>
                Unload STT
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Local Voice Browser ── */}
      {voices.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Volume2 className="h-4 w-4" />
            Local Voices ({voices.length})
          </h3>
          <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {voices.map((voice) => (
              <div
                key={voice.id}
                className="flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{voice.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {voice.language} · {voice.gender} · {voice.style}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-2 h-6 w-6 shrink-0"
                  disabled={previewVoice === voice.id}
                  onClick={() => handlePreview(voice.id)}
                  title={`Preview ${voice.name}`}
                >
                  <Play className={cn("h-3 w-3", previewVoice === voice.id && "animate-pulse")} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
