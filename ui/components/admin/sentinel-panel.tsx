"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { SentinelStatus, SentinelAlert, DigestRecord } from "@/lib/types";
import { showToast } from "@/components/toast";
import {
  Shield,
  Play,
  Power,
  PowerOff,
  Clock,
  AlertTriangle,
  CheckCircle2,
  FileText,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

/* ── Sentinel Admin Panel ── */

export const SentinelPanel = () => {
  const queryClient = useQueryClient();
  const [showDigests, setShowDigests] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["sentinel-status"],
    queryFn: () => fetchJson<SentinelStatus>("/api/admin/sentinel/status"),
    refetchInterval: 10_000,
  });

  const digestsQuery = useQuery({
    queryKey: ["sentinel-digests"],
    queryFn: () => fetchJson<{ digests: DigestRecord[] }>("/api/admin/sentinel/digests?limit=10"),
    enabled: showDigests,
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      fetchJson("/api/admin/sentinel/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sentinel-status"] });
      showToast("Sentinel toggled.", "success");
    },
    onError: (err) => {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    },
  });

  const runNowMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ totalTasks: number; successRate: number; alertCount: number; alerts: SentinelAlert[] }>(
        "/api/admin/sentinel/run-now",
        { method: "POST" }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["sentinel-status"] });
      showToast(
        `Check complete: ${data.totalTasks} tasks, ${(data.successRate * 100).toFixed(0)}% success, ${data.alertCount} alerts.`,
        data.alertCount > 0 ? "warning" : "success"
      );
    },
    onError: (err) => {
      showToast(`Check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    },
  });

  if (statusQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const status = statusQuery.data;
  if (!status) return <p className="text-sm text-muted-foreground">Sentinel not available.</p>;

  return (
    <div className="space-y-5">
      {/* Status Overview */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatBadge
          label="Status"
          value={status.enabled ? "Active" : "Inactive"}
          color={status.enabled ? "text-emerald-500" : "text-muted-foreground"}
          icon={status.enabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
        />
        <StatBadge
          label="Tasks Reviewed"
          value={status.totalTasksReviewed}
          color="text-sky-500"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <StatBadge
          label="Alerts Sent"
          value={status.alertsSent}
          color={status.alertsSent > 0 ? "text-amber-500" : "text-emerald-500"}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <StatBadge
          label="Consecutive Fails"
          value={status.consecutiveFailures}
          color={status.consecutiveFailures >= status.config.consecutiveFailureThreshold ? "text-red-500" : "text-emerald-500"}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Sentinel Controls</h3>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${
              status.enabled
                ? "border border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/20"
                : "border border-emerald-500/30 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20"
            }`}
            onClick={() => toggleMutation.mutate(!status.enabled)}
            disabled={toggleMutation.isPending}
          >
            {status.enabled ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
            {toggleMutation.isPending ? "Toggling…" : status.enabled ? "Disable" : "Enable"}
          </button>

          <button
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
            onClick={() => runNowMutation.mutate()}
            disabled={runNowMutation.isPending}
          >
            {runNowMutation.isPending ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {runNowMutation.isPending ? "Running…" : "Run Check Now"}
          </button>
        </div>
      </div>

      {/* Timing Info */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Schedule</h3>
        </div>
        <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <TimeItem label="Last Task Check" value={status.lastTaskCheckAt} />
          <TimeItem label="Last Digest" value={status.lastDigestAt} />
          <TimeItem label="Last Prompt Audit" value={status.lastPromptAuditAt} />
          <TimeItem label="Next Check (est.)" value={status.nextCheckEstimate} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <ConfigItem label="Interval" value={`${status.config.checkIntervalMinutes}min`} />
          <ConfigItem label="Jitter" value={`±${status.config.jitterMinutes}min`} />
          <ConfigItem label="Digest Hour" value={`${status.config.digestHour}:00`} />
          <ConfigItem label="Audit Hour" value={`${status.config.auditHour}:00`} />
        </div>
      </div>

      {/* Digest History */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <button
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setShowDigests(!showDigests)}
        >
          <FileText className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Digest History</h3>
          {showDigests ? (
            <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {showDigests && (
          <div className="space-y-2">
            {digestsQuery.isLoading && (
              <p className="text-xs text-muted-foreground">Loading digests…</p>
            )}
            {digestsQuery.data?.digests.length === 0 && (
              <p className="text-xs text-muted-foreground">No digests generated yet.</p>
            )}
            {digestsQuery.data?.digests.map((digest) => (
              <DigestCard key={digest.id} digest={digest} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Sub-components ── */

const StatBadge = ({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: string | number;
  color: string;
  icon?: React.ReactNode;
}) => (
  <div className="flex flex-col items-center rounded-xl border border-border bg-card p-3">
    <div className={`flex items-center gap-1.5 ${color}`}>
      {icon}
      <span className="text-xl font-bold tabular-nums">{value}</span>
    </div>
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
);

const TimeItem = ({ label, value }: { label: string; value: string | null }) => (
  <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-1.5">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium text-foreground">
      {value ? new Date(value).toLocaleString() : "—"}
    </span>
  </div>
);

const ConfigItem = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-1.5">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-semibold text-foreground">{value}</span>
  </div>
);

const DigestCard = ({ digest }: { digest: DigestRecord }) => (
  <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">
        {new Date(digest.generatedAt).toLocaleString()}
      </span>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-foreground font-semibold">{digest.totalTasks} tasks</span>
        <span className={digest.successRate >= 0.9 ? "text-emerald-500" : "text-amber-500"}>
          {(digest.successRate * 100).toFixed(0)}% success
        </span>
        {digest.alertCount > 0 && (
          <span className="text-red-500">{digest.alertCount} alerts</span>
        )}
      </div>
    </div>
    <p className="text-xs text-muted-foreground whitespace-pre-wrap">{digest.summary}</p>
    {digest.promptAuditSummary && (
      <p className="text-xs text-muted-foreground/80 italic">{digest.promptAuditSummary}</p>
    )}
  </div>
);
