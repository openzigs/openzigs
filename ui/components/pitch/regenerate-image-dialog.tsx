"use client";

/**
 * Image regenerate dialog — shared by every editor that owns an image
 * (title background, image_caption, full_bleed, bullet_list, etc.).
 *
 * Posts to `/api/admin/pitch/decks/:deckId/slides/:slideId/image` (Phase 3
 * router). The backend body shape (`SlideImageBody` in `src/api/pitch.ts`)
 * is `.strict()` — any unknown field 400s. Keep field names aligned.
 *
 * Lazy-loads character LoRAs from `/api/characters` so the editor bundle
 * doesn't pay for the dropdown when the user never opens the dialog.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchJson } from "@/lib/api";

interface CharacterRow {
  id: string;
  name: string;
  triggerWord?: string | null;
  trigger_word?: string | null;
  status: string;
}

interface CharactersResponse {
  characters?: CharacterRow[];
}

export interface RegenerateImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deckId: string;
  slideId: string;
  initialPrompt: string;
  /** "background" for full-bleed/title, "inline" for image_caption etc. */
  mode: "background" | "inline";
  /**
   * Sub-issue #992 — when set, render a small thumbnail of the current
   * image with a "Replace?" caption above the prompt. Caller is
   * responsible for supplying a safe URL (root-relative path or http(s)).
   * `javascript:` / `data:` etc. are silently dropped client-side as
   * defense-in-depth on top of the server-side `safeUrl` check.
   */
  currentImageUrl?: string;
  onQueued?: (jobId: string, assetId: string) => void;
}

/**
 * Strict client-side URL allowlist for the thumbnail preview — mirrors
 * `safeUrl` in `src/pitch/pitch-sanitize.ts`. Allows root-relative paths
 * and `http(s)://`; everything else is rejected and the thumbnail is
 * suppressed.
 */
function safePreviewUrl(input: string | undefined): string | null {
  if (!input) return null;
  const v = input.trim();
  if (!v) return null;
  if (v.startsWith("/")) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}

export const RegenerateImageDialog = ({
  open,
  onOpenChange,
  deckId,
  slideId,
  initialPrompt,
  mode,
  currentImageUrl,
  onQueued,
}: RegenerateImageDialogProps) => {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [useLora, setUseLora] = useState(false);
  const [loraId, setLoraId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bug #6 — the dialog stays mounted while `open=false`, so `useState`'s
  // lazy initializer only runs once and the prompt would be stuck at the
  // value held when the editor first rendered. Re-sync from `initialPrompt`
  // every time the dialog re-opens so the user's most recent textarea edit
  // is what actually gets prefilled.
  useEffect(() => {
    if (open) {
      setPrompt(initialPrompt);
      setError(null);
    }
  }, [open, initialPrompt]);

  const charactersQuery = useQuery({
    queryKey: ["pitch", "characters"],
    queryFn: () => fetchJson<CharactersResponse>("/api/characters"),
    enabled: open,
  });

  const readyCharacters = (charactersQuery.data?.characters ?? []).filter(
    (c) => c.status === "ready",
  );
  const selected = readyCharacters.find((c) => c.id === loraId);
  const triggerWord =
    selected?.triggerWord ?? selected?.trigger_word ?? null;

  const handleGenerate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        mode,
      };
      if (useLora && triggerWord) {
        body.loraTriggerWord = triggerWord;
      }
      const res = await fetchJson<{ jobId: string; assetId: string }>(
        `/api/admin/pitch/decks/${deckId}/slides/${slideId}/image`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      onQueued?.(res.jobId, res.assetId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="pitch-regen-image-dialog"
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Regenerate image</DialogTitle>
          <DialogDescription>
            Provide a new prompt to regenerate this image. The current
            asset stays in place until the new render finishes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          {(() => {
            const previewUrl = safePreviewUrl(currentImageUrl);
            if (!previewUrl) return null;
            return (
              <div data-testid="pitch-regen-image-current">
                <span className="mb-1 block font-semibold">
                  Replace?
                </span>
                <img
                  src={previewUrl}
                  alt="Current image"
                  data-testid="pitch-regen-image-current-thumb"
                  className="max-h-32 w-auto rounded border border-border"
                />
              </div>
            );
          })()}
          <label className="block">
            <span className="mb-1 block font-semibold">Prompt</span>
            <textarea
              data-testid="pitch-regen-image-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={400}
              rows={4}
              className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs"
            />
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              {prompt.length} / 400
            </span>
          </label>

          {readyCharacters.length > 0 && (
            <div>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid="pitch-regen-image-lora-toggle"
                  checked={useLora}
                  onChange={(e) => setUseLora(e.target.checked)}
                />
                <span>Use Character LoRA</span>
              </label>
              {useLora && (
                <select
                  data-testid="pitch-regen-image-lora-select"
                  value={loraId}
                  onChange={(e) => setLoraId(e.target.value)}
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
                >
                  <option value="">— pick a character —</option>
                  {readyCharacters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.triggerWord || c.trigger_word
                        ? ` (${c.triggerWord ?? c.trigger_word})`
                        : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {error && (
            <div
              data-testid="pitch-regen-image-error"
              className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-500"
            >
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-border px-3 py-1 text-xs hover:bg-muted/40"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="pitch-regen-image-submit"
            disabled={
              submitting ||
              prompt.trim().length < 3 ||
              (useLora && !triggerWord)
            }
            onClick={handleGenerate}
            className="rounded border border-primary bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "Queueing…" : "Generate"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
