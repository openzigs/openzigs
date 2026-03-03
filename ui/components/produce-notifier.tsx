"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSocket } from "@/lib/socket-context";
import { CheckCircle2, ExternalLink, X } from "lucide-react";

type CompletedProduction = {
  id: string;
  mode: string;
  title: string;
  draftId: string;
  detail: string;
  timestamp: number;
};

/**
 * Global produce-completion notifier.
 * Mounted in the root Providers so it works regardless of which page the user
 * is on. When a produce job completes with a saved draft, shows a
 * notification banner with a link to open the result in Studio.
 */
export const ProduceNotifier = () => {
  const { socket } = useSocket();
  const router = useRouter();
  const [notifications, setNotifications] = useState<CompletedProduction[]>([]);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onProduceProgress = (data: {
      id: string;
      mode: string;
      phase: string;
      detail?: string;
      draftId?: string;
      title?: string;
    }) => {
      if (data.phase !== "complete" || !data.draftId) return;

      const notification: CompletedProduction = {
        id: data.id,
        mode: data.mode,
        title: data.title ?? "Untitled",
        draftId: data.draftId,
        detail: data.detail ?? "Production complete",
        timestamp: Date.now(),
      };

      setNotifications((prev) => [...prev, notification]);

      // Auto-dismiss after 30 seconds
      setTimeout(() => dismiss(data.id), 30_000);
    };

    socket.on("produce:progress", onProduceProgress);
    return () => { socket.off("produce:progress", onProduceProgress); };
  }, [socket, dismiss]);

  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-6 z-[100] flex flex-col gap-2 max-w-sm">
      {notifications.map((n) => (
        <div
          key={n.id}
          className="flex items-start gap-3 rounded-xl border border-border bg-background/95 backdrop-blur px-4 py-3 shadow-xl animate-slide-in"
        >
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-moss" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {n.title}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {n.detail} — saved to Drafts
            </p>
            <button
              onClick={() => {
                router.push(`/director/studio/${n.draftId}`);
                dismiss(n.id);
              }}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Open in Studio
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
          <button
            onClick={() => dismiss(n.id)}
            className="flex-shrink-0 rounded p-0.5 hover:bg-accent/10 text-muted-foreground hover:text-foreground transition"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
