"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSocket } from "@/lib/socket-context";

export type SlideImageStatus = "idle" | "queued" | "ready" | "failed";

interface SlotKey {
  slideId: string;
  slot: string;
}

interface SlotState {
  status: SlideImageStatus;
  error?: string;
  jobId?: string;
}

interface QueuedPayload {
  deckId: string;
  slideId: string;
  slot: string;
  jobId?: string;
  assetId?: string;
}

interface ReadyPayload {
  deckId: string;
  slideId: string;
  slot: string;
}

interface FailedPayload {
  deckId: string;
  slideId: string;
  slot: string;
  error?: string;
}

const keyOf = ({ slideId, slot }: SlotKey) => `${slideId}::${slot}`;

/**
 * Subscribes to `pitch:image:queued|ready|failed` Socket.IO events scoped
 * to a single deck and exposes the per-slot status. Used by the slide rail
 * (badges) and the "Generate all images" button (live counts).
 */
export function useSlideImageStatus(deckId: string | null | undefined) {
  const { socket } = useSocket();
  const [byKey, setByKey] = useState<Record<string, SlotState>>({});

  useEffect(() => {
    if (!socket || !deckId) return;
    const onQueued = (p: QueuedPayload) => {
      if (p.deckId !== deckId) return;
      setByKey((m) => ({
        ...m,
        [keyOf(p)]: { status: "queued", jobId: p.jobId },
      }));
    };
    const onReady = (p: ReadyPayload) => {
      if (p.deckId !== deckId) return;
      setByKey((m) => ({ ...m, [keyOf(p)]: { status: "ready" } }));
    };
    const onFailed = (p: FailedPayload) => {
      if (p.deckId !== deckId) return;
      setByKey((m) => ({
        ...m,
        [keyOf(p)]: { status: "failed", error: p.error },
      }));
    };
    socket.on("pitch:image:queued", onQueued);
    socket.on("pitch:image:ready", onReady);
    socket.on("pitch:image:failed", onFailed);
    return () => {
      socket.off("pitch:image:queued", onQueued);
      socket.off("pitch:image:ready", onReady);
      socket.off("pitch:image:failed", onFailed);
    };
  }, [socket, deckId]);

  const statusOf = useCallback(
    (slideId: string, slot: string): SlideImageStatus =>
      byKey[keyOf({ slideId, slot })]?.status ?? "idle",
    [byKey],
  );

  const errorOf = useCallback(
    (slideId: string, slot: string): string | undefined =>
      byKey[keyOf({ slideId, slot })]?.error,
    [byKey],
  );

  const counts = useMemo(() => {
    let queued = 0;
    let ready = 0;
    let failed = 0;
    for (const v of Object.values(byKey)) {
      if (v.status === "queued") queued += 1;
      else if (v.status === "ready") ready += 1;
      else if (v.status === "failed") failed += 1;
    }
    return { queued, ready, failed, total: queued + ready + failed };
  }, [byKey]);

  const reset = useCallback(() => setByKey({}), []);

  /** Status of an entire slide (worst-of: failed > queued > ready > idle). */
  const slideStatus = useCallback(
    (slideId: string): SlideImageStatus => {
      let worst: SlideImageStatus = "idle";
      const rank: Record<SlideImageStatus, number> = {
        idle: 0,
        ready: 1,
        queued: 2,
        failed: 3,
      };
      for (const [k, v] of Object.entries(byKey)) {
        if (!k.startsWith(`${slideId}::`)) continue;
        if (rank[v.status] > rank[worst]) worst = v.status;
      }
      return worst;
    },
    [byKey],
  );

  return { statusOf, errorOf, slideStatus, counts, reset };
}
