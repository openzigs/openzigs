"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { useSlideImageStatus } from "./use-slide-image-status";

export interface GenerateAllImagesButtonProps {
  deckId: string;
  /** Disable interaction (e.g., when the deck has unsaved generation in flight). */
  disabled?: boolean;
  onShowToast?: (msg: string, kind: "success" | "error") => void;
}

interface GenerateAllResponse {
  enqueued: number;
  skipped: number;
  total: number;
}

type ButtonState = "idle" | "in_progress" | "done";

/**
 * Toolbar button that enqueues image generation jobs for every image-bearing
 * slot in the active deck, then shows live "X / N" progress sourced from
 * `useSlideImageStatus` (Socket.IO `pitch:image:*` events).
 */
export const GenerateAllImagesButton = ({
  deckId,
  disabled,
  onShowToast,
}: GenerateAllImagesButtonProps) => {
  const [state, setState] = useState<ButtonState>("idle");
  const [expected, setExpected] = useState(0);
  const { counts, reset } = useSlideImageStatus(deckId);
  const completedToastFiredRef = useRef(false);

  const completed = counts.ready + counts.failed;

  // Auto-flip to done + toast when we've heard back about every enqueued slot.
  useEffect(() => {
    if (state !== "in_progress") return;
    if (expected > 0 && completed >= expected) {
      setState("done");
      if (!completedToastFiredRef.current) {
        completedToastFiredRef.current = true;
        const msg =
          counts.failed > 0
            ? `Image generation finished — ${counts.failed} failed`
            : "All images generated";
        onShowToast?.(msg, counts.failed > 0 ? "error" : "success");
      }
    }
  }, [state, expected, completed, counts.failed, onShowToast]);

  const handleClick = async () => {
    if (state === "in_progress") return;
    completedToastFiredRef.current = false;
    reset();
    setState("in_progress");
    setExpected(0);
    try {
      const res = await fetchJson<GenerateAllResponse>(
        `/api/admin/pitch/decks/${deckId}/images/generate-all`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setExpected(res.enqueued);
      if (res.enqueued === 0) {
        setState("done");
        onShowToast?.("Nothing to generate", "success");
      }
    } catch (err) {
      setState("idle");
      onShowToast?.(
        `Generate failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  const label =
    state === "in_progress"
      ? expected > 0
        ? `Generating ${completed} / ${expected}`
        : "Starting\u2026"
      : state === "done"
        ? "Images ready"
        : "Generate all images";

  const Icon = state === "in_progress" ? Loader2 : Sparkles;

  return (
    <button
      type="button"
      data-testid="pitch-editor-generate-all-images"
      data-state={state}
      disabled={disabled || state === "in_progress"}
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"
    >
      <Icon
        className={`h-3.5 w-3.5 ${state === "in_progress" ? "animate-spin" : ""}`}
      />
      {label}
    </button>
  );
};

export default GenerateAllImagesButton;
