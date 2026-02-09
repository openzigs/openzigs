"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { SessionInfo, ConversationEvent } from "@/lib/types";
import { showToast } from "@/components/toast";
import Link from "next/link";
import {
  MessageSquare,
  Trash2,
  ChevronDown,
  ChevronRight,
  Clock,
  User,
  Radio,
  Wrench,
  Bot,
  Hash,
  RotateCcw,
  Shield,
} from "lucide-react";

const CHANNEL_COLORS: Record<string, string> = {
  web: "text-sky-500",
  telegram: "text-blue-500",
  discord: "text-indigo-500",
  slack: "text-green-500",
};

const EVENT_ICONS: Record<string, typeof MessageSquare> = {
  user: User,
  assistant: Bot,
  tool_call: Wrench,
  tool_result: Radio,
};

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const relativeTime = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export const SessionsPanel = () => {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: () => fetchJson<{ sessions: SessionInfo[] }>("/api/admin/sessions"),
    refetchInterval: 10_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      showToast("Session deleted.", "success");
    },
    onError: (err) =>
      showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, "error"),
  });

  const sessions = sessionsQuery.data?.sessions ?? [];

  if (sessionsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
        <MessageSquare className="h-8 w-8 opacity-40" />
        <p className="text-sm">No sessions found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatBadge label="Total" value={sessions.length} color="text-foreground" />
        {["web", "telegram", "discord"].map((ch) => {
          const count = sessions.filter((s) => s.channel === ch).length;
          if (count === 0) return null;
          return (
            <StatBadge
              key={ch}
              label={ch.charAt(0).toUpperCase() + ch.slice(1)}
              value={count}
              color={CHANNEL_COLORS[ch] ?? "text-foreground"}
            />
          );
        })}
      </div>

      {/* Session List */}
      <div className="space-y-2">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            expanded={expanded === session.id}
            onToggle={() => setExpanded(expanded === session.id ? null : session.id)}
            onDelete={() => deleteMutation.mutate(session.id)}
            deleting={deleteMutation.isPending}
          />
        ))}
      </div>

      {/* Cleanup Policy */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Auto-Cleanup Policy
          </h3>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <LimitItem label="Max Age" value="7 days" />
          <LimitItem label="Max Sessions" value="100" />
          <LimitItem label="Max Size" value="10 MB" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Sessions older than 7 days are automatically deleted. Individual event files are
          truncated at 10 MB, keeping the most recent messages.
        </p>
      </div>
    </div>
  );
};

/* ── Session Row ── */

type SessionRowProps = {
  session: SessionInfo;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  deleting: boolean;
};

const SessionRow = ({ session, expanded, onToggle, onDelete, deleting }: SessionRowProps) => {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-xl border border-border bg-card transition">
      {/* Header */}
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted/40"
        onClick={onToggle}
      >
        <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" />

        <span
          className={`text-xs font-semibold uppercase tracking-wide ${CHANNEL_COLORS[session.channel] ?? "text-foreground"}`}
        >
          {session.channel}
        </span>

        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <User className="h-3 w-3" />
          {truncate(session.userId, 24)}
        </span>

        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Hash className="h-3 w-3" />
          {session.id.slice(0, 8)}
        </span>

        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {relativeTime(session.lastActiveAt)}
        </span>

        <Link
          href={`/chat?session=${session.id}`}
          className="ml-2 rounded-lg p-1.5 text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
          onClick={(e) => e.stopPropagation()}
          title="Restore to Chat"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Link>

        <button
          className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          disabled={deleting}
          title="Delete session"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </button>

      {/* Expanded History */}
      {expanded && <SessionHistory sessionId={session.id} />}
    </div>
  );
};

/* ── Session History (lazy-loaded on expand) ── */

const SessionHistory = ({ sessionId }: { sessionId: string }) => {
  const historyQuery = useQuery({
    queryKey: ["session-history", sessionId],
    queryFn: () =>
      fetchJson<{ events: ConversationEvent[] }>(
        `/api/admin/sessions/${sessionId}/history?limit=50`
      ),
  });

  if (historyQuery.isLoading) {
    return <p className="px-4 pb-4 text-xs text-muted-foreground">Loading history…</p>;
  }

  const events = historyQuery.data?.events ?? [];

  if (events.length === 0) {
    return (
      <p className="px-4 pb-4 text-xs text-muted-foreground italic">
        No conversation events in this session.
      </p>
    );
  }

  return (
    <div className="border-t border-border px-4 py-3">
      <p className="mb-2 text-xs font-semibold text-muted-foreground">
        History ({events.length} event{events.length !== 1 ? "s" : ""})
      </p>
      <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {events.map((event, idx) => {
          const Icon = EVENT_ICONS[event.type] ?? MessageSquare;
          return (
            <div
              key={idx}
              className="flex items-start gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs"
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold capitalize text-foreground">
                    {event.type.replace("_", " ")}
                  </span>
                  {event.metadata?.toolName && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {event.metadata.toolName}
                    </span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                  {truncate(event.content, 500)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ── Small helpers ── */

const StatBadge = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div className="flex flex-col items-center rounded-xl border border-border bg-card p-3">
    <span className={`text-2xl font-bold tabular-nums ${color}`}>{value}</span>
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
);

const LimitItem = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-1.5">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-semibold text-foreground">{value}</span>
  </div>
);
