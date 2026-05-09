"use client";

/**
 * System Requirements card (Issue #1063 / Epic #1053).
 *
 * Renders detected platform info + recommended Gemma 4 variant. Used on
 * the admin page to show users what model they should be running.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/api";

interface PlatformResponse {
  platform: {
    os: "windows" | "macos" | "linux" | "unknown";
    arch: string;
    chip: string | null;
    gpuKind: "nvidia" | "apple-silicon" | "amd" | "cpu";
    recommendedBackend: "ollama-mlx" | "ollama-cuda" | "ollama-cpu";
  };
  recommended: {
    modelId: string;
    quantisation: string;
    rationale: string;
    minMemoryBytes: number;
  };
  memoryGb: number;
  unifiedMemoryGb: number | null;
  largestGpuVramGb: number | null;
}

export function SystemRequirementsCard() {
  const [data, setData] = useState<PlatformResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<PlatformResponse>("/api/system/platform")
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
        Failed to load system requirements: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Loading system info…
      </div>
    );
  }

  const minGb = Math.round(data.recommended.minMemoryBytes / 1024 / 1024 / 1024);
  const enoughMemory = data.memoryGb >= minGb;

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">System requirements</h3>
        <Link
          href="/setup/offline"
          className="text-xs text-primary hover:underline"
        >
          Run offline setup wizard →
        </Link>
      </div>
      <dl className="grid grid-cols-2 gap-y-2 text-xs text-muted-foreground">
        <dt>OS</dt>
        <dd className="text-foreground">{data.platform.os} ({data.platform.arch})</dd>
        <dt>Chip</dt>
        <dd className="text-foreground">{data.platform.chip ?? "—"}</dd>
        <dt>Memory</dt>
        <dd className="text-foreground">{data.memoryGb} GB</dd>
        <dt>GPU</dt>
        <dd className="text-foreground">
          {data.platform.gpuKind}
          {data.largestGpuVramGb ? ` (${data.largestGpuVramGb} GB VRAM)` : ""}
        </dd>
        <dt>Backend</dt>
        <dd className="text-foreground">{data.platform.recommendedBackend}</dd>
        <dt>Recommended</dt>
        <dd className="font-mono text-emerald-600 dark:text-emerald-400">{data.recommended.modelId}</dd>
        <dt>Quantisation</dt>
        <dd className="text-foreground">{data.recommended.quantisation}</dd>
        <dt>Min memory</dt>
        <dd
          className={
            enoughMemory ? "text-foreground" : "text-amber-600 dark:text-amber-400"
          }
        >
          {minGb} GB {!enoughMemory && "⚠ underprovisioned"}
        </dd>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{data.recommended.rationale}</p>
    </div>
  );
}
