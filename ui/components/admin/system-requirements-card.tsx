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
      <div className="rounded-lg border border-red-700 bg-red-900/30 p-4 text-sm text-red-200">
        Failed to load system requirements: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">
        Loading system info…
      </div>
    );
  }

  const minGb = Math.round(data.recommended.minMemoryBytes / 1024 / 1024 / 1024);
  const enoughMemory = data.memoryGb >= minGb;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">System requirements</h3>
        <Link
          href="/setup/offline"
          className="text-xs text-blue-400 hover:underline"
        >
          Run offline setup wizard →
        </Link>
      </div>
      <dl className="grid grid-cols-2 gap-y-2 text-xs text-zinc-400">
        <dt>OS</dt>
        <dd className="text-zinc-200">{data.platform.os} ({data.platform.arch})</dd>
        <dt>Chip</dt>
        <dd className="text-zinc-200">{data.platform.chip ?? "—"}</dd>
        <dt>Memory</dt>
        <dd className="text-zinc-200">{data.memoryGb} GB</dd>
        <dt>GPU</dt>
        <dd className="text-zinc-200">
          {data.platform.gpuKind}
          {data.largestGpuVramGb ? ` (${data.largestGpuVramGb} GB VRAM)` : ""}
        </dd>
        <dt>Backend</dt>
        <dd className="text-zinc-200">{data.platform.recommendedBackend}</dd>
        <dt>Recommended</dt>
        <dd className="font-mono text-emerald-400">{data.recommended.modelId}</dd>
        <dt>Quantisation</dt>
        <dd className="text-zinc-200">{data.recommended.quantisation}</dd>
        <dt>Min memory</dt>
        <dd
          className={
            enoughMemory ? "text-zinc-200" : "text-amber-400"
          }
        >
          {minGb} GB {!enoughMemory && "⚠ underprovisioned"}
        </dd>
      </dl>
      <p className="mt-3 text-xs text-zinc-500">{data.recommended.rationale}</p>
    </div>
  );
}
