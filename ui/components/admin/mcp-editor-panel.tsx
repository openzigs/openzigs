"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { NativeMcpServerDefinition } from "@/lib/types";
import { showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { McpWizard } from "@/components/admin/mcp-wizard";
import { AlertTriangle, ChevronRight, Edit, Plug, Plus, RefreshCw, Server, Trash2 } from "lucide-react";

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
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-server-tools"] });
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      showToast("Server added — discovering tools…", "success");
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
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-server-tools"] });
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      showToast("Server updated — rediscovering tools…", "success");
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
    onSuccess: (_data, name) => {
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-tool-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["native-mcp-server-tools", name] });
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      showToast("Tools refreshed", "success");
    },
    onError: (err) => showToast(`Tool refresh failed: ${err.message}`, "error"),
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
              <NativeMcpServerCard
                key={name}
                name={name}
                def={def}
                state={state}
                disconnected={disconnected}
                isLocked={isLocked}
                onEdit={() => {
                  setEditingName(name);
                  setEditingDef(def);
                  setWizardOpen(true);
                }}
                onDelete={() => setPendingDelete(name)}
                onReconnect={() => reconnectMutation.mutate(name)}
              />
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

/* ── Expandable Server Card ── */

type NativeMcpServerCardProps = {
  name: string;
  def: NativeMcpServerDefinition;
  state?: ToolCache[string];
  disconnected: boolean;
  isLocked: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReconnect: () => void;
};

const NativeMcpServerCard = ({
  name,
  def,
  state,
  disconnected,
  isLocked,
  onEdit,
  onDelete,
  onReconnect,
}: NativeMcpServerCardProps) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`rounded-2xl border transition ${expanded ? "border-primary/30" : "border-border"} bg-card`}>
      {/* Header — click to expand */}
      <div
        className="flex cursor-pointer items-center justify-between px-4 py-3"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <Server className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">{name}</span>
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
          {def.type}
        </span>
      </div>

      {/* Expandable body */}
      {expanded && (
        <div className="space-y-3 border-t border-border px-4 py-3">
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {"command" in def ? `${def.command} ${(def.args ?? []).join(" ")}` : def.url}
          </p>

          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Plug className="h-3.5 w-3.5" />
            <span>{state?.tools?.length ?? 0} discovered tool(s)</span>
          </div>

          {disconnected && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                Disconnected — configure tools now, they activate when connected
              </div>
              {state?.error && <p className="mt-1 truncate">{state.error}</p>}
            </div>
          )}

          {/* Per-tool toggles */}
          <NativeMcpServerTools serverName={name} />

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              disabled={isLocked}
              title={isLocked ? "Cannot edit while tasks are running" : undefined}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:border-primary/30 disabled:opacity-40"
            >
              <Edit className="h-3 w-3" /> Edit
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              disabled={isLocked}
              title={isLocked ? "Cannot delete while tasks are running" : undefined}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-destructive hover:border-destructive/30 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" /> Remove
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onReconnect(); }}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-foreground hover:border-primary/30"
            >
              <RefreshCw className="h-3 w-3" /> Refresh Tools
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ── Per-tool toggles inside a native MCP server ── */

type NativeMcpTool = {
  name: string;
  description: string;
  enabled: boolean;
};

const NativeMcpServerTools = ({ serverName }: { serverName: string }) => {
  const queryClient = useQueryClient();
  const [addingTool, setAddingTool] = useState(false);
  const [newToolName, setNewToolName] = useState("");

  const toolsQuery = useQuery({
    queryKey: ["native-mcp-server-tools", serverName],
    queryFn: () =>
      fetchJson<{ server: string; tools: NativeMcpTool[]; connected: boolean }>(
        `/api/admin/native-mcp-servers/${encodeURIComponent(serverName)}/tools`
      ),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ toolName, enabled }: { toolName: string; enabled: boolean }) =>
      fetchJson(
        `/api/admin/native-mcp-servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}/toggle`,
        { method: "POST", body: JSON.stringify({ enabled }) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["native-mcp-server-tools", serverName] });
      queryClient.invalidateQueries({ queryKey: ["native-mcp-servers"] });
    },
  });

  const addToolMutation = useMutation({
    mutationFn: (toolName: string) =>
      fetchJson(
        `/api/admin/native-mcp-servers/${encodeURIComponent(serverName)}/tools/add`,
        { method: "POST", body: JSON.stringify({ toolName }) }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["native-mcp-server-tools", serverName] });
      queryClient.invalidateQueries({ queryKey: ["native-mcp-servers"] });
      setNewToolName("");
      setAddingTool(false);
    },
    onError: (err) => showToast(`Failed to add tool: ${err.message}`, "error"),
  });

  const removeToolMutation = useMutation({
    mutationFn: (toolName: string) =>
      fetchJson(
        `/api/admin/native-mcp-servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}/remove`,
        { method: "POST" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["native-mcp-server-tools", serverName] });
      queryClient.invalidateQueries({ queryKey: ["native-mcp-servers"] });
    },
  });

  const tools = toolsQuery.data?.tools ?? [];
  const connected = toolsQuery.data?.connected ?? false;

  if (toolsQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading tools…</p>;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Tools {!connected && tools.length > 0 && <span className="normal-case font-normal">(pre-configured)</span>}
        </p>
        {!addingTool && (
          <button
            onClick={(e) => { e.stopPropagation(); setAddingTool(true); }}
            className="text-[10px] font-semibold text-primary hover:underline"
          >
            + Add Tool
          </button>
        )}
      </div>

      {addingTool && (
        <div className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-card px-2 py-1">
          <input
            autoFocus
            value={newToolName}
            onChange={(e) => setNewToolName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newToolName.trim()) addToolMutation.mutate(newToolName.trim());
              if (e.key === "Escape") { setAddingTool(false); setNewToolName(""); }
            }}
            placeholder="tool-name"
            className="flex-1 bg-transparent font-mono text-xs text-foreground placeholder:text-muted-foreground outline-none"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (newToolName.trim()) addToolMutation.mutate(newToolName.trim());
            }}
            disabled={!newToolName.trim()}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-40"
          >
            Add
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setAddingTool(false); setNewToolName(""); }}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      )}

      {tools.length === 0 && !addingTool && (
        <p className="text-[11px] text-muted-foreground">
          No tools discovered yet. Click &quot;Refresh Tools&quot; to connect, or &quot;+ Add Tool&quot; to pre-configure known tools.
        </p>
      )}

      {tools.map((tool) => (
        <div
          key={tool.name}
          className="group flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5"
        >
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-semibold text-foreground">{tool.name}</p>
            {tool.description && (
              <p className="truncate text-[11px] text-muted-foreground">{tool.description}</p>
            )}
          </div>
          <button
            className="hidden rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-destructive group-hover:inline-block"
            title="Remove tool"
            onClick={(e) => {
              e.stopPropagation();
              removeToolMutation.mutate(tool.name);
            }}
          >
            ✕
          </button>
          <button
            className={`w-12 rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${
              tool.enabled ? "bg-moss text-white" : "bg-muted text-ink/60"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              toggleMutation.mutate({ toolName: tool.name, enabled: !tool.enabled });
            }}
          >
            {tool.enabled ? "On" : "Off"}
          </button>
        </div>
      ))}
    </div>
  );
};
