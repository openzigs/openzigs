"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { SidecarCredential, SidecarStatus, SidecarsResponse, ToolInfo } from "@/lib/types";
import { showToast } from "@/components/toast";

const riskColors: Record<string, string> = {
  low: "bg-moss/15 text-moss dark:bg-moss/20 dark:text-green-400",
  medium: "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400",
  high: "bg-ember/15 text-ember dark:bg-ember/20 dark:text-red-400",
};

export const SidecarsPanel = () => {
  const queryClient = useQueryClient();
  const { socket } = useSocket();

  const sidecarsQuery = useQuery({
    queryKey: ["sidecars"],
    queryFn: () => fetchJson<SidecarsResponse>("/api/admin/sidecars"),
  });

  // Live status updates via Socket.IO
  useEffect(() => {
    if (!socket) return;
    const onStatus = () => queryClient.invalidateQueries({ queryKey: ["sidecars"] });
    socket.on("sidecar:status", onStatus);
    return () => { socket.off("sidecar:status", onStatus); };
  }, [socket, queryClient]);

  if (sidecarsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const data = sidecarsQuery.data;
  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Docker status banner */}
      <div
        className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm ${
          data.dockerAvailable
            ? "border-moss/30 bg-moss/5 text-moss"
            : "border-amber-500/30 bg-amber-500/5 text-amber-600"
        }`}
      >
        <span className="text-[10px]">{data.dockerAvailable ? "●" : "○"}</span>
        {data.dockerAvailable
          ? "Docker connected — auto-provisioning active"
          : "Docker not available — configure sidecar URLs manually via environment variables"}
      </div>

      {/* Sidecar cards grid */}
      <div className="grid gap-3 sm:grid-cols-2">
        {data.credentials.map((cred) => {
          const status = data.sidecars.find((s) => s.name === cred.platform) ?? null;
          return (
            <SidecarCard
              key={cred.platform}
              credential={cred}
              status={status}
              dockerAvailable={data.dockerAvailable}
            />
          );
        })}
      </div>
    </div>
  );
};

/* ── Single Sidecar Card ── */

type SidecarCardProps = {
  credential: SidecarCredential;
  status: SidecarStatus | null;
  dockerAvailable: boolean;
};

const SidecarCard = ({ credential, status, dockerAvailable }: SidecarCardProps) => {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  const badgeInfo = getBadgeInfo(credential, status);

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      fetchJson(`/api/admin/sidecars/${encodeURIComponent(credential.platform)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidecars"] });
      showToast(`${credential.platform} ${toggleMutation.variables ? "enabled" : "disabled"} — restart required`, "info");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const saveMutation = useMutation({
    mutationFn: (credentials: Record<string, string>) =>
      fetchJson("/api/admin/sidecars/credentials", {
        method: "POST",
        body: JSON.stringify({ credentials }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidecars"] });
      setCredValues({});
      showToast(`${credential.platform} credentials saved! Restart to activate.`, "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const restartMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/sidecars/${encodeURIComponent(credential.platform)}/restart`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidecars"] });
      showToast(`${credential.platform} restarted`, "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleSave = () => {
    const nonEmpty = Object.fromEntries(
      Object.entries(credValues).filter(([, v]) => v.trim())
    );
    if (Object.keys(nonEmpty).length === 0) {
      showToast("Enter at least one credential to save.", "error");
      return;
    }
    saveMutation.mutate(nonEmpty);
  };

  return (
    <div
      className={`rounded-2xl border transition ${expanded ? "border-primary/30" : "border-border"} bg-card`}
    >
      {/* Header */}
      <div
        className="flex cursor-pointer items-center justify-between px-4 py-3"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span className="text-sm font-semibold text-foreground">{credential.label}</span>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <ToggleSwitch
            checked={credential.enabled}
            onChange={(v) => toggleMutation.mutate(v)}
            disabled={toggleMutation.isPending}
          />
          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badgeInfo.className}`}>
            {badgeInfo.label}
          </span>
        </div>
      </div>

      {/* Expandable body */}
      {expanded && (
        <div className="space-y-4 border-t border-border px-4 py-3">
          {!credential.imageAvailable ? (
            <p className="text-xs italic text-muted-foreground">
              Docker image not yet available. This integration is coming in a future release.
            </p>
          ) : (
            <>
              {/* Credential fields */}
              {credential.envVars.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    API Credentials
                  </p>
                  {credential.envVars.map((envVar) => (
                    <div key={envVar.name} className="space-y-1">
                      <label className="font-mono text-[11px] text-muted-foreground">{envVar.name}</label>
                      <div className="flex items-center gap-1">
                        <input
                          type={showPasswords[envVar.name] ? "text" : "password"}
                          className="flex-1 rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs"
                          placeholder={envVar.configured ? "••••••••  (already set)" : "Paste your key here…"}
                          value={credValues[envVar.name] ?? ""}
                          onChange={(e) => setCredValues({ ...credValues, [envVar.name]: e.target.value })}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          className="rounded-lg border border-border px-2 py-1.5 text-sm text-muted-foreground hover:border-primary"
                          onClick={() =>
                            setShowPasswords({ ...showPasswords, [envVar.name]: !showPasswords[envVar.name] })
                          }
                        >
                          {showPasswords[envVar.name] ? "🔒" : "👁"}
                        </button>
                      </div>
                      <p className={`text-[11px] font-medium ${envVar.configured ? "text-moss" : "text-muted-foreground"}`}>
                        {envVar.configured ? "✓ Configured" : "✗ Not set"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">No credentials required</p>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                {credential.envVars.length > 0 && (
                  <button
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                    disabled={saveMutation.isPending}
                    onClick={handleSave}
                  >
                    {saveMutation.isPending ? "Saving…" : "Save Credentials"}
                  </button>
                )}
                {dockerAvailable && (
                  <button
                    className="rounded-lg border border-primary px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-40"
                    disabled={restartMutation.isPending || (!status?.running && status?.error !== "credentials_missing")}
                    onClick={() => restartMutation.mutate()}
                  >
                    {restartMutation.isPending ? "Restarting…" : "Restart"}
                  </button>
                )}
              </div>

              {/* Per-tool toggles (lazy loaded) */}
              <SidecarTools platform={credential.platform} />

              {/* URL info */}
              {status?.url && (
                <p className="break-all rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {status.url}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/* ── Per-tool toggles inside a sidecar ── */

const SidecarTools = ({ platform }: { platform: string }) => {
  const queryClient = useQueryClient();

  const toolsQuery = useQuery({
    queryKey: ["sidecar-tools", platform],
    queryFn: () =>
      fetchJson<{ tools: ToolInfo[] }>(`/api/admin/sidecars/${encodeURIComponent(platform)}/tools`),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      fetchJson(`/api/admin/tools/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidecar-tools", platform] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const tools = toolsQuery.data?.tools ?? [];

  if (toolsQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading tools…</p>;
  }

  if (tools.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Tools</p>
      {tools.map((tool) => (
        <div
          key={tool.name}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5"
        >
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-semibold text-foreground">{tool.name}</p>
            {tool.description && (
              <p className="truncate text-[11px] text-muted-foreground">{tool.description}</p>
            )}
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${riskColors[tool.riskLevel] ?? "bg-muted text-muted-foreground"}`}
          >
            {tool.riskLevel}
          </span>
          <button
            className={`w-12 rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${
              tool.enabled ? "bg-moss text-white" : "bg-muted text-ink/60"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              toggleMutation.mutate({ name: tool.name, enabled: !tool.enabled });
            }}
          >
            {tool.enabled ? "On" : "Off"}
          </button>
        </div>
      ))}
    </div>
  );
};

/* ── Helpers ── */

const getBadgeInfo = (cred: SidecarCredential, status: SidecarStatus | null) => {
  if (!cred.imageAvailable) return { className: "bg-muted text-muted-foreground", label: "Coming Soon" };
  if (!cred.enabled) return { className: "bg-muted text-muted-foreground", label: "Disabled" };
  if (status?.running && status.healthy) return { className: "bg-moss/15 text-moss", label: "Healthy" };
  if (status?.running && !status.healthy) return { className: "bg-ember/15 text-ember", label: "Unhealthy" };
  if (status?.error === "credentials_missing") return { className: "bg-amber-500/15 text-amber-600", label: "No Credentials" };
  if (status && !status.running) return { className: "bg-muted text-muted-foreground", label: "Stopped" };
  return { className: "bg-muted text-muted-foreground", label: "Unknown" };
};

const ToggleSwitch = ({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-moss" : "bg-muted"}`}
    onClick={() => onChange(!checked)}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`}
    />
  </button>
);
