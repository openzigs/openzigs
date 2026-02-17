/**
 * VoiceMicButton — Push-to-talk microphone for sidecar transcription
 * Issue #265: Hold (or click) to record audio, release to transcribe via local sidecar
 *
 * Two interaction modes:
 * - Click: Start/stop toggle
 * - Hold: Record while pressed, transcribe on release
 */

"use client";

import { useCallback, useRef } from "react";
import { Mic, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVoiceInput, type TranscriptionResult } from "@/lib/hooks/use-voice-input";
import { cn } from "@/lib/utils";

interface VoiceMicButtonProps {
  /** Called when transcription text is ready */
  onTranscript: (text: string) => void;
  /** Called with full transcription result (incl. segments) */
  onTranscriptResult?: (result: TranscriptionResult) => void;
  /** Whether the component is disabled */
  disabled?: boolean;
  className?: string;
}

/** Minimum hold time (ms) to count as "hold-to-record" vs. "click toggle" */
const HOLD_THRESHOLD = 300;

export function VoiceMicButton({
  onTranscript,
  onTranscriptResult,
  disabled = false,
  className,
}: VoiceMicButtonProps) {
  const pressStartRef = useRef<number>(0);
  const holdActiveRef = useRef(false);

  const {
    state,
    isRecording,
    isTranscribing,
    recordingDuration,
    startRecording,
    stopRecording,
    cancelRecording,
    error,
  } = useVoiceInput({
    onTranscript: (result) => {
      const trimmed = result.text.trim();
      if (trimmed) {
        onTranscript(trimmed);
        onTranscriptResult?.(result);
      }
    },
    onError: (err) => {
      console.warn("[voice-mic] Transcription error:", err);
    },
  });

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || isTranscribing) return;
      e.preventDefault();
      pressStartRef.current = Date.now();
      holdActiveRef.current = false;

      if (!isRecording) {
        // Start recording immediately, decide click vs. hold on release
        void startRecording();
      }
    },
    [disabled, isRecording, isTranscribing, startRecording],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      const elapsed = Date.now() - pressStartRef.current;

      if (elapsed >= HOLD_THRESHOLD) {
        // Hold-to-record mode: stop and transcribe
        void stopRecording();
      } else {
        // Click toggle mode
        if (isRecording) {
          void stopRecording();
        }
        // If not recording and just started, let it keep recording (click-toggle)
      }
    },
    [disabled, isRecording, stopRecording],
  );

  const handlePointerLeave = useCallback(() => {
    // If pointer leaves while recording in hold mode, stop
    if (isRecording && holdActiveRef.current) {
      void stopRecording();
    }
  }, [isRecording, stopRecording]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && isRecording) {
        cancelRecording();
      }
    },
    [isRecording, cancelRecording],
  );

  const formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "h-9 w-9 rounded-full transition-all duration-200",
          isRecording && "bg-red-500/10 text-red-500 ring-2 ring-red-500/30 animate-pulse",
          isTranscribing && "bg-blue-500/10 text-blue-500",
          state === "error" && "text-destructive",
        )}
        disabled={disabled || isTranscribing}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        title={
          isRecording
            ? `Recording… ${formatDuration(recordingDuration)} (click or release to stop, Esc to cancel)`
            : isTranscribing
              ? "Transcribing…"
              : "Click or hold to record voice (local sidecar STT)"
        }
      >
        {isTranscribing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </Button>

      {/* Recording duration badge */}
      {isRecording && (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
          {formatDuration(recordingDuration)}
        </span>
      )}

      {/* Error tooltip */}
      {error && state === "error" && (
        <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[10px] text-destructive-foreground">
          {error}
        </span>
      )}
    </div>
  );
}
