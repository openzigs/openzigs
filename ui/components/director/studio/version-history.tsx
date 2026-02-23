"use client";

import { useState, useEffect, useCallback } from "react";
import { GitBranch, Loader2, RotateCcw, Plus, Check } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { DirectorManifest } from "../types";

interface VersionRecord {
  id: string;
  label: string;
  createdAt: string;
}

interface VersionHistoryProps {
  draftId: string;
  onRestore: (manifest: DirectorManifest) => void;
  onSaveVersion: () => Promise<void>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function VersionHistory({ draftId, onRestore, onSaveVersion }: VersionHistoryProps) {
  const [versions, setVersions] = useState<VersionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ versions: VersionRecord[] }>(
        `/api/admin/director/drafts/${draftId}/versions`,
      );
      setVersions(res.versions);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const handleSaveVersion = useCallback(async () => {
    setSaving(true);
    try {
      await onSaveVersion();
      await load();
      showToast("Version saved", "success");
    } catch {
      showToast("Failed to save version", "error");
    } finally {
      setSaving(false);
    }
  }, [onSaveVersion, load]);

  const handleRestore = useCallback(
    async (ver: VersionRecord) => {
      setRestoringId(ver.id);
      try {
        const res = await fetchJson<{ success: boolean; manifest: DirectorManifest }>(
          `/api/admin/director/drafts/${draftId}/versions/${ver.id}/restore`,
          { method: "POST" },
        );
        onRestore(res.manifest);
        setSavedId(ver.id);
        showToast(`Restored "${ver.label}"`, "success");
        setTimeout(() => setSavedId(null), 2000);
        setOpen(false);
      } catch {
        showToast("Failed to restore version", "error");
      } finally {
        setRestoringId(null);
      }
    },
    [draftId, onRestore],
  );

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition"
        title="Version history"
      >
        <GitBranch className="h-3.5 w-3.5" />
        Versions
        {versions.length > 0 && (
          <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-bold text-primary">
            {versions.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">Timeline Versions</span>
            <div className="flex items-center gap-1.5">
              {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              <button
                onClick={handleSaveVersion}
                disabled={saving}
                className="flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
                title="Save current state as a new version"
              >
                {saving ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Plus className="h-2.5 w-2.5" />
                )}
                Save version
              </button>
            </div>
          </div>

          {versions.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No saved versions yet. Click &ldquo;Save version&rdquo; to snapshot the current
              timeline.
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {versions.map((ver) => (
                <div
                  key={ver.id}
                  className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{ver.label}</p>
                    <p className="text-[10px] text-muted-foreground">{formatDate(ver.createdAt)}</p>
                  </div>
                  <button
                    onClick={() => handleRestore(ver)}
                    disabled={restoringId === ver.id}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-primary transition disabled:opacity-50"
                    title="Restore this version"
                  >
                    {restoringId === ver.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : savedId === ver.id ? (
                      <Check className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
