"use client";

export const dynamic = "force-dynamic";

import { useState, useCallback, useMemo, useRef } from "react";
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
} from "@fullcalendar/core";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { AddToOutboxModal } from "@/components/add-to-outbox-modal";
import {
  Calendar as CalendarIcon,
  Filter,
  RefreshCw,
  Plus,
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
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
      },
      editable: item.status === "pending",
    }));
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

  const handleDateSelect = useCallback((info: DateSelectArg) => {
    setSelectedDate(info.start);
    setShowAddModal(true);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-[1400px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CalendarIcon className="w-6 h-6 text-blue-400" />
            <h1 className="text-2xl font-bold">Content Calendar</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition"
            >
              <Plus className="w-4 h-4" />
              Schedule Post
            </button>
            <button
              onClick={() => refetch()}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition"
              title="Refresh"
            >
              <RefreshCw
                className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
              />
            </button>
          </div>
        </div>

        {/* Filters */}
        <SectionCard
          title="Filters"
          icon={<Filter className="w-4 h-4" />}
          defaultOpen={false}
        >
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Platform
              </label>
              <select
                value={filterPlatform}
                onChange={(e) =>
                  setFilterPlatform(e.target.value as OutboxPlatform | "")
                }
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm"
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
              <label className="block text-xs text-zinc-400 mb-1">Status</label>
              <select
                value={filterStatus}
                onChange={(e) =>
                  setFilterStatus(e.target.value as OutboxStatus | "")
                }
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm"
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
            <div className="flex items-center gap-3 ml-auto">
              {ALL_STATUSES.map((s) => (
                <div key={s} className="flex items-center gap-1.5 text-xs">
                  <span
                    className="w-3 h-3 rounded-full inline-block"
                    style={{ backgroundColor: STATUS_COLORS[s] }}
                  />
                  {s}
                </div>
              ))}
            </div>
          </div>
        </SectionCard>

        {/* Calendar */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 calendar-container">
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
            eventClick={(info) => {
              const url = info.event.extendedProps?.publishedUrl;
              if (url) window.open(url, "_blank");
            }}
            height="auto"
            aspectRatio={1.8}
            dayMaxEvents={4}
            nowIndicator={true}
            viewDidMount={(info) =>
              setCurrentView(info.view.type as typeof currentView)
            }
          />
        </div>
      </div>

      {showAddModal && (
        <AddToOutboxModal
          onClose={() => {
            setShowAddModal(false);
            setSelectedDate(null);
          }}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["calendar-outbox"] });
            setShowAddModal(false);
            setSelectedDate(null);
            showToast("Post scheduled", "success");
          }}
          initialDate={selectedDate ?? undefined}
        />
      )}

      <ToastContainer />
    </div>
  );
}
