"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useSocket } from "@/lib/socket-context";
import type {
  TaskToolCallEvent,
  TaskToolResultEvent,
  TaskChunkEvent,
  TaskProgressEvent,
  SubagentStartedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSelectedEvent,
  SubagentDeselectedEvent,
} from "@/lib/types";
import { ChevronDown, ChevronUp, X, Bot, Wrench, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";

/* ── Types ── */

export type AgentMode = "background" | "in-session";
export type FilterMode = "all" | "background" | "in-session";

type AgentEvent =
  | { type: "tool-call"; toolName: string; ts: number }
  | { type: "tool-result"; toolName: string; durationMs: number; ts: number }
  | { type: "chunk"; text: string; ts: number }
  | { type: "progress"; stage: string; message: string; ts: number }
  | { type: "status"; status: string; ts: number };

type AgentState = {
  taskId: string;
  goal: string;
  agentName: string;
  mode: AgentMode;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt: number | null;
  tokenUsage: { totalTokens: number } | null;
  events: AgentEvent[];
};

type PanelState = {
  agents: Map<string, AgentState>;
  collapsed: boolean;
  dismissed: boolean;
};

type PanelAction =
  | { type: "ADD_AGENT"; taskId: string; goal: string; agentName: string; mode?: AgentMode }
  | { type: "TOOL_CALL"; taskId: string; toolName: string }
  | { type: "TOOL_RESULT"; taskId: string; toolName: string; durationMs: number }
  | { type: "CHUNK"; taskId: string; text: string }
  | { type: "PROGRESS"; taskId: string; stage: string; message: string }
  | { type: "STATUS"; taskId: string; status: string; tokenUsage?: { totalTokens: number } | null }
  | { type: "SDK_STARTED"; agentName: string }
  | { type: "SDK_COMPLETED"; agentName: string; summary?: string }
  | { type: "SDK_FAILED"; agentName: string; error: string }
  | { type: "SDK_SELECTED"; agentName: string }
  | { type: "SDK_DESELECTED"; agentName: string }
  | { type: "TOGGLE_COLLAPSE" }
  | { type: "DISMISS" }
  | { type: "RESET" };

const MAX_EVENTS = 50;

function addEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  const next = [...events, event];
  return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
}

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "ADD_AGENT": {
      const agents = new Map(state.agents);
      if (!agents.has(action.taskId)) {
        agents.set(action.taskId, {
          taskId: action.taskId,
          goal: action.goal,
          agentName: action.agentName,
          mode: action.mode ?? "background",
          status: "running",
          startedAt: Date.now(),
          completedAt: null,
          tokenUsage: null,
          events: [],
        });
      }
      return { ...state, agents, collapsed: false, dismissed: false };
    }
    case "TOOL_CALL": {
      const agents = new Map(state.agents);
      const agent = agents.get(action.taskId);
      if (agent) {
        agents.set(action.taskId, {
          ...agent,
          events: addEvent(agent.events, { type: "tool-call", toolName: action.toolName, ts: Date.now() }),
        });
      }
      return { ...state, agents };
    }
    case "TOOL_RESULT": {
      const agents = new Map(state.agents);
      const agent = agents.get(action.taskId);
      if (agent) {
        agents.set(action.taskId, {
          ...agent,
          events: addEvent(agent.events, { type: "tool-result", toolName: action.toolName, durationMs: action.durationMs, ts: Date.now() }),
        });
      }
      return { ...state, agents };
    }
    case "CHUNK": {
      const agents = new Map(state.agents);
      const agent = agents.get(action.taskId);
      if (agent) {
        agents.set(action.taskId, {
          ...agent,
          events: addEvent(agent.events, { type: "chunk", text: action.text, ts: Date.now() }),
        });
      }
      return { ...state, agents };
    }
    case "PROGRESS": {
      const agents = new Map(state.agents);
      const agent = agents.get(action.taskId);
      if (agent) {
        agents.set(action.taskId, {
          ...agent,
          events: addEvent(agent.events, { type: "progress", stage: action.stage, message: action.message, ts: Date.now() }),
        });
      }
      return { ...state, agents };
    }
    case "STATUS": {
      const agents = new Map(state.agents);
      const agent = agents.get(action.taskId);
      if (agent) {
        const completed = action.status === "completed" || action.status === "failed";
        agents.set(action.taskId, {
          ...agent,
          status: action.status === "completed" ? "completed" : action.status === "failed" ? "failed" : agent.status,
          completedAt: completed ? Date.now() : agent.completedAt,
          tokenUsage: action.tokenUsage ?? agent.tokenUsage,
          events: addEvent(agent.events, { type: "status", status: action.status, ts: Date.now() }),
        });
      }
      // Auto-collapse when all agents are done
      const allDone = [...agents.values()].every((a) => a.status !== "running");
      return { ...state, agents, collapsed: allDone ? true : state.collapsed };
    }
    case "SDK_STARTED": {
      const key = `sdk:${action.agentName}`;
      const agents = new Map(state.agents);
      agents.set(key, {
        taskId: key,
        goal: `In-session: ${action.agentName}`,
        agentName: action.agentName,
        mode: "in-session",
        status: "running",
        startedAt: Date.now(),
        completedAt: null,
        tokenUsage: null,
        events: [{ type: "status", status: "started", ts: Date.now() }],
      });
      return { ...state, agents, collapsed: false, dismissed: false };
    }
    case "SDK_COMPLETED": {
      const key = `sdk:${action.agentName}`;
      const agents = new Map(state.agents);
      const a = agents.get(key);
      if (a) {
        agents.set(key, {
          ...a,
          status: "completed",
          completedAt: Date.now(),
          events: addEvent(a.events, { type: "status", status: `completed${action.summary ? `: ${action.summary}` : ""}`, ts: Date.now() }),
        });
      }
      const allDone = [...agents.values()].every((x) => x.status !== "running");
      return { ...state, agents, collapsed: allDone ? true : state.collapsed };
    }
    case "SDK_FAILED": {
      const key = `sdk:${action.agentName}`;
      const agents = new Map(state.agents);
      const a = agents.get(key);
      if (a) {
        agents.set(key, {
          ...a,
          status: "failed",
          completedAt: Date.now(),
          events: addEvent(a.events, { type: "status", status: `failed: ${action.error}`, ts: Date.now() }),
        });
      }
      return { ...state, agents };
    }
    case "SDK_SELECTED": {
      const key = `sdk:${action.agentName}`;
      const agents = new Map(state.agents);
      const a = agents.get(key);
      if (a) {
        agents.set(key, {
          ...a,
          events: addEvent(a.events, { type: "tool-call", toolName: "subagent active", ts: Date.now() }),
        });
      }
      return { ...state, agents };
    }
    case "SDK_DESELECTED": {
      const key = `sdk:${action.agentName}`;
      const agents = new Map(state.agents);
      const a = agents.get(key);
      if (a) {
        agents.set(key, {
          ...a,
          events: addEvent(a.events, { type: "tool-result", toolName: "subagent idle", durationMs: 0, ts: Date.now() }),
        });
      }
      return { ...state, agents };
    }
    case "TOGGLE_COLLAPSE":
      return { ...state, collapsed: !state.collapsed };
    case "DISMISS":
      return { ...state, dismissed: true };
    case "RESET":
      return { agents: new Map(), collapsed: false, dismissed: false };
    default:
      return state;
  }
}

/* ── Agent Card ── */

function AgentCard({ agent }: { agent: AgentState }) {
  const logRef = useRef<HTMLDivElement>(null);
  const elapsed = (agent.completedAt ?? Date.now()) - agent.startedAt;

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [agent.events.length]);

  const statusIcon =
    agent.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> :
    agent.status === "failed" ? <XCircle className="h-3.5 w-3.5 text-red-500" /> :
    <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        {statusIcon}
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {agent.agentName || "agent"}
        </span>
        <span className={`text-[9px] rounded-full px-1.5 py-0.5 font-medium ${agent.mode === "in-session" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}>
          {agent.mode === "in-session" ? "In-Session" : "Background"}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {(elapsed / 1000).toFixed(1)}s
        </span>
        {agent.tokenUsage && (
          <span className="text-[10px] text-muted-foreground">
            {agent.tokenUsage.totalTokens.toLocaleString()} tok
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground line-clamp-1">{agent.goal}</p>
      <div ref={logRef} className="max-h-24 overflow-y-auto space-y-0.5 text-[10px]">
        {agent.events.slice(-20).map((ev, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {ev.type === "tool-call" && (
              <>
                <Wrench className="h-2.5 w-2.5 text-amber-500 shrink-0" />
                <span className="text-amber-600 dark:text-amber-400">{ev.toolName}</span>
              </>
            )}
            {ev.type === "tool-result" && (
              <>
                <CheckCircle2 className="h-2.5 w-2.5 text-green-500 shrink-0" />
                <span className="text-green-600 dark:text-green-400">{ev.toolName}</span>
                <span className="text-muted-foreground">({(ev.durationMs / 1000).toFixed(1)}s)</span>
              </>
            )}
            {ev.type === "chunk" && (
              <span className="text-muted-foreground truncate">{ev.text}</span>
            )}
            {ev.type === "progress" && (
              <>
                <Clock className="h-2.5 w-2.5 text-blue-500 shrink-0" />
                <span className="text-blue-600 dark:text-blue-400">{ev.message}</span>
              </>
            )}
            {ev.type === "status" && (
              <span className="text-muted-foreground italic">Status: {ev.status}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Main Panel ── */

export function SubagentLivePanel({ sessionId }: { sessionId: string | null }) {
  const { socket } = useSocket();
  const [state, dispatch] = useReducer(panelReducer, {
    agents: new Map(),
    collapsed: false,
    dismissed: false,
  });
  const [filter, setFilter] = useState<FilterMode>("all");

  const handleToolCall = useCallback(
    (ev: TaskToolCallEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "ADD_AGENT", taskId: ev.taskId, goal: "", agentName: "" });
      dispatch({ type: "TOOL_CALL", taskId: ev.taskId, toolName: ev.tool });
    },
    [sessionId]
  );

  const handleToolResult = useCallback(
    (ev: TaskToolResultEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "TOOL_RESULT", taskId: ev.taskId, toolName: ev.tool, durationMs: 0 });
    },
    [sessionId]
  );

  const handleChunk = useCallback(
    (ev: TaskChunkEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "CHUNK", taskId: ev.taskId, text: ev.text });
    },
    [sessionId]
  );

  const handleProgress = useCallback(
    (ev: TaskProgressEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "ADD_AGENT", taskId: ev.taskId, goal: "", agentName: "" });
      dispatch({ type: "PROGRESS", taskId: ev.taskId, stage: ev.stage, message: ev.message });
    },
    [sessionId]
  );

  const handleTaskStatus = useCallback(
    (ev: { event: string; task: { id: string; sessionId: string; status: string; goal: string; agentName?: string | null; spawnedBy?: string | null; tokenUsage?: { totalTokens: number } | null } }) => {
      if (ev.task.sessionId !== sessionId) return;
      if (ev.event === "task:running") {
        dispatch({ type: "ADD_AGENT", taskId: ev.task.id, goal: ev.task.goal, agentName: ev.task.agentName ?? ev.task.spawnedBy ?? "" });
      }
      dispatch({ type: "STATUS", taskId: ev.task.id, status: ev.task.status, tokenUsage: ev.task.tokenUsage });
    },
    [sessionId]
  );

  // SDK-native subagent handlers
  const handleSdkStarted = useCallback(
    (ev: SubagentStartedEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "SDK_STARTED", agentName: ev.agentName });
    },
    [sessionId]
  );
  const handleSdkCompleted = useCallback(
    (ev: SubagentCompletedEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "SDK_COMPLETED", agentName: ev.agentName, summary: ev.summary });
    },
    [sessionId]
  );
  const handleSdkFailed = useCallback(
    (ev: SubagentFailedEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "SDK_FAILED", agentName: ev.agentName, error: ev.error });
    },
    [sessionId]
  );
  const handleSdkSelected = useCallback(
    (ev: SubagentSelectedEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "SDK_SELECTED", agentName: ev.agentName });
    },
    [sessionId]
  );
  const handleSdkDeselected = useCallback(
    (ev: SubagentDeselectedEvent) => {
      if (ev.sessionId !== sessionId) return;
      dispatch({ type: "SDK_DESELECTED", agentName: ev.agentName });
    },
    [sessionId]
  );

  // Reset agent state when the user navigates to a different session
  useEffect(() => {
    dispatch({ type: "RESET" });
  }, [sessionId]);

  useEffect(() => {
    if (!socket) return;
    socket.on("task:tool-call", handleToolCall);
    socket.on("task:tool-result", handleToolResult);
    socket.on("task:chunk", handleChunk);
    socket.on("task:progress", handleProgress);
    socket.on("task:status", handleTaskStatus);
    socket.on("subagent:started", handleSdkStarted);
    socket.on("subagent:completed", handleSdkCompleted);
    socket.on("subagent:failed", handleSdkFailed);
    socket.on("subagent:selected", handleSdkSelected);
    socket.on("subagent:deselected", handleSdkDeselected);
    return () => {
      socket.off("task:tool-call", handleToolCall);
      socket.off("task:tool-result", handleToolResult);
      socket.off("task:chunk", handleChunk);
      socket.off("task:progress", handleProgress);
      socket.off("task:status", handleTaskStatus);
      socket.off("subagent:started", handleSdkStarted);
      socket.off("subagent:completed", handleSdkCompleted);
      socket.off("subagent:failed", handleSdkFailed);
      socket.off("subagent:selected", handleSdkSelected);
      socket.off("subagent:deselected", handleSdkDeselected);
    };
  }, [socket, handleToolCall, handleToolResult, handleChunk, handleProgress, handleTaskStatus, handleSdkStarted, handleSdkCompleted, handleSdkFailed, handleSdkSelected, handleSdkDeselected]);

  if (state.agents.size === 0 || state.dismissed) return null;

  const allAgents = [...state.agents.values()];
  const filteredAgents = filter === "all" ? allAgents : allAgents.filter((a) => a.mode === filter);
  const running = allAgents.filter((a) => a.status === "running").length;
  const bgCount = allAgents.filter((a) => a.mode === "background").length;
  const isCount = allAgents.filter((a) => a.mode === "in-session").length;

  return (
    <div className="mx-4 mb-3 rounded-xl border border-border bg-card/80 backdrop-blur" data-testid="subagent-live-panel">
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer" onClick={() => dispatch({ type: "TOGGLE_COLLAPSE" })}>
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold text-foreground flex-1">
          Active Agents ({running} running / {allAgents.length} total)
        </span>
        {/* Filter buttons */}
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {(["all", "background", "in-session"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${filter === f ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}
              aria-label={`Filter: ${f}`}
            >
              {f === "all" ? `All` : f === "background" ? `BG (${bgCount})` : `IS (${isCount})`}
            </button>
          ))}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); dispatch({ type: "DISMISS" }); }}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        {state.collapsed ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />}
      </div>
      {!state.collapsed && (
        <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filteredAgents.length === 0 ? (
            <p className="text-xs text-muted-foreground col-span-full text-center py-2">No agents match this filter.</p>
          ) : (
            filteredAgents.map((agent) => (
              <AgentCard key={agent.taskId} agent={agent} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
