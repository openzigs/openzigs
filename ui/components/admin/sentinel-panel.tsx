"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { SentinelStatus, SentinelAlert, DigestRecord, PromptRecommendation } from "@/lib/types";
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
  Download,
  Lightbulb,
  Star,
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
        data.alertCount > 0 ? "info" : "success"
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
          <ConfigItem label="Jitter" value={`up to ${status.config.jitterMinutes}min`} />
          <ConfigItem label="Digest Hour" value={`${status.config.digestHour}:00`} />
          <ConfigItem label="Audit Hour" value={`${status.config.auditHour}:00`} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <ConfigItem label="Timezone" value={status.config.timezone ?? "UTC"} />
          <ConfigItem label="No Overlap" value={status.config.noOverlap !== false ? "On" : "Off"} />
          <ConfigItem label="Critical CD" value={`${status.config.criticalCooldownMinutes ?? 5}min`} />
          <ConfigItem label="Warning CD" value={`${status.config.warningCooldownMinutes ?? 30}min`} />
        </div>
        {status.config.notifyChannels && status.config.notifyChannels.length > 0 && (
          <div className="mt-2 text-xs">
            <ConfigItem label="Notify Channels" value={status.config.notifyChannels.join(", ")} />
          </div>
        )}
      </div>

      {/* Digest History */}
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex w-full items-center gap-2">
          <button
            className="flex flex-1 items-center gap-2 text-left"
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
          <button
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/30 hover:bg-primary/5"
            onClick={async () => {
              try {
                const res = await fetch("/api/admin/sentinel/digest-markdown");
                if (!res.ok) {
                  const body = await res.json().catch(() => ({ error: "Download failed" }));
                  throw new Error(body.error ?? `HTTP ${res.status}`);
                }
                const text = await res.text();
                const blob = new Blob([text], { type: "text/markdown" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `sentinel-digest-${new Date().toISOString().slice(0, 10)}.md`;
                a.click();
                URL.revokeObjectURL(url);
              } catch (err) {
                showToast(
                  `Download failed: ${err instanceof Error ? err.message : String(err)}`,
                  "error"
                );
              }
            }}
            title="Download latest digest as Markdown"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        </div>

        {showDigests && (
          <div className="space-y-2">
            {digestsQuery.isLoading && (
              <p className="text-xs text-muted-foreground">Loading digests…</p>
            )}
            {digestsQuery.data?.digests.length === 0 && (
              <p className="text-xs text-muted-foreground">No digests generated yet.</p>
            )}
            {digestsQuery.data?.digests.map((digest) => (
              <DigestCard key={`${digest.timestamp}:${digest.period.from}:${digest.period.to}`} digest={digest} />
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

const DigestCard = ({ digest }: { digest: DigestRecord }) => {
  const [showRecs, setShowRecs] = useState(false);
  const totalTasks = digest.taskSummary.completed + digest.taskSummary.failed + digest.taskSummary.cancelled;
  const recs = digest.promptRecommendations ?? [];

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {new Date(digest.timestamp).toLocaleString()}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-foreground font-semibold">{totalTasks} tasks</span>
          <span className={digest.taskSummary.successRate >= 0.9 ? "text-emerald-500" : "text-amber-500"}>
            {(digest.taskSummary.successRate * 100).toFixed(0)}% success
          </span>
          {digest.alertCount > 0 && (
            <span className="text-red-500">{digest.alertCount} alerts</span>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {digest.taskSummary.completed} completed, {digest.taskSummary.failed} failed, {digest.taskSummary.cancelled} cancelled
      </p>
      {digest.promptAudit && (
        <p className="text-xs text-muted-foreground/80 italic">
          Prompt audit: {digest.promptAudit.sampledCount} sampled, avg score {digest.promptAudit.avgScore.toFixed(1)}/10
        </p>
      )}

      {/* Prompt Recommendations */}
      {recs.length > 0 && (
        <div className="pt-1">
          <button
            className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            onClick={() => setShowRecs(!showRecs)}
          >
            <Lightbulb className="h-3.5 w-3.5" />
            Prompt Improvements
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-primary">
              {recs.length}
            </span>
            {showRecs ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </button>

          {showRecs && (
            <div className="mt-2 space-y-2">
              {recs.map((rec, i) => (
                <PromptRecCard key={`${rec.sessionId}-${i}`} rec={rec} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ── Prompt Recommendation Card ── */

const scoreColor = (score: number) => {
  if (score >= 8) return "text-emerald-500 bg-emerald-500/10";
  if (score >= 5) return "text-amber-500 bg-amber-500/10";
  return "text-red-500 bg-red-500/10";
};

const PromptRecCard = ({ rec }: { rec: PromptRecommendation }) => {
  const [expanded, setExpanded] = useState(false);
  const truncatedPrompt =
    rec.prompt.length > 120 ? `${rec.prompt.slice(0, 120)}…` : rec.prompt;

  return (
    <div className="rounded-md border border-border bg-muted/20 p-2 space-y-1">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${scoreColor(rec.score)}`}
        >
          <Star className="h-2.5 w-2.5" />
          {rec.score}/10
        </span>
        <button
          className="flex-1 text-left text-xs text-muted-foreground truncate hover:text-foreground transition"
          onClick={() => setExpanded(!expanded)}
          title={rec.prompt}
        >
          {truncatedPrompt}
        </button>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
      </div>

      {expanded && (
        <div className="space-y-1.5 pt-1">
          {rec.suggestions.length > 0 && (
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Suggestions
              </span>
              <ul className="mt-0.5 space-y-0.5">
                {rec.suggestions.map((s, j) => (
                  <li key={j} className="text-xs text-foreground pl-2 border-l-2 border-primary/30">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rec.rewrite && rec.score < 7 && (
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Suggested Rewrite
              </span>
              <pre className="mt-0.5 rounded bg-muted/50 p-2 text-xs text-foreground overflow-x-auto whitespace-pre-wrap">
                {rec.rewrite}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
