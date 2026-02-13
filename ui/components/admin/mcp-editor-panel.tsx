"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { NativeMcpServerDefinition } from "@/lib/types";
import { showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { McpWizard } from "@/components/admin/mcp-wizard";
import { AlertTriangle, Edit, Plug, Plus, RefreshCw, Server, Trash2 } from "lucide-react";

type ServersRecord = Record<string, NativeMcpServerDefinition>;
type ToolCache = Record<string, {
  tools: Array<{ name: string; description: string }>;
  connected: boolean;
  error?: string;
  updatedAt: string;
}>;

export const McpEditorPanel = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["native-mcp-servers"],
    queryFn: () => fetchJson<{ servers: ServersRecord }>("/api/admin/native-mcp-servers"),
  });

  const cacheQuery = useQuery({
    queryKey: ["native-mcp-tool-cache"],
    queryFn: () => fetchJson<{ cache: ToolCache }>("/api/admin/native-mcp-servers/tool-cache"),
    refetchInterval: 5_000,
  });

  const busyQuery = useQuery({
    queryKey: ["admin-task-stats"],
    queryFn: () => fetchJson<{ queued: number; running: number; activeCount: number }>("/api/admin/tasks/stats"),
    refetchInterval: 5_000,
  });

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingDef, setEditingDef] = useState<NativeMcpServerDefinition | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const servers = query.data?.servers ?? {};
  const entries = Object.entries(servers);
  const cache = cacheQuery.data?.cache ?? {};

  const running = busyQuery.data?.running ?? 0;
  const queued = busyQuery.data?.queued ?? 0;
  const activeCount = running + queued;
  const isLocked = activeCount > 0;

  const createMutation = useMutation({
    mutationFn: ({ name, def }: { name: string; def: NativeMcpServerDefinition }) =>
      fetchJson(`/api/admin/native-mcp-servers/${encodeURIComponent(name)}`, {
        method: "POST",
        body: JSON.stringify(def),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-servers"] });
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-tool-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      showToast("Server added", "success");
      setWizardOpen(false);
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, def }: { name: string; def: NativeMcpServerDefinition }) =>
      fetchJson(`/api/admin/native-mcp-servers/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(def),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-servers"] });
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-tool-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      showToast("Server updated", "success");
      setWizardOpen(false);
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      fetchJson(`/api/admin/native-mcp-servers/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-servers"] });
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-tool-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      showToast("Server removed", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const reconnectMutation = useMutation({
    mutationFn: (name: string) =>
      fetchJson(`/api/admin/native-mcp-servers/${encodeURIComponent(name)}/reconnect`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-tool-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      showToast("Reconnect test complete", "success");
    },
    onError: (err) => showToast(`Reconnect failed: ${err.message}`, "error"),
  });

  const handleWizardSave = (name: string, def: NativeMcpServerDefinition) => {
    if (editingName) {
      updateMutation.mutate({ name, def });
    } else {
      createMutation.mutate({ name, def });
    }
  };

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading MCP servers…</p>;
  }

  return (
    <div className="space-y-4">
      {isLocked && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-500">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">⚠️ System is busy executing {activeCount} task(s). MCP configuration is locked to prevent disruption.</p>
              <p className="mt-1 text-xs">Running: {running} | Queued: {queued}</p>
            </div>
            <a href="/tasks" className="text-xs font-semibold underline">View Tasks →</a>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{entries.length} server{entries.length !== 1 ? "s" : ""} configured</p>
        <button
          onClick={() => {
            setEditingName(null);
            setEditingDef(null);
            setWizardOpen(true);
          }}
          disabled={isLocked}
          title={isLocked ? "Cannot add servers while tasks are running" : undefined}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Server
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No native MCP servers configured.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {entries.map(([name, def]) => {
            const state = cache[name];
            const disconnected = state?.connected === false;
            return (
              <div key={name} className="rounded-2xl border border-border bg-card p-4">
                <div className="mb-2 flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold text-foreground">{name}</span>
                  </div>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">{def.type}</span>
                </div>

                <p className="mb-2 break-all font-mono text-[11px] text-muted-foreground">
                  {"command" in def ? `${def.command} ${(def.args ?? []).join(" ")}` : def.url}
                </p>

                <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Plug className="h-3.5 w-3.5" />
                  <span>{state?.tools?.length ?? 0} discovered tool(s)</span>
                </div>

                {disconnected && (
                  <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">
                    <div className="flex items-center gap-1">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Disconnected — tools unavailable
                    </div>
                    {state?.error && <p className="mt-1 truncate">{state.error}</p>}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      setEditingName(name);
                      setEditingDef(def);
                      setWizardOpen(true);
                    }}
                    disabled={isLocked}
                    title={isLocked ? "Cannot edit while tasks are running" : undefined}
                    className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:border-primary/30 disabled:opacity-40"
                  >
                    <Edit className="h-3 w-3" /> Edit
                  </button>
                  <button
                    onClick={() => setPendingDelete(name)}
                    disabled={isLocked}
                    title={isLocked ? "Cannot delete while tasks are running" : undefined}
                    className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-destructive hover:border-destructive/30 disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </button>
                  {disconnected && (
                    <button
                      onClick={() => reconnectMutation.mutate(name)}
                      className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-foreground hover:border-primary/30"
                    >
                      <RefreshCw className="h-3 w-3" /> Reconnect
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {wizardOpen && (
        <McpWizard
          initialName={editingName}
          initialDef={editingDef}
          existingNames={Object.keys(servers)}
          locked={isLocked}
          onSave={handleWizardSave}
          onClose={() => setWizardOpen(false)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Remove MCP Server"
          message={`Remove the "${pendingDelete}" MCP server? This will disconnect all its tools from the agent.`}
          confirmLabel="Remove"
          variant="danger"
          onConfirm={() => {
            deleteMutation.mutate(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
};
