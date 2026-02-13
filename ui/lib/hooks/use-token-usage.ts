"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "@/lib/socket-context";
import type { TokenUsage, TokenUsageEvent, CompactionEvent } from "@/lib/types";

export type UseTokenUsageReturn = {
  /** Cumulative token usage for the current session. */
  usage: TokenUsage | null;
  /** Whether context compaction is currently in progress. */
  compacting: boolean;
  /** Context window size for the selected model (if known). */
  contextWindow: number | null;
  /** Ratio of cumulative input tokens to context window (0-1). Null if unknown. */
  fillRatio: number | null;
  /** Reset tracked usage (e.g. on chat clear). */
  reset: () => void;
};

/**
 * Hook that subscribes to real-time token usage and compaction events
 * via Socket.IO. Returns cumulative usage, compaction state, and
 * context fill ratio relative to the selected model's context window.
 */
export const useTokenUsage = (contextWindow: number | null): UseTokenUsageReturn => {
  const { socket } = useSocket();
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [compacting, setCompacting] = useState(false);
  const contextWindowRef = useRef(contextWindow);
  contextWindowRef.current = contextWindow;

  useEffect(() => {
    if (!socket) return;

    const onUsage = (event: TokenUsageEvent) => {
      setUsage(event.cumulative);
    };

    const onCompaction = (event: CompactionEvent) => {
      if (event.status === "started") {
        setCompacting(true);
      } else {
        setCompacting(false);
        // After compaction, the context is smaller — server will send
        // updated usage numbers on next turn, but we don't have them yet.
      }
    };

    socket.on("context:usage", onUsage);
    socket.on("context:compaction", onCompaction);

    return () => {
      socket.off("context:usage", onUsage);
      socket.off("context:compaction", onCompaction);
    };
  }, [socket]);

  const fillRatio =
    usage && contextWindow && contextWindow > 0
      ? Math.min(usage.inputTokens / contextWindow, 1)
      : null;

  const reset = useCallback(() => {
    setUsage(null);
    setCompacting(false);
  }, []);

  return { usage, compacting, contextWindow, fillRatio, reset };
};
