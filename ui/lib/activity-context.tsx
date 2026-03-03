"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";

export interface Activity {
  id: string;
  type: string;
  label: string;
  startedAt: number;
}

interface ActivityContextValue {
  activities: Map<string, Activity>;
  /** Register a client-side activity. Returns a dispose function to remove it. */
  startActivity: (id: string, type: string, label: string) => () => void;
  /** Update the label of an existing activity. */
  updateActivity: (id: string, label: string) => void;
  /** Remove an activity by id. */
  stopActivity: (id: string) => void;
  /** Cancel a running process by activity id. */
  cancelActivity: (id: string) => Promise<boolean>;
}

const ActivityContext = createContext<ActivityContextValue>({
  activities: new Map(),
  startActivity: () => () => {},
  updateActivity: () => {},
  stopActivity: () => {},
  cancelActivity: () => Promise.resolve(false),
});

export const useActivity = () => useContext(ActivityContext);

export const ActivityProvider = ({ children }: { children: ReactNode }) => {
  const { socket } = useSocket();
  const [activities, setActivities] = useState<Map<string, Activity>>(new Map());
  const activitiesRef = useRef(activities);
  activitiesRef.current = activities;

  const addActivity = useCallback((id: string, type: string, label: string) => {
    setActivities((prev) => {
      const next = new Map(prev);
      next.set(id, { id, type, label, startedAt: Date.now() });
      return next;
    });
  }, []);

  const removeActivity = useCallback((id: string) => {
    setActivities((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const updateLabel = useCallback((id: string, label: string) => {
    setActivities((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(id, { ...existing, label });
      return next;
    });
  }, []);

  const startActivity = useCallback(
    (id: string, type: string, label: string) => {
      addActivity(id, type, label);
      return () => removeActivity(id);
    },
    [addActivity, removeActivity],
  );

  const cancelActivity = useCallback(async (id: string): Promise<boolean> => {
    const activity = activitiesRef.current.get(id);
    if (!activity) return false;
    try {
      const rawId = id.replace(/^[^:]+:/, "");
      switch (activity.type) {
        case "produce":
          await fetchJson(`/api/admin/director/produce/${rawId}/cancel`, { method: "POST" });
          break;
        case "task":
          await fetchJson(`/api/tasks/${rawId}/cancel`, { method: "POST" });
          break;
        case "render":
          await fetchJson(`/api/admin/director/jobs/${rawId}/abort`, { method: "POST" });
          break;
        case "queue":
          await fetchJson(`/api/queue/jobs/${rawId}`, { method: "DELETE" });
          break;
        case "training":
          await fetchJson(`/api/characters/${rawId}/cancel-training`, { method: "POST" });
          break;
        default:
          removeActivity(id);
          return true;
      }
      removeActivity(id);
      return true;
    } catch {
      return false;
    }
  }, [removeActivity]);

  // ── Socket.IO server-side events ──
  useEffect(() => {
    if (!socket) return;

    const onProduceProgress = (data: { id: string; mode: string; phase: string; detail?: string }) => {
      if (data.phase === "complete" || data.phase === "failed" || data.phase === "cancelled") {
        removeActivity(`produce:${data.id}`);
      } else {
        addActivity(`produce:${data.id}`, "produce", data.detail ?? `${data.mode} — ${data.phase}`);
      }
    };

    const onTaskStatus = (data: { event: string; task: { id: string; goal: string } }) => {
      if (data.event === "task:running") {
        addActivity(`task:${data.task.id}`, "task", data.task.goal.substring(0, 60));
      } else if (["task:completed", "task:failed", "task:cancelled"].includes(data.event)) {
        removeActivity(`task:${data.task.id}`);
      }
    };

    const onRenderProgress = (data: { jobId: string; progress?: number }) => {
      const pct = typeof data.progress === "number" ? ` (${Math.round(data.progress)}%)` : "";
      addActivity(`render:${data.jobId}`, "render", `Rendering video${pct}`);
    };
    const onRenderDone = (data: { jobId: string }) => removeActivity(`render:${data.jobId}`);

    const onQueueDispatched = (data: { jobId: string; type: string }) => {
      addActivity(`queue:${data.jobId}`, "queue", `Queue: ${data.type}`);
    };
    const onQueueDone = (data: { jobId: string }) => removeActivity(`queue:${data.jobId}`);

    const onTrainingStart = (data: { characterId: string; characterName: string }) => {
      addActivity(`training:${data.characterId}`, "training", `Training LoRA: ${data.characterName}`);
    };
    const onTrainingDone = (data: { characterId: string }) => removeActivity(`training:${data.characterId}`);

    socket.on("produce:progress", onProduceProgress);
    socket.on("task:status", onTaskStatus);
    socket.on("render:progress", onRenderProgress);
    socket.on("render:complete", onRenderDone);
    socket.on("render:failed", onRenderDone);
    socket.on("queue:job:dispatched", onQueueDispatched);
    socket.on("queue:job:complete", onQueueDone);
    socket.on("queue:job:failed", onQueueDone);
    socket.on("character:training:start", onTrainingStart);
    socket.on("character:training:complete", onTrainingDone);
    socket.on("character:training:failed", onTrainingDone);

    return () => {
      socket.off("produce:progress", onProduceProgress);
      socket.off("task:status", onTaskStatus);
      socket.off("render:progress", onRenderProgress);
      socket.off("render:complete", onRenderDone);
      socket.off("render:failed", onRenderDone);
      socket.off("queue:job:dispatched", onQueueDispatched);
      socket.off("queue:job:complete", onQueueDone);
      socket.off("queue:job:failed", onQueueDone);
      socket.off("character:training:start", onTrainingStart);
      socket.off("character:training:complete", onTrainingDone);
      socket.off("character:training:failed", onTrainingDone);
    };
  }, [socket, addActivity, removeActivity]);

  return (
    <ActivityContext.Provider value={{ activities, startActivity, updateActivity: updateLabel, stopActivity: removeActivity, cancelActivity }}>
      {children}
    </ActivityContext.Provider>
  );
};
