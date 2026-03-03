"use client";

import { useEffect, useRef, useState } from "react";
import { useActivity } from "@/lib/activity-context";
import { Activity, Loader2, X } from "lucide-react";

/**
 * Global activity indicator — always visible in the nav bar.
 * Idle: subtle dot. Active: animated spinner + clickable panel.
 */
export const ActivityIndicator = () => {
  const { activities, cancelActivity } = useActivity();
  const [panelOpen, setPanelOpen] = useState(false);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);

  // Close panel on outside click
  useEffect(() => {
    if (!panelOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [panelOpen]);

  // Tick every second to refresh elapsed times
  const [, setTick] = useState(0);
  useEffect(() => {
    if (activities.size === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [activities.size]);

  const count = activities.size;
  const isActive = count > 0;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => isActive && setPanelOpen((v) => !v)}
        className={`relative flex items-center justify-center rounded-lg p-1.5 transition ${
          isActive
            ? "text-primary hover:bg-accent/10 cursor-pointer"
            : "text-muted-foreground/40 cursor-default"
        }`}
        title={isActive ? `${count} active process${count > 1 ? "es" : ""} — click to view` : "No active processes"}
      >
        {isActive ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Activity className="h-4 w-4" />
        )}
        {count > 1 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {panelOpen && isActive && (
        <div className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-border bg-background/95 backdrop-blur shadow-xl z-50">
          <div className="px-3 py-2 border-b border-border text-xs font-semibold text-muted-foreground">
            Active Processes
          </div>
          <ul className="max-h-60 overflow-y-auto py-1">
            {[...activities.values()].map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-xs group">
                <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
                <span className="flex-1 truncate">{a.label}</span>
                <span className="text-muted-foreground flex-shrink-0">
                  {formatElapsed(Date.now() - a.startedAt)}
                </span>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    setCancelling((prev) => new Set(prev).add(a.id));
                    await cancelActivity(a.id);
                    setCancelling((prev) => {
                      const next = new Set(prev);
                      next.delete(a.id);
                      return next;
                    });
                  }}
                  disabled={cancelling.has(a.id)}
                  className="flex-shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition disabled:opacity-50"
                  title="Cancel"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}
