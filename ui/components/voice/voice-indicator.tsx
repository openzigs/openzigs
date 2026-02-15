/**
 * VoiceIndicator — Visual state dot showing wake word state
 * Issue #231: Display IDLE (gray), STANDBY (blue pulse), ACTIVE (green glow)
 */

"use client";

import { cn } from "@/lib/utils";
import type { WakeWordState } from "@/lib/hooks/use-wake-word";

interface VoiceIndicatorProps {
  state: WakeWordState;
  className?: string;
}

export function VoiceIndicator({ state, className }: VoiceIndicatorProps) {
  return (
    <span
      className={cn(
        "inline-block h-2.5 w-2.5 rounded-full transition-colors duration-300",
        state === "IDLE" && "bg-muted-foreground/30",
        state === "STANDBY" && "bg-blue-500 animate-pulse",
        state === "ACTIVE" && "bg-green-500 shadow-[0_0_8px_2px_rgba(34,197,94,0.5)]",
        className
      )}
      title={
        state === "IDLE"
          ? "Voice: Off"
          : state === "STANDBY"
            ? "Voice: Listening for wake word…"
            : "Voice: Capturing query…"
      }
    />
  );
}
