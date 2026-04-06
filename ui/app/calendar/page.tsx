"use client";

export const dynamic = "force-dynamic";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type {
  EventInput,
  EventDropArg,
  DateSelectArg,
  EventHoveringArg,
} from "@fullcalendar/core";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { AddToOutboxModal } from "@/components/add-to-outbox-modal";
import {
  Calendar as CalendarIcon,
  Filter,
  RefreshCw,
  Plus,
  X,
  Clock,
  ExternalLink,
  Trash2,
  Save,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────

type OutboxStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "canceled";
type OutboxPlatform =
  | "twitter"
  | "pinterest"
  | "linkedin"
  | "youtube"
  | "reddit"
  | "instagram"
  | "facebook";

interface OutboxItem {
  id: string;
  title: string | null;
  assetId: string | null;
  assetUrl: string | null;
  assetType: string;
  contentBody: string | null;
  platform: OutboxPlatform;
  scheduledTime: string;
  agentContext: string;
  status: OutboxStatus;
  error: string | null;
  publishedUrl: string | null;
}

// ── Color maps ──────────────────────────────────────────────

const STATUS_COLORS: Record<OutboxStatus, string> = {
  pending: "#3b82f6", // blue
  processing: "#eab308", // yellow
  published: "#22c55e", // green
  failed: "#ef4444", // red
  canceled: "#6b7280", // gray
};

const PLATFORM_EMOJI: Record<OutboxPlatform, string> = {
  twitter: "𝕏",
  pinterest: "📌",
  linkedin: "💼",
  youtube: "▶️",
  reddit: "🔴",
  instagram: "📸",
  facebook: "📘",
};

const ALL_PLATFORMS: OutboxPlatform[] = [
  "twitter",
  "pinterest",
  "linkedin",
  "youtube",
  "reddit",
  "instagram",
  "facebook",
];
const ALL_STATUSES: OutboxStatus[] = [
  "pending",
  "processing",
  "published",
  "failed",
  "canceled",
];

// ── Page Component ──────────────────────────────────────────

export default function ContentCalendarPage() {
  const queryClient = useQueryClient();
  const calendarRef = useRef<FullCalendar>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editItem, setEditItem] = useState<OutboxItem | null>(null);
  const [filterPlatform, setFilterPlatform] = useState<OutboxPlatform | "">("");
  const [filterStatus, setFilterStatus] = useState<OutboxStatus | "">("");
  const [currentView, setCurrentView] = useState<
    "dayGridMonth" | "timeGridWeek" | "timeGridDay"
  >("dayGridMonth");

  // ── Fetch outbox items ──
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["calendar-outbox", filterPlatform, filterStatus],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterPlatform) params.set("platform", filterPlatform);
      if (filterStatus) params.set("status", filterStatus);
      params.set("limit", "200");
      const qs = params.toString();
      return fetchJson<{ items: OutboxItem[] }>(
        `/api/admin/outbox${qs ? `?${qs}` : ""}`,
      );
    },
    refetchInterval: 30_000,
  });

  // ── Fetch full item for edit ──
  const fetchItem = useCallback(
    async (id: string) => {
      const found = data?.items.find((i) => i.id === id);
      if (found) setEditItem(found);
    },
    [data?.items],
  );

  // ── Reschedule mutation (drag & drop) ──
  const reschedule = useMutation({
    mutationFn: async ({
      id,
      scheduledTime,
    }: {
      id: string;
      scheduledTime: string;
    }) => {
      return fetchJson(`/api/admin/outbox/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled_time: scheduledTime }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-outbox"] });
      showToast("Post rescheduled", "success");
    },
    onError: (err: Error) => {
      showToast(`Reschedule failed: ${err.message}`, "error");
      refetch();
    },
  });

  // ── Edit/save mutation ──
  const saveEdit = useMutation({
    mutationFn: async ({
      id,
      title,
      content_body,
      scheduled_time,
    }: {
      id: string;
      title: string;
      content_body: string;
      scheduled_time: string;
    }) => {
      return fetchJson(`/api/admin/outbox/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content_body, scheduled_time }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-outbox"] });
      showToast("Post updated", "success");
      setEditItem(null);
    },
    onError: (err: Error) => {
      showToast(`Save failed: ${err.message}`, "error");
    },
  });

  // ── Delete mutation ──
  const deleteItem = useMutation({
    mutationFn: async (id: string) => {
      return fetchJson(`/api/admin/outbox/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-outbox"] });
      showToast("Post deleted", "success");
      setEditItem(null);
    },
    onError: (err: Error) => {
      showToast(`Delete failed: ${err.message}`, "error");
    },
  });

  // ── Map outbox items to calendar events ──
  const events: EventInput[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => ({
      id: item.id,
      title: `${PLATFORM_EMOJI[item.platform]} ${item.title || item.contentBody?.slice(0, 40) || item.agentContext.slice(0, 40)}`,
      start: item.scheduledTime,
      backgroundColor: STATUS_COLORS[item.status],
      borderColor: STATUS_COLORS[item.status],
      textColor: "#fff",
      extendedProps: {
        platform: item.platform,
        status: item.status,
        contentBody: item.contentBody,
        publishedUrl: item.publishedUrl,
        error: item.error,
        title: item.title,
        agentContext: item.agentContext,
        scheduledTime: item.scheduledTime,
      },
      editable: item.status === "pending",
    }));
  }, [data?.items]);

  // ── Upcoming events (next 14 days, pending/processing) ──
  const upcomingEvents = useMemo(() => {
    if (!data?.items) return [];
    const now = Date.now();
    const cutoff = now + 14 * 24 * 60 * 60 * 1000;
    return data.items
      .filter((item) => {
        const t = new Date(item.scheduledTime).getTime();
        return (
          t >= now &&
          t <= cutoff &&
          ["pending", "processing"].includes(item.status)
        );
      })
      .sort(
        (a, b) =>
          new Date(a.scheduledTime).getTime() -
          new Date(b.scheduledTime).getTime(),
      )
      .slice(0, 20);
  }, [data?.items]);

  // ── Handlers ──
  const handleEventDrop = useCallback(
    (info: EventDropArg) => {
      const newTime = info.event.start;
      if (!newTime) return;
      if (info.event.extendedProps?.status !== "pending") {
        info.revert();
        showToast("Only pending items can be rescheduled", "error");
        return;
      }
      reschedule.mutate({
        id: info.event.id,
        scheduledTime: newTime.toISOString(),
      });
    },
    [reschedule],
  );

  const handleDateSelect = useCallback((_info: DateSelectArg) => {
    setShowAddModal(true);
  }, []);

  const handleEventClick = useCallback(
    (info: { event: { id: string } }) => {
      fetchItem(info.event.id);
    },
    [fetchItem],
  );

  // ── Tooltip ──
  const handleEventMouseEnter = useCallback((info: EventHoveringArg) => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const p = info.event.extendedProps;
    const platformLabel =
      (p.platform as string).charAt(0).toUpperCase() +
      (p.platform as string).slice(1);
    tooltip.innerHTML = `<span class="font-semibold">${PLATFORM_EMOJI[p.platform as OutboxPlatform]} ${platformLabel}</span> · <span style="color:${STATUS_COLORS[p.status as OutboxStatus]}">${p.status}</span>`;
    tooltip.style.display = "block";

    const rect = (info.el as HTMLElement).getBoundingClientRect();
    tooltip.style.top = `${rect.bottom + window.scrollY + 6}px`;
    tooltip.style.left = `${rect.left + window.scrollX}px`;
  }, []);

  const handleEventMouseLeave = useCallback(() => {
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      {/* Floating tooltip */}
      <div
        ref={tooltipRef}
        className="pointer-events-none fixed z-50 hidden rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs shadow-xl"
        style={{ display: "none" }}
      />

      <div className="mx-auto max-w-[1600px] space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CalendarIcon className="h-6 w-6 text-blue-400" />
            <h1 className="text-2xl font-bold">Content Calendar</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium transition hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              Schedule Post
            </button>
            <button
              onClick={() => refetch()}
              className="rounded-lg bg-zinc-800 p-2 transition hover:bg-zinc-700"
              title="Refresh"
            >
              <RefreshCw
                className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
              />
            </button>
          </div>
        </div>

        {/* Filters */}
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <Filter className="h-4 w-4" />
              Filters
            </span>
          }
          defaultOpen={false}
        >
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Platform
              </label>
              <select
                value={filterPlatform}
                onChange={(e) =>
                  setFilterPlatform(e.target.value as OutboxPlatform | "")
                }
                className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm"
              >
                <option value="">All Platforms</option>
                {ALL_PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_EMOJI[p]} {p.charAt(0).toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Status</label>
              <select
                value={filterStatus}
                onChange={(e) =>
                  setFilterStatus(e.target.value as OutboxStatus | "")
                }
                className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm"
              >
                <option value="">All Statuses</option>
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            {/* Status legend */}
            <div className="ml-auto flex items-center gap-3">
              {ALL_STATUSES.map((s) => (
                <div key={s} className="flex items-center gap-1.5 text-xs">
                  <span
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: STATUS_COLORS[s] }}
                  />
                  {s}
                </div>
              ))}
            </div>
          </div>
        </SectionCard>

        {/* Two-column layout: Calendar + Upcoming panel */}
        <div className="flex gap-6">
          {/* Calendar */}
          <div className="calendar-container min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <style>{`
              .calendar-container .fc {
                --fc-bg-event-opacity: 0.9;
                --fc-border-color: #27272a;
                --fc-button-bg-color: #27272a;
                --fc-button-border-color: #3f3f46;
                --fc-button-hover-bg-color: #3f3f46;
                --fc-button-hover-border-color: #52525b;
                --fc-button-active-bg-color: #3b82f6;
                --fc-button-active-border-color: #3b82f6;
                --fc-button-text-color: #e4e4e7;
                --fc-event-text-color: #fff;
                --fc-today-bg-color: rgba(59, 130, 246, 0.05);
                --fc-page-bg-color: transparent;
                --fc-neutral-bg-color: transparent;
                --fc-list-event-hover-bg-color: #27272a;
                color: #e4e4e7;
              }
              .calendar-container .fc th {
                color: #a1a1aa;
                font-weight: 500;
              }
              .calendar-container .fc-daygrid-day-number,
              .calendar-container .fc-col-header-cell-cushion {
                color: #d4d4d8;
              }
              .calendar-container .fc-event {
                cursor: pointer;
                border-radius: 4px;
                font-size: 0.75rem;
                padding: 1px 4px;
              }
              .calendar-container .fc-event:hover {
                opacity: 0.85;
              }
              .calendar-container .fc-toolbar-title {
                font-size: 1.25rem !important;
                font-weight: 600;
              }
            `}</style>
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView={currentView}
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: "dayGridMonth,timeGridWeek,timeGridDay",
              }}
              events={events}
              editable={true}
              selectable={true}
              selectMirror={true}
              eventDrop={handleEventDrop}
              select={handleDateSelect}
              eventClick={handleEventClick}
              eventMouseEnter={handleEventMouseEnter}
              eventMouseLeave={handleEventMouseLeave}
              height="auto"
              aspectRatio={1.6}
              dayMaxEvents={4}
              nowIndicator={true}
              viewDidMount={(info) =>
                setCurrentView(info.view.type as typeof currentView)
              }
            />
          </div>

          {/* Upcoming Events Panel */}
          <div className="flex w-72 shrink-0 flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
              <Clock className="h-4 w-4 text-blue-400" />
              Upcoming (14 days)
            </div>
            {upcomingEvents.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-center text-xs text-zinc-500">
                No scheduled posts in the next 14 days.
              </div>
            ) : (
              <div
                className="space-y-2 overflow-y-auto"
                style={{ maxHeight: "calc(100vh - 280px)" }}
              >
                {upcomingEvents.map((item) => {
                  const dt = new Date(item.scheduledTime);
                  const isToday =
                    dt.toDateString() === new Date().toDateString();
                  const isTomorrow =
                    dt.toDateString() ===
                    new Date(Date.now() + 86400000).toDateString();
                  const dayLabel = isToday
                    ? "Today"
                    : isTomorrow
                      ? "Tomorrow"
                      : dt.toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        });
                  const timeLabel = dt.toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  });

                  return (
                    <button
                      key={item.id}
                      onClick={() => setEditItem(item)}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-left transition hover:border-zinc-700 hover:bg-zinc-800"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-base leading-none">
                          {PLATFORM_EMOJI[item.platform]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-zinc-200">
                            {item.title ||
                              item.contentBody?.slice(0, 50) ||
                              item.agentContext.slice(0, 50)}
                          </p>
                          <p className="mt-0.5 text-[11px] text-zinc-500">
                            {dayLabel} · {timeLabel}
                          </p>
                        </div>
                        <span
                          className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: STATUS_COLORS[item.status],
                          }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {editItem && (
        <EditPostModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onSave={(id, title, content_body, scheduled_time) =>
            saveEdit.mutate({ id, title, content_body, scheduled_time })
          }
          onDelete={(id) => deleteItem.mutate(id)}
          isSaving={saveEdit.isPending}
          isDeleting={deleteItem.isPending}
        />
      )}

      <AddToOutboxModal
        open={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          queryClient.invalidateQueries({ queryKey: ["calendar-outbox"] });
        }}
      />

      <ToastContainer />
    </div>
  );
}

// ── Edit Post Modal ─────────────────────────────────────────

function EditPostModal({
  item,
  onClose,
  onSave,
  onDelete,
  isSaving,
  isDeleting,
}: {
  item: OutboxItem;
  onClose: () => void;
  onSave: (
    id: string,
    title: string,
    content_body: string,
    scheduled_time: string,
  ) => void;
  onDelete: (id: string) => void;
  isSaving: boolean;
  isDeleting: boolean;
}) {
  const [title, setTitle] = useState(item.title ?? "");
  const [contentBody, setContentBody] = useState(item.contentBody ?? "");
  const [scheduledTime, setScheduledTime] = useState(
    // Convert ISO to datetime-local format (YYYY-MM-DDTHH:mm)
    new Date(item.scheduledTime).toISOString().slice(0, 16),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canEdit = item.status === "pending" || item.status === "canceled";
  const platformLabel =
    item.platform.charAt(0).toUpperCase() + item.platform.slice(1);

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [onClose]);

  const handleSave = () => {
    onSave(item.id, title, contentBody, new Date(scheduledTime).toISOString());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">{PLATFORM_EMOJI[item.platform]}</span>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                {platformLabel} Post
              </h2>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{
                  backgroundColor: STATUS_COLORS[item.status] + "22",
                  color: STATUS_COLORS[item.status],
                }}
              >
                {item.status}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Fields */}
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!canEdit}
              placeholder="Post title…"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Content
            </label>
            <textarea
              value={contentBody}
              onChange={(e) => setContentBody(e.target.value)}
              disabled={!canEdit}
              rows={5}
              placeholder="Post content…"
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Scheduled Time
            </label>
            <input
              type="datetime-local"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              disabled={!canEdit}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          {item.publishedUrl && (
            <a
              href={item.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              View published post
            </a>
          )}

          {item.error && (
            <p className="rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-400">
              Error: {item.error}
            </p>
          )}
        </div>

        {!canEdit && (
          <p className="mt-4 text-center text-xs text-zinc-500">
            This post is {item.status} and cannot be edited.
          </p>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-between">
          {canEdit ? (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-400">Are you sure?</span>
                <button
                  onClick={() => onDelete(item.id)}
                  disabled={isDeleting}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
                >
                  {isDeleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 transition hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-500 transition hover:bg-zinc-800 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-zinc-400 transition hover:text-zinc-200"
            >
              Close
            </button>
            {canEdit && (
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {isSaving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
