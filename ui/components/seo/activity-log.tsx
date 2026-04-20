"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSocket } from "@/lib/socket-context";
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  Wrench,
  MessageSquare,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface ActivityEntry {
  id: string;
  type: "tool" | "stream" | "info";
  content: string;
  timestamp: number;
}

interface ActivityLogProps {
  active: boolean;
  onComplete?: () => void;
}

export function ActivityLog({ active, onComplete }: ActivityLogProps) {
  const { socket } = useSocket();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const addEntry = useCallback(
    (type: ActivityEntry["type"], content: string) => {
      setEntries((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          type,
          content,
          timestamp: Date.now(),
        },
      ]);
    },
    [],
  );

  useEffect(() => {
    if (!socket) return;

    const onToolCall = (data: { tool?: string }) => {
      if (data.tool) {
        addEntry("tool", `Calling ${data.tool}…`);
      }
    };

    const onStream = (data: { chunk?: string }) => {
      if (data.chunk && data.chunk.length > 0) {
        // Batch stream: just show that output is flowing
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (last?.type === "stream") {
            // Append to last stream entry (keep it trimmed)
            const updated = last.content + data.chunk!;
            const trimmed =
              updated.length > 500
                ? "…" + updated.slice(updated.length - 450)
                : updated;
            return [...prev.slice(0, -1), { ...last, content: trimmed }];
          }
          const content =
            data.chunk!.length > 500
              ? "…" + data.chunk!.slice(data.chunk!.length - 450)
              : data.chunk!;
          return [
            ...prev,
            {
              id: `${Date.now()}-${Math.random()}`,
              type: "stream",
              content,
              timestamp: Date.now(),
            },
          ];
        });
      }
    };

    const onStreamEnd = () => {
      addEntry("info", "Operation complete");
      onComplete?.();
    };

    const onResponse = () => {
      addEntry("info", "Operation complete");
      onComplete?.();
    };

    const onError = (data: { error?: string }) => {
      addEntry("info", `Error: ${data.error ?? "Unknown error"}`);
      onComplete?.();
    };

    socket.on("chat:tool_call", onToolCall);
    socket.on("chat:stream", onStream);
    socket.on("chat:stream:end", onStreamEnd);
    socket.on("chat:response", onResponse);
    socket.on("chat:error", onError);

    return () => {
      socket.off("chat:tool_call", onToolCall);
      socket.off("chat:stream", onStream);
      socket.off("chat:stream:end", onStreamEnd);
      socket.off("chat:response", onResponse);
      socket.off("chat:error", onError);
    };
  }, [socket, addEntry, onComplete]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current && !collapsed) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, collapsed]);

  // When operation becomes inactive, collapse
  useEffect(() => {
    if (!active && entries.length > 0) {
      setCollapsed(true);
    }
  }, [active, entries.length]);

  if (entries.length === 0 && !active) return null;

  return (
    <div className="rounded-xl border bg-card mt-4">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
        <Terminal className="h-4 w-4" />
        Activity Log
        {active && (
          <Loader2 className="h-3.5 w-3.5 animate-spin ml-auto text-blue-500" />
        )}
        {!active && entries.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {entries.length} entries
          </span>
        )}
      </button>

      {!collapsed && (
        <div
          ref={scrollRef}
          className="max-h-60 overflow-y-auto border-t px-4 py-2 space-y-1 font-mono text-xs"
        >
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                "flex items-start gap-2 py-0.5",
                entry.type === "tool" && "text-blue-500",
                entry.type === "info" && "text-muted-foreground",
                entry.type === "stream" && "text-foreground",
              )}
            >
              {entry.type === "tool" && (
                <Wrench className="h-3 w-3 mt-0.5 shrink-0" />
              )}
              {entry.type === "stream" && (
                <MessageSquare className="h-3 w-3 mt-0.5 shrink-0" />
              )}
              {entry.type === "info" && (
                <Terminal className="h-3 w-3 mt-0.5 shrink-0" />
              )}
              <span className="whitespace-pre-wrap break-all leading-snug">
                {entry.content}
              </span>
            </div>
          ))}
          {active && entries.length === 0 && (
            <div className="flex items-center gap-2 py-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for activity…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
