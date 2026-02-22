"use client";

import { useState, useCallback } from "react";
import { ArrowLeft, Save, Film, Loader2, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { RenderHistory } from "./render-history";
import type { DirectorManifest } from "../types";

interface StudioToolbarProps {
  title: string;
  draftId: string;
  manifest: DirectorManifest | null;
  onSave: () => Promise<void>;
  dirty?: boolean;
  lastSaved?: string | null;
}

export function StudioToolbar({ title, draftId, manifest, onSave, dirty, lastSaved }: StudioToolbarProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rendering, setRendering] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave();
      setSaved(true);
      showToast("Draft saved", "success");
      setTimeout(() => setSaved(false), 2000);
    } catch {
      showToast("Failed to save draft", "error");
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const handleRender = useCallback(async () => {
    if (!manifest) return;
    setRendering(true);
    try {
      // Save first so the latest manifest is persisted
      await onSave();
      const res = await fetchJson<{ jobId: string }>("/api/admin/director/render", {
        method: "POST",
        body: JSON.stringify({ manifest, draftId, quality: "standard" }),
      });
      await fetchJson(`/api/admin/director/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({ status: "rendering" }),
      });
      showToast(`Render queued (${res.jobId})`, "success");
    } catch {
      showToast("Render failed to start", "error");
    } finally {
      setRendering(false);
    }
  }, [manifest, draftId, onSave]);

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-background px-4 py-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push("/director")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <div className="h-4 w-px bg-border" />
        <h2 className="text-sm font-medium text-foreground truncate max-w-[300px]">{title}</h2>
        {dirty && (
          <span className="ml-1 text-[10px] text-muted-foreground italic">unsaved</span>
        )}
        {lastSaved && !dirty && (
          <span className="ml-1 text-[10px] text-muted-foreground">saved</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Save className="h-3.5 w-3.5" />}
          {saved ? "Saved" : "Save"}
        </button>
        {draftId && <RenderHistory draftId={draftId} />}
        <button
          onClick={handleRender}
          disabled={rendering || !manifest}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
        >
          {rendering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />}
          Render
        </button>
      </div>
    </div>
  );
}
