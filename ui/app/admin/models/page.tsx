"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";

/**
 * WS2-C (#929) — LTX worker capabilities admin page.
 *
 * Surfaces the runtime capability report from the LTX video worker sidecar
 * (CUDA device count, pooled VRAM, dual-GPU pooling state, per-model max
 * frames, and supported audio modes) so users can see what their hardware
 * is actually capable of without reading sidecar logs.
 *
 * Backed by GET /api/admin/capabilities, which is a thin proxy onto the
 * worker's /capabilities endpoint at port 5007.
 */

type PerDevice = {
  index: number;
  name?: string;
  total_gb?: number;
  free_gb?: number;
  error?: string;
};

type PoolingInfo = {
  mode?: string;
  active?: boolean;
  transformer_device?: string | null;
  encoder_device?: string | null;
  vae_device?: string | null;
  min_vram_gb?: number;
};

type CapabilitiesResponse = {
  cuda_available?: boolean;
  device_count?: number;
  pooled_vram_gb?: number;
  per_device?: PerDevice[];
  pooling?: PoolingInfo;
  max_frames?: Record<string, number>;
  audio_modes?: string[];
  env?: Record<string, unknown>;
  error?: string;
};

const DEFAULT_FPS = 24;

const SYNC_AUDIO_MODELS = new Set([
  "ltxv-2-22b-distilled",
  "ltxv-2-22b",
]);

export default function AdminModelsPage() {
  const capsQuery = useQuery({
    queryKey: ["admin", "capabilities"],
    queryFn: () => fetchJson<CapabilitiesResponse>("/api/admin/capabilities"),
    staleTime: 30_000,
    retry: 0,
  });

  useEffect(() => {
    if (capsQuery.isError) {
      const message =
        capsQuery.error instanceof Error
          ? capsQuery.error.message
          : "Failed to load capabilities";
      showToast(message, "error");
    }
  }, [capsQuery.isError, capsQuery.error]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 lg:px-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">
          OpenZigs
        </p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">Models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live capability report from the LTX video worker. GPU pool, max
          frames per model, and supported audio modes.
        </p>
      </header>

      {capsQuery.isLoading ? (
        <CapabilitiesSkeleton />
      ) : capsQuery.isError ? (
        <ErrorBanner
          message={
            capsQuery.error instanceof Error
              ? capsQuery.error.message
              : "Failed to load capabilities"
          }
        />
      ) : (
        <CapabilitiesView data={capsQuery.data ?? {}} />
      )}

      <ToastContainer />
    </main>
  );
}

function CapabilitiesView({ data }: { data: CapabilitiesResponse }) {
  const deviceCount = data.device_count ?? 0;
  const pooledVram = data.pooled_vram_gb ?? 0;
  const poolingActive = Boolean(data.pooling?.active);
  const perDevice = data.per_device ?? [];
  const maxFrames = data.max_frames ?? {};

  return (
    <div className="space-y-6">
      <SectionCard title="GPU Pool">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="primary" data-testid="gpu-count-badge">
            {deviceCount} GPU{deviceCount === 1 ? "" : "s"}
          </Badge>
          <Badge tone="muted" data-testid="pooled-vram-badge">
            {pooledVram} GB pooled VRAM
          </Badge>
          <Badge
            tone={poolingActive ? "success" : "muted"}
            data-testid="pooling-badge"
          >
            Pooling {poolingActive ? "Active" : "Inactive"}
          </Badge>
          {data.cuda_available === false && (
            <Badge tone="warn">CUDA unavailable</Badge>
          )}
        </div>

        {perDevice.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border border-border">
            <table
              className="w-full text-sm"
              data-testid="gpu-table"
            >
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Index</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-right">Total VRAM (GB)</th>
                  <th className="px-3 py-2 text-right">Free VRAM (GB)</th>
                </tr>
              </thead>
              <tbody>
                {perDevice.map((d) => (
                  <tr
                    key={d.index}
                    className="border-t border-border odd:bg-background even:bg-muted/10"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{d.index}</td>
                    <td className="px-3 py-2">
                      {d.name ?? (
                        <span className="text-muted-foreground">
                          {d.error ?? "unknown"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {d.total_gb ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {d.free_gb ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {poolingActive && data.pooling && (
          <p className="mt-3 text-xs text-muted-foreground">
            Pooling mode <code className="font-mono">{data.pooling.mode}</code>:
            transformer →{" "}
            <code className="font-mono">{data.pooling.transformer_device}</code>,
            encoder →{" "}
            <code className="font-mono">{data.pooling.encoder_device}</code>,
            VAE → <code className="font-mono">{data.pooling.vae_device}</code>.
          </p>
        )}
      </SectionCard>

      <SectionCard title="LTX Models">
        {Object.keys(maxFrames).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No models reported by the worker.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table
              className="w-full text-sm"
              data-testid="ltx-models-table"
            >
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Model</th>
                  <th className="px-3 py-2 text-right">Max safe frames</th>
                  <th className="px-3 py-2 text-right">
                    Max seconds @ {DEFAULT_FPS}fps
                  </th>
                  <th className="px-3 py-2 text-left">Sync audio</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(maxFrames).map(([key, frames]) => {
                  const seconds = frames / DEFAULT_FPS;
                  const syncCapable = SYNC_AUDIO_MODELS.has(key);
                  return (
                    <tr
                      key={key}
                      className="border-t border-border odd:bg-background even:bg-muted/10"
                    >
                      <td className="px-3 py-2 font-mono text-xs">{key}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {frames}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {seconds.toFixed(1)}s
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={syncCapable ? "success" : "muted"}>
                          {syncCapable ? "Yes" : "No"}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {Array.isArray(data.audio_modes) && data.audio_modes.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Audio modes available:{" "}
            {data.audio_modes.map((mode) => (
              <code
                key={mode}
                className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
              >
                {mode}
              </code>
            ))}
          </p>
        )}
      </SectionCard>
    </div>
  );
}

function CapabilitiesSkeleton() {
  return (
    <div className="space-y-6" data-testid="capabilities-skeleton">
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        <div className="mt-4 flex gap-3">
          <div className="h-6 w-20 animate-pulse rounded bg-muted" />
          <div className="h-6 w-32 animate-pulse rounded bg-muted" />
          <div className="h-6 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="mt-4 h-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-40 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="rounded-2xl border border-destructive/40 bg-destructive/10 p-6 text-sm text-destructive"
      role="alert"
    >
      <p className="font-semibold">Failed to load capabilities</p>
      <p className="mt-1 text-xs">{message}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Check that the LTX worker sidecar is running and reachable. The admin
        proxy lives at <code className="font-mono">/api/admin/capabilities</code>.
      </p>
    </div>
  );
}

function Badge({
  children,
  tone,
  ...rest
}: {
  children: React.ReactNode;
  tone: "primary" | "success" | "warn" | "muted";
} & React.HTMLAttributes<HTMLSpanElement>) {
  const toneClasses: Record<string, string> = {
    primary:
      "border-primary/30 bg-primary/10 text-primary",
    success:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    warn:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    muted:
      "border-border bg-muted/30 text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${toneClasses[tone]}`}
      {...rest}
    >
      {children}
    </span>
  );
}
