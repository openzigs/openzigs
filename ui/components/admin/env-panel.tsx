"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { EnvEntry } from "@/lib/types";
import { showToast } from "@/components/toast";

type AllowedDirsResponse = {
  value: string;
};

type VoiceTtsCredentialsResponse = {
  value: string;
};

type VoiceOption = {
  id: string;
  type: "Standard" | "Neural2" | "Journey";
  description: string;
  pricingTier: "free-tier-preferred" | "paid-tier";
};

type VoiceSettingsResponse = {
  voiceName: string;
  recommendedFreeTierVoice: string;
  availableVoices: VoiceOption[];
};

export const EnvPanel = () => {
  const queryClient = useQueryClient();
  const [allowedDirsInput, setAllowedDirsInput] = useState("");
  const [voiceTtsCredentialsInput, setVoiceTtsCredentialsInput] = useState("");
  const [voiceNameInput, setVoiceNameInput] = useState("en-US-Standard-C");
  const [isDirty, setIsDirty] = useState(false);
  const [isVoiceTtsDirty, setIsVoiceTtsDirty] = useState(false);
  const [isVoiceConfigDirty, setIsVoiceConfigDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingVoiceTts, setIsSavingVoiceTts] = useState(false);
  const [isSavingVoiceConfig, setIsSavingVoiceConfig] = useState(false);

  const envQuery = useQuery({
    queryKey: ["env"],
    queryFn: () => fetchJson<{ env: EnvEntry[] }>("/api/admin/env"),
  });

  const allowedDirsQuery = useQuery({
    queryKey: ["allowed-dirs"],
    queryFn: () => fetchJson<AllowedDirsResponse>("/api/admin/allowed-dirs"),
    initialData: { value: "" },
  });

  const voiceTtsCredentialsQuery = useQuery({
    queryKey: ["voice-tts-credentials"],
    queryFn: () => fetchJson<VoiceTtsCredentialsResponse>("/api/admin/voice-tts-credentials"),
    initialData: { value: "" },
  });

  const voiceSettingsQuery = useQuery({
    queryKey: ["voice-settings"],
    queryFn: () => fetchJson<VoiceSettingsResponse>("/api/admin/voice-settings"),
    initialData: {
      voiceName: "en-US-Standard-C",
      recommendedFreeTierVoice: "en-US-Standard-C",
      availableVoices: [],
    },
  });

  const currentAllowedDirs = allowedDirsQuery.data?.value ?? "";
  const currentVoiceTtsCredentials = voiceTtsCredentialsQuery.data?.value ?? "";
  const currentVoiceName = voiceSettingsQuery.data?.voiceName ?? "en-US-Standard-C";

  useEffect(() => {
    if (!isDirty) {
      setAllowedDirsInput(currentAllowedDirs);
    }
  }, [currentAllowedDirs, isDirty]);

  useEffect(() => {
    if (!isVoiceTtsDirty) {
      setVoiceTtsCredentialsInput(currentVoiceTtsCredentials);
    }
  }, [currentVoiceTtsCredentials, isVoiceTtsDirty]);

  useEffect(() => {
    if (!isVoiceConfigDirty) {
      setVoiceNameInput(currentVoiceName);
    }
  }, [currentVoiceName, isVoiceConfigDirty]);

  const envItems = envQuery.data?.env ?? [];
  const isLoading = envQuery.isLoading;
  const hasEnvItems = envItems.length > 0;

  const normalizedInput = useMemo(() => {
    return allowedDirsInput
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(",");
  }, [allowedDirsInput]);

  const handleSaveAllowedDirs = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await fetchJson("/api/admin/allowed-dirs", {
        method: "POST",
        body: JSON.stringify({ value: normalizedInput }),
      });
      await queryClient.invalidateQueries({ queryKey: ["allowed-dirs"] });
      setIsDirty(false);
      showToast("Allowed directories saved. Restart required to apply.", "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save allowed directories";
      showToast(message, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveVoiceTtsCredentials = async () => {
    if (isSavingVoiceTts) return;
    setIsSavingVoiceTts(true);
    try {
      const value = voiceTtsCredentialsInput.trim();
      await fetchJson("/api/admin/voice-tts-credentials", {
        method: "POST",
        body: JSON.stringify({ value }),
      });
      await queryClient.invalidateQueries({ queryKey: ["voice-tts-credentials"] });
      await queryClient.invalidateQueries({ queryKey: ["env"] });
      setIsVoiceTtsDirty(false);
      showToast("Google Cloud TTS credentials path saved. Restart required to apply.", "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save Google Cloud TTS credentials path";
      showToast(message, "error");
    } finally {
      setIsSavingVoiceTts(false);
    }
  };

  const handleSaveVoiceSettings = async () => {
    if (isSavingVoiceConfig) return;
    setIsSavingVoiceConfig(true);
    try {
      await fetchJson("/api/admin/voice-settings", {
        method: "POST",
        body: JSON.stringify({ voiceName: voiceNameInput }),
      });
      await queryClient.invalidateQueries({ queryKey: ["voice-settings"] });
      setIsVoiceConfigDirty(false);
      showToast("Voice selection saved. Restart required to apply.", "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save voice selection";
      showToast(message, "error");
    } finally {
      setIsSavingVoiceConfig(false);
    }
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Filesystem allowlist</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Comma-separated list of directories the filesystem tools can read/write.
          Changes update <code className="font-mono text-[11px]">OPENZIGS_ALLOWED_DIRS</code> in .env.
        </p>
        <div className="mt-3 flex flex-col gap-2 lg:flex-row">
          <input
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
            value={allowedDirsInput}
            onChange={(event) => {
              setAllowedDirsInput(event.target.value);
              setIsDirty(true);
            }}
            placeholder="/Users/name/projects,/data/shared"
          />
          <button
            className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
            onClick={handleSaveAllowedDirs}
            disabled={isSaving}
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Restart the backend after saving to apply new allowlist paths.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Voice TTS credentials</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Path to the Google Cloud service account JSON key used for voice Text-to-Speech.
          Changes update <code className="font-mono text-[11px]">GOOGLE_APPLICATION_CREDENTIALS</code> in .env.
        </p>
        <div className="mt-3 flex flex-col gap-2 lg:flex-row">
          <input
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
            value={voiceTtsCredentialsInput}
            onChange={(event) => {
              setVoiceTtsCredentialsInput(event.target.value);
              setIsVoiceTtsDirty(true);
            }}
            placeholder="$HOME/.openzigs/gcp-tts-key.json"
          />
          <button
            className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
            onClick={handleSaveVoiceTtsCredentials}
            disabled={isSavingVoiceTts}
          >
            {isSavingVoiceTts ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Restart the backend after saving to apply the new TTS credential path.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Voice TTS voice</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick a Google Cloud TTS voice. <strong>Standard</strong> voices are free-tier preferred; Neural2 and Journey may incur paid usage.
        </p>
        <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center">
          <select
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
            value={voiceNameInput}
            onChange={(event) => {
              setVoiceNameInput(event.target.value);
              setIsVoiceConfigDirty(true);
            }}
          >
            {(voiceSettingsQuery.data?.availableVoices ?? []).map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.id} — {voice.type} ({voice.pricingTier === "free-tier-preferred" ? "free-tier preferred" : "paid tier"})
              </option>
            ))}
          </select>
          <button
            className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
            onClick={handleSaveVoiceSettings}
            disabled={isSavingVoiceConfig}
          >
            {isSavingVoiceConfig ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Recommended free-tier voice: {voiceSettingsQuery.data?.recommendedFreeTierVoice ?? "en-US-Standard-C"}. Restart the backend after saving.
        </p>
      </div>

      {hasEnvItems ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {envItems.map((item) => (
            <div
              key={item.name}
              className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  item.configured ? "bg-moss" : "bg-destructive"
                }`}
              />
              <span className="text-xs font-medium text-foreground">{item.label ?? item.name}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No environment items.</p>
      )}
    </div>
  );
};
