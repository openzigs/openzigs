"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { LocalServersResponse, LocalServerDefinition, LocalServerStatus, LocalServerCredential } from "@/lib/types";
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

  if (query.isLoading) return <p className="text-sm text-ink/50">Loading…</p>;

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
    <div className="rounded-2xl border border-ink/10 bg-white/60 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">{def.label}</span>
          <span className="rounded bg-ink/5 px-2 py-0.5 text-[10px] font-semibold uppercase text-ink/40">
            {def.runtime}
          </span>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-[11px] text-ink/40">
        {def.command} {def.args.join(" ")}
      </p>
      {status?.error && status.error !== "credentials_missing" && (
        <p className="mt-2 text-xs italic text-ember">{status.error}</p>
      )}
      <div className="mt-3">
        <button
          className="rounded-lg border border-tide px-3 py-1.5 text-xs font-semibold text-tide hover:bg-tide/5"
          onClick={handleRestart}
        >
          Restart
        </button>
      </div>
    </div>
  );
};

const getLocalBadge = (status: LocalServerStatus | null) => {
  if (status?.running) return { className: "bg-moss/15 text-moss", label: `Running (${status.toolCount} tools)` };
  if (status?.error === "credentials_missing") return { className: "bg-amber-500/15 text-amber-600", label: "No Credentials" };
  if (status?.error === "runtime_unavailable") return { className: "bg-ink/10 text-ink/50", label: "Runtime Missing" };
  if (status?.error === "process_crashed") return { className: "bg-ember/15 text-ember", label: "Crashed" };
  if (status && !status.running) return { className: "bg-ink/10 text-ink/50", label: "Stopped" };
  return { className: "bg-ink/5 text-ink/40", label: "Unknown" };
};
