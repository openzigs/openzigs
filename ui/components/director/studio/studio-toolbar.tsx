"use client";

import { useState, useCallback } from "react";
import { ArrowLeft, Save, Film, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import type { DirectorManifest } from "../types";

interface StudioToolbarProps {
  title: string;
  draftId: string;
  manifest: DirectorManifest | null;
  onSave: () => Promise<void>;
}

export function StudioToolbar({ title, draftId, manifest, onSave }: StudioToolbarProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const handleRender = useCallback(async () => {
    if (!manifest) return;
    setRendering(true);
    try {
      await fetchJson("/api/admin/director/render", {
        method: "POST",
        body: JSON.stringify({ manifest, quality: "standard" }),
      });
      await fetchJson(`/api/admin/director/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({ status: "rendering" }),
      });
    } finally {
      setRendering(false);
    }
  }, [manifest, draftId]);

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
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
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
