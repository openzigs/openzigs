/**
 * VoiceStatusPanel — Sidecar health, model status, and local voice configuration
 * Issue #265: Admin panel for monitoring and managing the audio sidecar
 */

"use client";

import { useCallback, useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

export function VoiceStatusPanel() {
  const queryClient = useQueryClient();
  const [previewVoice, setPreviewVoice] = useState<string | null>(null);
  const [isUnloading, setIsUnloading] = useState(false);

  const healthQuery = useQuery({
    queryKey: ["voice-health"],
    queryFn: () => fetchJson<VoiceHealthResponse>("/api/voice/health"),
    refetchInterval: 15000,
  });

  const voicesQuery = useQuery({
    queryKey: ["voice-local-voices"],
    queryFn: () => fetchJson<VoiceListResponse>("/api/voice/voices"),
  });

  const health = healthQuery.data;
  const sidecar = health?.sidecar;
  const voices = voicesQuery.data?.voices ?? [];
  const provider = health?.provider ?? "unknown";
  const sidecarUp = sidecar?.status === "ok";

  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["voice-health"] });
    await queryClient.invalidateQueries({ queryKey: ["voice-local-voices"] });
  }, [queryClient]);

  const handleUnload = useCallback(
    async (model: "tts" | "stt" | "all") => {
      setIsUnloading(true);
      try {
        await fetchJson(`/api/voice/unload`, {
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

  const handlePreview = useCallback(
    async (voiceId: string) => {
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
          body: JSON.stringify({ text: "Hello, this is a voice preview.", voice: voiceId }),
        });

        if (!res.ok) {
          throw new Error(`Preview failed: ${res.status}`);
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setPreviewVoice(null);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setPreviewVoice(null);
        };
        await audio.play();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Preview failed";
        showToast(msg, "error");
        setPreviewVoice(null);
      }
    },
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Provider & Sidecar Status */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="h-4 w-4" />
            Voice Provider
          </h3>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {/* Provider */}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                provider === "local" ? "bg-moss" : provider === "google" ? "bg-blue-500" : "bg-muted-foreground/30",
              )}
            />
            <span className="text-xs font-medium text-foreground">
              {provider === "local" ? "Local (Audio Sidecar)" : provider === "google" ? "Google Cloud TTS" : "Not Configured"}
            </span>
          </div>

          {/* Sidecar Health */}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <span
              className={cn("h-2 w-2 rounded-full", sidecarUp ? "bg-moss" : "bg-destructive")}
            />
            <span className="text-xs font-medium text-foreground">
              Sidecar: {sidecarUp ? "Online" : "Offline"}
            </span>
            {health?.sidecarUrl && (
              <span className="ml-auto text-[10px] text-muted-foreground font-mono">
                {health.sidecarUrl}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Model Status */}
      {sidecarUp && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Cpu className="h-4 w-4" />
            Loaded Models
          </h3>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {/* TTS Model */}
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
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  sidecar?.ttsLoaded ? "bg-moss" : "bg-muted-foreground/30",
                )}
              />
            </div>

            {/* STT Model */}
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
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  sidecar?.sttLoaded ? "bg-moss" : "bg-muted-foreground/30",
                )}
              />
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
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={isUnloading}
                onClick={() => handleUnload("tts")}
              >
                Unload TTS
              </Button>
            )}
            {sidecar?.sttLoaded && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={isUnloading}
                onClick={() => handleUnload("stt")}
              >
                Unload STT
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Local Voice Browser */}
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
