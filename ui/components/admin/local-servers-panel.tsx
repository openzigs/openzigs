"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { LocalServersResponse, LocalServerDefinition, LocalServerStatus, LocalServerCredential, ToolInfo } from "@/lib/types";
import { showToast } from "@/components/toast";

export const LocalServersPanel = () => {
  const queryClient = useQueryClient();
  const { socket } = useSocket();

  const query = useQuery({
    queryKey: ["local-servers"],
    queryFn: () => fetchJson<LocalServersResponse>("/api/admin/local-servers"),
  });

  useEffect(() => {
    if (!socket) return;
    const refresh = () => queryClient.invalidateQueries({ queryKey: ["local-servers"] });
    socket.on("local-server:status", refresh);
    return () => { socket.off("local-server:status", refresh); };
  }, [socket, queryClient]);

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const data = query.data;
  if (!data) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {data.definitions.map((def) => {
        const status = data.servers.find((s) => s.name === def.name) ?? null;
        const cred = data.credentials.find((c) => c.server === def.name) ?? null;
        return <LocalServerCard key={def.name} def={def} status={status} cred={cred} />;
      })}
    </div>
  );
};

type LocalServerCardProps = {
  def: LocalServerDefinition;
  status: LocalServerStatus | null;
  cred: LocalServerCredential | null;
};

const LocalServerCard = ({ def, status, cred }: LocalServerCardProps) => {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  const badge = getLocalBadge(status);

  const restartMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/local-servers/${encodeURIComponent(def.name)}/restart`, { method: "POST" }),
    onSuccess: () => {
      showToast(`${def.name} restarted`, "success");
      queryClient.invalidateQueries({ queryKey: ["local-servers"] });
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
      queryClient.invalidateQueries({ queryKey: ["local-servers"] });
      setCredValues({});
      showToast(`${def.name} credentials saved! Restart to activate.`, "success");
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
    <div className={`rounded-2xl border transition ${expanded ? "border-primary/30" : "border-border"} bg-card`}>
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
          <span className="text-sm font-semibold text-foreground">{def.label}</span>
          <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
            {def.runtime}
          </span>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {/* Expandable body */}
      {expanded && (
        <div className="space-y-4 border-t border-border px-4 py-3">
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {def.command} {def.args.join(" ")}
          </p>

          {/* Credential fields */}
          {def.requiresCredentials && cred && cred.envVars.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Credentials
              </p>
              {cred.envVars.map((envVar) => (
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
          )}

          {status?.error && status.error !== "credentials_missing" && (
            <p className="text-xs italic text-destructive">{status.error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-2">
             {cred && cred.envVars.length > 0 && (
              <button
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                disabled={saveMutation.isPending}
                onClick={handleSave}
              >
                {saveMutation.isPending ? "Saving…" : "Save Credentials"}
              </button>
            )}
            <button
              className="rounded-lg border border-primary px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5 disabled:opacity-40"
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
            >
               {restartMutation.isPending ? "Restarting…" : "Restart"}
            </button>
          </div>

          {/* Per-tool toggles */}
          {status?.running && <LocalServerTools serverName={def.name} />}
        </div>
      )}
    </div>
  );
};

/* ── Per-tool toggles inside a local server ── */

const riskColors: Record<string, string> = {
  low: "bg-moss/15 text-moss dark:bg-moss/20 dark:text-green-400",
  medium: "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400",
  high: "bg-ember/15 text-ember dark:bg-ember/20 dark:text-red-400",
};

const LocalServerTools = ({ serverName }: { serverName: string }) => {
  const queryClient = useQueryClient();

  const toolsQuery = useQuery({
    queryKey: ["local-server-tools", serverName],
    queryFn: () =>
      fetchJson<{ tools: ToolInfo[] }>(`/api/admin/local-servers/${encodeURIComponent(serverName)}/tools`),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      fetchJson(`/api/admin/tools/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["local-server-tools", serverName] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const tools = toolsQuery.data?.tools ?? [];

  if (toolsQuery.isLoading) {
    return <p className="mt-3 text-xs text-muted-foreground">Loading tools…</p>;
  }

  if (tools.length === 0) return null;

  return (
    <div className="mt-3 space-y-1">
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
            onClick={() => toggleMutation.mutate({ name: tool.name, enabled: !tool.enabled })}
          >
            {tool.enabled ? "On" : "Off"}
          </button>
        </div>
      ))}
    </div>
  );
};

const getLocalBadge = (status: LocalServerStatus | null) => {
  if (status?.running) return { className: "bg-moss/15 text-moss", label: `Running (${status.toolCount} tools)` };
  if (status?.error === "credentials_missing") return { className: "bg-amber-500/15 text-amber-600", label: "No Credentials" };
  if (status?.error === "runtime_unavailable") return { className: "bg-muted text-muted-foreground", label: "Runtime Missing" };
  if (status?.error === "process_crashed") return { className: "bg-ember/15 text-destructive", label: "Crashed" };
  if (status && !status.running) return { className: "bg-muted text-muted-foreground", label: "Stopped" };
  return { className: "bg-muted text-muted-foreground", label: "Unknown" };
};
