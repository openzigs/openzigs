"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { KnowledgeConfig } from "@/lib/types";
import { Save, Folder, Eye, Mic, Search, SlidersHorizontal } from "lucide-react";

type KnowledgeConfigUpdate = {
  directory?: string;
  watchEnabled?: boolean;
  mediaModel?: string;
  minScore?: number;
  searchMode?: string;
};

export const KnowledgeConfigPanel = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["knowledge-config"],
    queryFn: () => fetchJson<KnowledgeConfig>("/api/admin/knowledge/config"),
  });

  const [localDirectory, setLocalDirectory] = useState<string | null>(null);
  const [localWatchEnabled, setLocalWatchEnabled] = useState<boolean | null>(null);
  const [localMediaModel, setLocalMediaModel] = useState<string | null>(null);
  const [localMinScore, setLocalMinScore] = useState<number | null>(null);
  const [localSearchMode, setLocalSearchMode] = useState<string | null>(null);

  const effectiveDirectory = localDirectory ?? query.data?.directory ?? "";
  const effectiveWatchEnabled = localWatchEnabled ?? query.data?.watchEnabled ?? true;
  const effectiveMediaModel = localMediaModel ?? query.data?.mediaModel ?? "base.en";
  const effectiveMinScore = localMinScore ?? query.data?.minScore ?? 0.25;
  const effectiveSearchMode = localSearchMode ?? query.data?.searchMode ?? "hybrid";

  const directoryDirty = localDirectory !== null && localDirectory !== (query.data?.directory ?? "");
  const watchDirty = localWatchEnabled !== null && localWatchEnabled !== (query.data?.watchEnabled ?? true);
  const mediaModelDirty = localMediaModel !== null && localMediaModel !== (query.data?.mediaModel ?? "base.en");
  const minScoreDirty = localMinScore !== null && localMinScore !== (query.data?.minScore ?? 0.25);
  const searchModeDirty = localSearchMode !== null && localSearchMode !== (query.data?.searchMode ?? "hybrid");
  const isDirty = directoryDirty || watchDirty || mediaModelDirty || minScoreDirty || searchModeDirty;

  const mutation = useMutation({
    mutationFn: (payload: KnowledgeConfigUpdate) =>
      fetchJson<{ ok: boolean; config: KnowledgeConfig }>("/api/admin/knowledge/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setLocalDirectory(null);
      setLocalWatchEnabled(null);
      setLocalMediaModel(null);
      setLocalMinScore(null);
      setLocalSearchMode(null);
      void queryClient.invalidateQueries({ queryKey: ["knowledge-config"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-stats"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-documents"] });
      showToast("Knowledge config updated.", "success");
    },
    onError: (err) => {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    },
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Configure the knowledge directory used by the RAG index. Changes apply immediately; no server restart required.
      </p>

      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Folder className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Knowledge Directory</h3>
        </div>

        <input
          type="text"
          value={effectiveDirectory}
          onChange={(e) => setLocalDirectory(e.target.value)}
          placeholder="/Users/you/.openzigs/knowledge"
          disabled={mutation.isPending}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <p className="text-xs text-muted-foreground">
          When changed, the service clears existing indexed documents and performs a full scan of the new directory.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Live File Watching</h3>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={effectiveWatchEnabled}
            onChange={(e) => setLocalWatchEnabled(e.target.checked)}
            disabled={mutation.isPending}
            className="h-4 w-4 rounded border-border"
          />
          Auto-index file additions/changes/deletions in real time
        </label>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Whisper Model</h3>
        </div>

        <select
          value={effectiveMediaModel}
          onChange={(e) => setLocalMediaModel(e.target.value)}
          disabled={mutation.isPending}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="tiny.en">tiny.en (fastest, lowest accuracy)</option>
          <option value="base.en">base.en (default)</option>
          <option value="small.en">small.en (better accuracy)</option>
          <option value="medium.en">medium.en (high accuracy)</option>
          <option value="large-v1">large-v1 (best quality, slowest ~3GB)</option>
          <option value="large">large (latest version, slowest ~3GB)</option>
        </select>
        <p className="text-xs text-muted-foreground">
          After changing the model, re-index media files to regenerate transcripts at the new quality level.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Search Mode</h3>
        </div>

        <select
          value={effectiveSearchMode}
          onChange={(e) => setLocalSearchMode(e.target.value)}
          disabled={mutation.isPending}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="hybrid">Hybrid (semantic + keyword — best results)</option>
          <option value="vector">Vector (semantic similarity only)</option>
          <option value="fts">Full-Text (keyword match only)</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Hybrid combines vector (semantic) and full-text (keyword) search with reciprocal rank fusion for the best of both worlds.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Minimum Score Threshold</h3>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={effectiveMinScore}
            onChange={(e) => setLocalMinScore(parseFloat(e.target.value))}
            disabled={mutation.isPending}
            className="flex-1"
          />
          <span className="w-12 text-sm font-mono text-foreground text-right">
            {Math.round(effectiveMinScore * 100)}%
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Results below this relevance threshold are filtered out. Set to 0% to return all results.
        </p>
      </div>

      {isDirty && (
        <button
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          onClick={() => {
            const payload: KnowledgeConfigUpdate = {};
            if (directoryDirty) payload.directory = effectiveDirectory;
            if (watchDirty) payload.watchEnabled = effectiveWatchEnabled;
            if (mediaModelDirty) payload.mediaModel = effectiveMediaModel;
            if (minScoreDirty) payload.minScore = effectiveMinScore;
            if (searchModeDirty) payload.searchMode = effectiveSearchMode;
            mutation.mutate(payload);
          }}
          disabled={mutation.isPending || effectiveDirectory.trim().length === 0}
        >
          <Save className="h-4 w-4" />
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
};
