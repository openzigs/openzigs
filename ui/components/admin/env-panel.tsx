"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { EnvEntry } from "@/lib/types";
import { showToast } from "@/components/toast";

type AllowedDirsResponse = {
  value: string;
};

export const EnvPanel = () => {
  const queryClient = useQueryClient();
  const [allowedDirsInput, setAllowedDirsInput] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const envQuery = useQuery({
    queryKey: ["env"],
    queryFn: () => fetchJson<{ env: EnvEntry[] }>("/api/admin/env"),
  });

  const allowedDirsQuery = useQuery({
    queryKey: ["allowed-dirs"],
    queryFn: () => fetchJson<AllowedDirsResponse>("/api/admin/allowed-dirs"),
    initialData: { value: "" },
  });

  const currentAllowedDirs = allowedDirsQuery.data?.value ?? "";

  useEffect(() => {
    if (!isDirty) {
      setAllowedDirsInput(currentAllowedDirs);
    }
  }, [currentAllowedDirs, isDirty]);

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
