"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { KnowledgeConfig } from "@/lib/types";
import { Save, Folder, Eye } from "lucide-react";

type KnowledgeConfigUpdate = {
  directory?: string;
  watchEnabled?: boolean;
};

export const KnowledgeConfigPanel = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["knowledge-config"],
    queryFn: () => fetchJson<KnowledgeConfig>("/api/admin/knowledge/config"),
  });

  const [localDirectory, setLocalDirectory] = useState<string | null>(null);
  const [localWatchEnabled, setLocalWatchEnabled] = useState<boolean | null>(null);

  const effectiveDirectory = localDirectory ?? query.data?.directory ?? "";
  const effectiveWatchEnabled = localWatchEnabled ?? query.data?.watchEnabled ?? true;

  const directoryDirty = localDirectory !== null && localDirectory !== (query.data?.directory ?? "");
  const watchDirty = localWatchEnabled !== null && localWatchEnabled !== (query.data?.watchEnabled ?? true);
  const isDirty = directoryDirty || watchDirty;

  const mutation = useMutation({
    mutationFn: (payload: KnowledgeConfigUpdate) =>
      fetchJson<{ ok: boolean; config: KnowledgeConfig }>("/api/admin/knowledge/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setLocalDirectory(null);
      setLocalWatchEnabled(null);
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

      {isDirty && (
        <button
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          onClick={() => {
            const payload: KnowledgeConfigUpdate = {};
            if (directoryDirty) payload.directory = effectiveDirectory;
            if (watchDirty) payload.watchEnabled = effectiveWatchEnabled;
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
