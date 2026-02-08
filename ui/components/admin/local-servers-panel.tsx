"use client";

import { useEffect } from "react";
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

const LocalServerCard = ({ def, status, cred: _cred }: LocalServerCardProps) => {
  const queryClient = useQueryClient();

  const badge = getLocalBadge(status);

  const handleRestart = async () => {
    try {
      await fetchJson(`/api/admin/local-servers/${encodeURIComponent(def.name)}/restart`, { method: "POST" });
      showToast(`${def.name} restarted`, "success");
      queryClient.invalidateQueries({ queryKey: ["local-servers"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Error: ${msg}`, "error");
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{def.label}</span>
          <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
            {def.runtime}
          </span>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
        {def.command} {def.args.join(" ")}
      </p>
      {status?.error && status.error !== "credentials_missing" && (
        <p className="mt-2 text-xs italic text-destructive">{status.error}</p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          className="rounded-lg border border-primary px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5"
          onClick={handleRestart}
        >
          Restart
        </button>
      </div>

      {/* Per-tool toggles */}
      {status?.running && <LocalServerTools serverName={def.name} />}
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
