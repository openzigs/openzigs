"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
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

type ButtonState = "idle" | "in_progress" | "done" | "error";

/**
 * Toolbar button that enqueues image generation jobs for every image-bearing
 * slot in the active deck, then shows live "X / N" progress sourced from
 * `useSlideImageStatus` (Socket.IO `pitch:image:*` events).
 *
 * Bug-fix (post-PR-#1017 walkthrough): when one or more enqueued jobs end
 * up in the `failed` bucket (retries exhausted, OOM, etc) the button now
 * transitions to an `error` state with a "Retry failed (N)" label and an
 * inline aria-live message instead of misleadingly showing "Images ready".
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

  // Auto-flip when we've heard back about every enqueued slot. If any
  // slot landed in `failed`, transition to `error` so the user sees the
  // failure and can retry; otherwise transition to `done` as before.
  useEffect(() => {
    if (state !== "in_progress") return;
    if (expected > 0 && completed >= expected) {
      const hasFailures = counts.failed > 0;
      setState(hasFailures ? "error" : "done");
      if (!completedToastFiredRef.current) {
        completedToastFiredRef.current = true;
        const msg = hasFailures
          ? `Image generation finished — ${counts.failed} failed`
          : "All images generated";
        onShowToast?.(msg, hasFailures ? "error" : "success");
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
      : state === "error"
        ? `Retry failed (${counts.failed})`
        : state === "done"
          ? "Images ready"
          : "Generate all images";

  const Icon =
    state === "in_progress"
      ? Loader2
      : state === "error"
        ? AlertTriangle
        : Sparkles;

  // Accent the button when in error state so failures aren't lost in the
  // toolbar. Re-enabled (not disabled) so a click fires another fan-out.
  const stateClass =
    state === "error"
      ? "border-red-500 text-red-600 hover:bg-red-500/10 dark:text-red-400"
      : "border-border hover:bg-muted/40";

  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        data-testid="pitch-editor-generate-all-images"
        data-state={state}
        disabled={disabled || state === "in_progress"}
        onClick={handleClick}
        className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs disabled:opacity-50 ${stateClass}`}
      >
        <Icon
          className={`h-3.5 w-3.5 ${state === "in_progress" ? "animate-spin" : ""}`}
        />
        {label}
      </button>
      {state === "error" ? (
        <span
          data-testid="pitch-editor-generate-all-images-error"
          role="status"
          aria-live="polite"
          className="text-[10px] text-red-600 dark:text-red-400"
        >
          {counts.failed} of {expected} image
          {expected === 1 ? "" : "s"} failed — click to retry
        </span>
      ) : null}
    </div>
  );
};

export default GenerateAllImagesButton;
