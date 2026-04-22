"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Loader2, Power, Zap } from "lucide-react";

/**
 * Admin panel for the local vLLM TP=2 sidecar (Epic #888 / Issue #922).
 *
 * Displays:
 *   - Current GPU claim (which workload owns GPUs 0+1)
 *   - Reachability + loaded model id
 *   - KV cache utilisation bar (green <70%, amber 70-90%, red >90%)
 *   - Running/queued requests
 *   - Start/Stop controls with model selector (allowlist) and confirm dialog
 *
 * Polls /status every 5 s while mounted.
 */

interface AllowedModel {
  id: string;
  label: string;
  approxWeightsGb: number;
  quantization: string;
  recommendedFor12GbDual: boolean;
  notes?: string;
}

interface VllmMetric {
  name: string;
  value: number;
  labels: Record<string, string>;
}

interface VllmStatus {
  claim: { workload: string; gpus: number[]; startedAt: number } | null;
  reachable: boolean;
  model: string | null;
  metrics: VllmMetric[];
  allowedModels: AllowedModel[];
  defaultModel: string;
}

const findMetric = (metrics: VllmMetric[], name: string): number | null => {
  const m = metrics.find((entry) => entry.name === name);
  return m ? m.value : null;
};

const KvCacheBar = ({ percent }: { percent: number }) => {
  const pct = Math.max(0, Math.min(100, percent));
  const color =
    pct > 90
      ? "bg-red-500"
      : pct > 70
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>KV cache</span>
        <span>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

export const VllmPanel = () => {
  const queryClient = useQueryClient();
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [confirmStop, setConfirmStop] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["vllm-status"],
    queryFn: () => fetchJson<VllmStatus>("/api/admin/gpu/vllm/status"),
    refetchInterval: 5_000,
  });

  const startMutation = useMutation({
    mutationFn: (model: string) =>
      fetchJson<{ ok: boolean; model: string; message: string }>(
        "/api/admin/gpu/vllm/start",
        {
          method: "POST",
          body: JSON.stringify({ model }),
        },
      ),
    onSuccess: (data) => {
      showToast(`vLLM start issued: ${data.message}`, "success");
      void queryClient.invalidateQueries({ queryKey: ["vllm-status"] });
    },
    onError: (err: Error) => {
      showToast(`vLLM start failed: ${err.message}`, "error");
    },
  });

  const stopMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: boolean }>("/api/admin/gpu/vllm/stop", {
        method: "POST",
      }),
    onSuccess: () => {
      showToast("vLLM stopped", "success");
      setConfirmStop(false);
      void queryClient.invalidateQueries({ queryKey: ["vllm-status"] });
    },
    onError: (err: Error) => {
      showToast(`vLLM stop failed: ${err.message}`, "error");
    },
  });

  const data = statusQuery.data;
  const cacheUsage = data ? findMetric(data.metrics, "vllm:gpu_cache_usage_perc") : null;
  const numRunning = data ? findMetric(data.metrics, "vllm:num_requests_running") : null;
  const numWaiting = data ? findMetric(data.metrics, "vllm:num_requests_waiting") : null;
  const isRunning = !!data?.claim;

  const modelToStart = selectedModel || data?.defaultModel || "";

  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      aria-labelledby="vllm-panel-heading"
    >
      <header className="flex items-center justify-between">
        <h2 id="vllm-panel-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Zap className="h-5 w-5" aria-hidden />
          Local vLLM (TP=2)
        </h2>
        {statusQuery.isFetching && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Refreshing" />
        )}
      </header>

      {statusQuery.isError && (
        <p className="text-sm text-red-500" role="alert">
          Failed to fetch vLLM status: {(statusQuery.error as Error).message}
        </p>
      )}

      {data && (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                {data.reachable ? (
                  <span className="text-emerald-500">Running</span>
                ) : isRunning ? (
                  <span className="text-amber-500">Starting (claim active, /v1/models not yet 200)</span>
                ) : (
                  <span className="text-muted-foreground">Stopped</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-mono text-xs">{data.model ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Running requests</dt>
              <dd>{numRunning ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Queued requests</dt>
              <dd>{numWaiting ?? "—"}</dd>
            </div>
          </dl>

          {cacheUsage !== null && <KvCacheBar percent={cacheUsage * 100} />}

          {!isRunning && (
            <div className="space-y-2 border-t border-border pt-3">
              <label htmlFor="vllm-model-select" className="block text-sm font-medium">
                Model
              </label>
              <select
                id="vllm-model-select"
                value={modelToStart}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              >
                {data.allowedModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.approxWeightsGb} GB, {m.quantization})
                    {m.recommendedFor12GbDual ? " ★" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={startMutation.isPending}
                onClick={() => startMutation.mutate(modelToStart)}
                className="inline-flex items-center gap-2 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {startMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                <Power className="h-4 w-4" aria-hidden />
                Start vLLM
              </button>
              <p className="text-xs text-muted-foreground">
                First cold start may take 3–5 min while vLLM downloads weights.
              </p>
            </div>
          )}

          {isRunning && (
            <div className="space-y-2 border-t border-border pt-3">
              {!confirmStop && (
                <button
                  type="button"
                  onClick={() => setConfirmStop(true)}
                  className="inline-flex items-center gap-2 rounded border border-red-500 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10"
                >
                  <Power className="h-4 w-4" aria-hidden />
                  Stop vLLM
                </button>
              )}
              {confirmStop && (
                <div
                  role="alertdialog"
                  aria-labelledby="vllm-stop-confirm"
                  className="space-y-2 rounded border border-red-500 bg-red-500/10 p-3"
                >
                  <p id="vllm-stop-confirm" className="text-sm font-medium">
                    Stop vLLM? In-flight chat completions will fail.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={stopMutation.isPending}
                      onClick={() => stopMutation.mutate()}
                      className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {stopMutation.isPending && (
                        <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                      )}
                      Confirm Stop
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmStop(false)}
                      className="rounded border border-border px-3 py-1 text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};
