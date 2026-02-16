"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { ModelInfo } from "@/lib/types";
import { Check, Eye, EyeOff, Loader2 } from "lucide-react";

type DirectorConfig = {
  enabled: boolean;
  outputDir: string;
  defaultTemplate: string;
  defaultModel: string;
  pixabayApiKey: string;
  jamendoClientId: string;
  pexelsApiKey: string;
  pixabayConfigured: boolean;
  jamendoConfigured: boolean;
  pexelsConfigured: boolean;
};

export const DirectorPanel = () => {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["director-config"],
    queryFn: () => fetchJson<DirectorConfig>("/api/admin/director/config"),
  });

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<{ models: ModelInfo[]; selectedModel?: string | null }>("/api/models"),
  });

  const [pixabayKey, setPixabayKey] = useState("");
  const [jamendoId, setJamendoId] = useState("");
  const [pexelsKey, setPexelsKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [showPixabay, setShowPixabay] = useState(false);
  const [showJamendo, setShowJamendo] = useState(false);
  const [showPexels, setShowPexels] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Sync form state once config loads
  if (configQuery.data && !initialized) {
    setDefaultModel(configQuery.data.defaultModel || "");
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, string | undefined>) =>
      fetchJson("/api/admin/director/config", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["director-config"] });
      showToast("Director settings saved", "success");
    },
    onError: (err) => showToast(`Save failed: ${(err as Error).message}`, "error"),
  });

  const handleSaveKeys = () => {
    const body: Record<string, string | undefined> = {};
    if (pixabayKey.trim()) body.pixabayApiKey = pixabayKey.trim();
    if (jamendoId.trim()) body.jamendoClientId = jamendoId.trim();
    if (pexelsKey.trim()) body.pexelsApiKey = pexelsKey.trim();
    if (Object.keys(body).length === 0) {
      showToast("Enter at least one key to save", "error");
      return;
    }
    saveMutation.mutate(body);
    setPixabayKey("");
    setJamendoId("");
    setPexelsKey("");
  };

  const handleSaveModel = () => {
    saveMutation.mutate({ defaultModel });
  };

  const config = configQuery.data;
  const models = modelsQuery.data?.models ?? [];

  if (configQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!config) {
    return <p className="text-sm text-muted-foreground">Director Mode is not configured.</p>;
  }

  return (
    <div className="space-y-5">
      {/* Status */}
      <div className="flex items-center gap-4 flex-wrap">
        <StatusBadge label="Enabled" ok={config.enabled} />
        <StatusBadge label="Pixabay" ok={config.pixabayConfigured} />
        <StatusBadge label="Jamendo" ok={config.jamendoConfigured} />
        <StatusBadge label="Pexels" ok={config.pexelsConfigured} />
      </div>

      <p className="text-xs text-muted-foreground">
        Template: <span className="text-foreground font-medium">{config.defaultTemplate}</span>
        {" · "}Output: <span className="text-foreground font-medium">{config.outputDir}</span>
      </p>

      {/* Model Selection */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Default LLM for Director Mode</label>
        <div className="flex items-center gap-2">
          <select
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-card text-sm text-foreground px-3 py-2"
          >
            <option value="">System Default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
          <button
            onClick={handleSaveModel}
            disabled={saveMutation.isPending}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
          >
            {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          Choose a high-capability model (GPT-4.1, Claude Sonnet 4, etc.) for best manifest generation.
          Can also be overridden per-production in the wizard.
        </p>
      </div>

      {/* API Keys */}
      <div className="space-y-3">
        <label className="text-xs font-medium text-muted-foreground">Media API Keys</label>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Pixabay</span>
            <div className="relative flex-1">
              <input
                type={showPixabay ? "text" : "password"}
                value={pixabayKey}
                onChange={(e) => setPixabayKey(e.target.value)}
                placeholder={config.pixabayConfigured ? `Configured ${config.pixabayApiKey}` : "Pixabay API Key"}
                className="w-full rounded-lg border border-border bg-card text-sm text-foreground px-3 py-2 pr-8"
              />
              <button
                onClick={() => setShowPixabay(!showPixabay)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPixabay ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Jamendo</span>
            <div className="relative flex-1">
              <input
                type={showJamendo ? "text" : "password"}
                value={jamendoId}
                onChange={(e) => setJamendoId(e.target.value)}
                placeholder={config.jamendoConfigured ? `Configured ${config.jamendoClientId}` : "Jamendo Client ID"}
                className="w-full rounded-lg border border-border bg-card text-sm text-foreground px-3 py-2 pr-8"
              />
              <button
                onClick={() => setShowJamendo(!showJamendo)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showJamendo ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Pexels</span>
            <div className="relative flex-1">
              <input
                type={showPexels ? "text" : "password"}
                value={pexelsKey}
                onChange={(e) => setPexelsKey(e.target.value)}
                placeholder={config.pexelsConfigured ? `Configured ${config.pexelsApiKey}` : "Pexels API Key"}
                className="w-full rounded-lg border border-border bg-card text-sm text-foreground px-3 py-2 pr-8"
              />
              <button
                onClick={() => setShowPexels(!showPexels)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPexels ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground/60">
              Get keys:{" "}
              <a href="https://pixabay.com/api/docs/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Pixabay</a>
              {" · "}
              <a href="https://developer.jamendo.com/v3.0" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Jamendo</a>
              {" · "}
              <a href="https://www.pexels.com/api/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Pexels</a>
            </p>
            <button
              onClick={handleSaveKeys}
              disabled={saveMutation.isPending || (!pixabayKey.trim() && !jamendoId.trim() && !pexelsKey.trim())}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
            >
              Save Keys
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function StatusBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
        ok
          ? "bg-emerald-500/10 text-emerald-500"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {ok && <Check className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}
