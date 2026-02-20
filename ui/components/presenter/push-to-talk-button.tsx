"use client";

import { useCallback, useRef } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";

export type PushToTalkState = "idle" | "raised" | "transcribing";

interface PushToTalkButtonProps {
  state: PushToTalkState;
  onRaiseHand: () => void;
  onLowerHand: () => void;
  transcriptionPreview?: string | null;
}

export function PushToTalkButton({
  state,
  onRaiseHand,
  onLowerHand,
  transcriptionPreview,
}: PushToTalkButtonProps) {
  const longPressRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      if (state === "idle") {
        longPressRef.current = true;
        onRaiseHand();
      }
    },
    [state, onRaiseHand],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      if (longPressRef.current && state === "raised") {
        longPressRef.current = false;
        onLowerHand();
      }
    },
    [state, onLowerHand],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      if (longPressRef.current && state === "raised") {
        longPressRef.current = false;
        onLowerHand();
      }
    },
    [state, onLowerHand],
  );

  // Also support click toggle for accessibility
  const handleClick = useCallback(() => {
    if (state === "idle") {
      onRaiseHand();
    } else if (state === "raised") {
      onLowerHand();
    }
  }, [state, onRaiseHand, onLowerHand]);

  const label =
    state === "idle"
      ? "Raise Hand"
      : state === "raised"
        ? "Speaking… (release to stop)"
        : "Transcribing…";

  return (
    <div
      className="absolute right-4 z-10 flex flex-col items-end gap-2"
      style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {/* Transcription preview bubble */}
      {state === "transcribing" && transcriptionPreview && (
        <div className="max-w-[200px] rounded-lg bg-black/70 px-3 py-2 text-xs text-white backdrop-blur">
          &ldquo;{transcriptionPreview}&rdquo;
        </div>
      )}

      {/* Label */}
      <span className="rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white/80 backdrop-blur">
        {label}
      </span>

      {/* Button */}
      <button
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={handleClick}
        title={label}
        aria-label={label}
        className={`flex h-14 w-14 touch-none items-center justify-center rounded-full shadow-lg transition-all select-none ${
          state === "idle"
            ? "bg-zinc-700 text-white hover:scale-110 hover:bg-zinc-600"
            : state === "raised"
              ? "animate-pulse bg-red-600 text-white ring-4 ring-red-400/50"
              : "bg-amber-600 text-white"
        }`}
      >
        {state === "idle" && <Mic className="h-6 w-6" />}
        {state === "raised" && <MicOff className="h-6 w-6" />}
        {state === "transcribing" && <Loader2 className="h-6 w-6 animate-spin" />}
      </button>
    </div>
  );
}
