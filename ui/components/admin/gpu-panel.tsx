"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { RefreshCw, Cpu, Loader2 } from "lucide-react";

type GpuInfo = {
  index: number;
  name: string;
  total_mb: number;
  free_mb: number;
};

type GpuProfile = {
  detected: boolean;
  gpus: GpuInfo[];
  total_vram_gb: number;
  largest_gpu_gb: number;
  recommended_tier: string;
  recommended_tier_pooled?: string;
  pooling_supported: boolean;
  same_arch: boolean;
  pinning: Record<string, number>;
  detected_at: string;
};

type OllamaModel = {
  name: string;
  size: number;
};

type OllamaRunningModel = {
  name: string;
  size: number;
  size_vram: number;
};

type OllamaStatus = {
  available: boolean;
  models: OllamaModel[];
  running: OllamaRunningModel[];
  error?: string;
};

const tierColors: Record<string, string> = {
  low: "bg-red-500/15 text-red-600 dark:text-red-400",
  medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  high: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  ultra: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
};

const TierBadge = ({ tier }: { tier: string }) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tierColors[tier] ?? "bg-muted text-muted-foreground"}`}
  >
    {tier}
  </span>
);

const BoolBadge = ({ value, label }: { value: boolean; label: string }) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
      value
        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        : "bg-muted text-muted-foreground"
    }`}
  >
    {label}: {value ? "Yes" : "No"}
  </span>
);

const VramBar = ({ used_mb, total_mb }: { used_mb: number; total_mb: number }) => {
  const pct = total_mb > 0 ? Math.round(((total_mb - used_mb) / total_mb) * 100) : 0;
  const usedPct = 100 - pct;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>
          {((total_mb - used_mb) / 1024).toFixed(1)} GB used
        </span>
        <span>{(total_mb / 1024).toFixed(1)} GB total</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${usedPct > 90 ? "bg-red-500" : usedPct > 70 ? "bg-amber-500" : "bg-emerald-500"}`}
          style={{ width: `${usedPct}%` }}
        />
      </div>
    </div>
  );
};

export const GpuPanel = () => {
  const queryClient = useQueryClient();

  const gpuQuery = useQuery({
    queryKey: ["gpu-profile"],
    queryFn: () => fetchJson<GpuProfile>("/api/system/gpu"),
  });

  const ollamaQuery = useQuery({
    queryKey: ["ollama-status"],
    queryFn: async () => {
      try {
        const [tagsRes, psRes] = await Promise.allSettled([
          fetchJson<{ models: OllamaModel[] }>("/api/admin/gpu/ollama/tags"),
          fetchJson<{ models: OllamaRunningModel[] }>("/api/admin/gpu/ollama/ps"),
        ]);
        return {
          available: true,
          models: tagsRes.status === "fulfilled" ? tagsRes.value.models ?? [] : [],
          running: psRes.status === "fulfilled" ? psRes.value.models ?? [] : [],
        } as OllamaStatus;
      } catch {
        return { available: false, models: [], running: [] } as OllamaStatus;
      }
    },
    retry: false,
  });

  const profile = gpuQuery.data;
  const ollama = ollamaQuery.data;

  const [poolingMode, setPoolingMode] = useState<string>("");
  const [poolingInitialized, setPoolingInitialized] = useState(false);

  // Sync pooling mode from profile data
  if (profile && !poolingInitialized) {
    // Infer current pooling from profile — if pooling is supported and pooled tier is set, it may be active
    setPoolingMode("off");
    setPoolingInitialized(true);
  }

  const poolingMutation = useMutation({
    mutationFn: (mode: string) =>
      fetchJson<GpuProfile>("/api/admin/gpu/pooling", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gpu-profile"] });
      showToast("Pooling mode updated", "success");
    },
    onError: (err) =>
      showToast(`Failed to update pooling: ${(err as Error).message}`, "error"),
  });

  const pinningMutation = useMutation({
    mutationFn: (pinning: Record<string, number>) =>
      fetchJson<GpuProfile>("/api/admin/gpu/pinning", {
        method: "POST",
        body: JSON.stringify({ pinning }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gpu-profile"] });
      showToast("Pinning updated", "success");
    },
    onError: (err) =>
      showToast(`Failed to update pinning: ${(err as Error).message}`, "error"),
  });

  const handlePoolingChange = (mode: string) => {
    setPoolingMode(mode);
    poolingMutation.mutate(mode);
  };

  const handlePinningChange = (sidecar: string, gpuIndex: number) => {
    if (!profile) return;
    const newPinning = { ...profile.pinning, [sidecar]: gpuIndex };
    pinningMutation.mutate(newPinning);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["gpu-profile"] });
    queryClient.invalidateQueries({ queryKey: ["ollama-status"] });
  };

  if (gpuQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading GPU info…</p>;
  }

  if (!profile) {
    return <p className="text-sm text-muted-foreground">No GPU profile available.</p>;
  }

  const gpuCount = profile.gpus.length;

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm ${
              profile.detected
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/30 bg-amber-500/5 text-amber-600"
            }`}
          >
            <Cpu className="h-4 w-4" />
            {profile.detected
              ? `${gpuCount} GPU${gpuCount !== 1 ? "s" : ""} detected`
              : "No GPU detected"}
          </div>
          <span className="text-xs text-muted-foreground">
            {profile.total_vram_gb} GB total VRAM
          </span>
        </div>
        <button
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
          onClick={handleRefresh}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Tier summary */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Tier:</span>
          <TierBadge tier={profile.recommended_tier} />
        </div>
        {profile.recommended_tier_pooled && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Pooled tier:</span>
            <TierBadge tier={profile.recommended_tier_pooled} />
          </div>
        )}
        <BoolBadge value={profile.pooling_supported} label="Pooling" />
        <BoolBadge value={profile.same_arch} label="Same arch" />
      </div>

      {/* GPU cards */}
      {profile.gpus.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {profile.gpus.map((gpu) => (
            <div
              key={gpu.index}
              className="rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-card-foreground">
                  GPU {gpu.index}
                </h3>
                <span className="text-xs text-muted-foreground">{gpu.name}</span>
              </div>
              <VramBar used_mb={gpu.free_mb} total_mb={gpu.total_mb} />
            </div>
          ))}
        </div>
      )}

      {/* Pooling mode control */}
      {profile.pooling_supported && (
        <div className="rounded-xl border border-border p-4">
          <h3 className="mb-2 text-sm font-semibold text-card-foreground">
            VRAM Pooling Mode
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Enable manual FLUX component placement across GPUs. Requires ≥2
            same-architecture GPUs with ≥16 GB each for FLUX-dev.
          </p>
          <select
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            value={poolingMode}
            onChange={(e) => handlePoolingChange(e.target.value)}
            disabled={poolingMutation.isPending}
          >
            <option value="off">Off (single-GPU with CPU offload)</option>
            <option value="manual-flux">Manual FLUX (split across GPUs)</option>
          </select>
          {poolingMutation.isPending && (
            <Loader2 className="ml-2 inline h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
      )}

      {/* Sidecar pinning */}
      {gpuCount > 1 && (
        <div className="rounded-xl border border-border p-4">
          <h3 className="mb-2 text-sm font-semibold text-card-foreground">
            Sidecar GPU Pinning
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Assign each sidecar to a specific GPU. Changes require sidecar
            restart to take effect.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4">Sidecar</th>
                  <th className="pb-2">GPU</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(profile.pinning).map(([sidecar, gpuIdx]) => (
                  <tr key={sidecar} className="border-b border-border/50">
                    <td className="py-2 pr-4 font-medium">{sidecar}</td>
                    <td className="py-2">
                      <select
                        className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                        value={gpuIdx}
                        onChange={(e) =>
                          handlePinningChange(sidecar, parseInt(e.target.value, 10))
                        }
                        disabled={pinningMutation.isPending}
                      >
                        {profile.gpus.map((g) => (
                          <option key={g.index} value={g.index}>
                            GPU {g.index} — {g.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pinningMutation.isPending && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </div>
          )}
        </div>
      )}

      {/* Ollama status */}
      {ollama && ollama.available && (
        <div className="rounded-xl border border-border p-4">
          <h3 className="mb-2 text-sm font-semibold text-card-foreground">
            Ollama
          </h3>
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              Running
            </span>
          </div>
          {ollama.running.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Active models:
              </p>
              {ollama.running.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-1.5 text-sm"
                >
                  <span className="font-medium">{m.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {(m.size_vram / 1024 / 1024 / 1024).toFixed(1)} GB VRAM
                  </span>
                </div>
              ))}
            </div>
          )}
          {ollama.models.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Available models ({ollama.models.length}):
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ollama.models.map((m) => (
                  <span
                    key={m.name}
                    className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {m.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Detection timestamp */}
      <p className="text-xs text-muted-foreground">
        Last detected:{" "}
        {new Date(profile.detected_at).toLocaleString()}
      </p>
    </div>
  );
};
