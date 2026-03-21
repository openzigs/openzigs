"use client";

import { useCallback, useEffect, useReducer } from "react";
import { useSocket } from "@/lib/socket-context";
import type {
  SubagentStartedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSelectedEvent,
  SubagentDeselectedEvent,
  SubagentStatus,
} from "@/lib/types";

export type SubagentEntry = {
  agentName: string;
  status: SubagentStatus;
  error?: string;
  summary?: string;
  startedAt: number;
  completedAt?: number;
};

type State = {
  agents: Map<string, SubagentEntry>;
};

type Action =
  | { type: "started"; payload: SubagentStartedEvent }
  | { type: "completed"; payload: SubagentCompletedEvent }
  | { type: "failed"; payload: SubagentFailedEvent }
  | { type: "selected"; payload: SubagentSelectedEvent }
  | { type: "deselected"; payload: SubagentDeselectedEvent }
  | { type: "reset" };

function reducer(state: State, action: Action): State {
  const next = new Map(state.agents);

  switch (action.type) {
    case "started": {
      next.set(action.payload.agentName, {
        agentName: action.payload.agentName,
        status: "running",
        startedAt: Date.now(),
      });
      return { agents: next };
    }
    case "completed": {
      const entry = next.get(action.payload.agentName);
      if (entry) {
        next.set(action.payload.agentName, {
          ...entry,
          status: "completed",
          summary: action.payload.summary,
          completedAt: Date.now(),
        });
      }
      return { agents: next };
    }
    case "failed": {
      const entry = next.get(action.payload.agentName);
      if (entry) {
        next.set(action.payload.agentName, {
          ...entry,
          status: "failed",
          error: action.payload.error,
          completedAt: Date.now(),
        });
      }
      return { agents: next };
    }
    case "selected": {
      const entry = next.get(action.payload.agentName);
      if (entry) {
        next.set(action.payload.agentName, { ...entry, status: "tool-active" });
      }
      return { agents: next };
    }
    case "deselected": {
      const entry = next.get(action.payload.agentName);
      if (entry && entry.status === "tool-active") {
        next.set(action.payload.agentName, { ...entry, status: "running" });
      }
      return { agents: next };
    }
    case "reset":
      return { agents: new Map() };
    default:
      return state;
  }
}

/**
 * Subscribes to Socket.IO `subagent:*` events filtered by sessionId.
 * Returns a map of active subagent entries and a reset function.
 */
export function useSubagentEvents(sessionId: string | null) {
  const { socket } = useSocket();
  const [state, dispatch] = useReducer(reducer, { agents: new Map() });

  useEffect(() => {
    if (!socket || !sessionId) return;

    const onStarted = (e: SubagentStartedEvent) => {
      if (e.sessionId === sessionId) dispatch({ type: "started", payload: e });
    };
    const onCompleted = (e: SubagentCompletedEvent) => {
      if (e.sessionId === sessionId) dispatch({ type: "completed", payload: e });
    };
    const onFailed = (e: SubagentFailedEvent) => {
      if (e.sessionId === sessionId) dispatch({ type: "failed", payload: e });
    };
    const onSelected = (e: SubagentSelectedEvent) => {
      if (e.sessionId === sessionId) dispatch({ type: "selected", payload: e });
    };
    const onDeselected = (e: SubagentDeselectedEvent) => {
      if (e.sessionId === sessionId) dispatch({ type: "deselected", payload: e });
    };

    socket.on("subagent:started", onStarted);
    socket.on("subagent:completed", onCompleted);
    socket.on("subagent:failed", onFailed);
    socket.on("subagent:selected", onSelected);
    socket.on("subagent:deselected", onDeselected);

    return () => {
      socket.off("subagent:started", onStarted);
      socket.off("subagent:completed", onCompleted);
      socket.off("subagent:failed", onFailed);
      socket.off("subagent:selected", onSelected);
      socket.off("subagent:deselected", onDeselected);
    };
  }, [socket, sessionId]);

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { agents: state.agents, reset };
}
