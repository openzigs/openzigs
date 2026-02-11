"use client";

import { useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { NativeMcpServerDefinition, NativeMcpServerType } from "@/lib/types";
import { showToast } from "@/components/toast";
import { Plus, Edit, Trash2, Server, Globe, Radio, X, Eye, EyeOff } from "lucide-react";

type ServersRecord = Record<string, NativeMcpServerDefinition>;

const SERVER_TYPES: { value: NativeMcpServerType; label: string; icon: typeof Server }[] = [
  { value: "local", label: "Local (stdio)", icon: Server },
  { value: "http", label: "HTTP", icon: Globe },
  { value: "sse", label: "SSE", icon: Radio },
];

const TYPE_BADGE_COLORS: Record<string, string> = {
  local: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  stdio: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  http: "bg-moss/15 text-moss dark:text-green-400",
  sse: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
};

export const McpEditorPanel = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["native-mcp-servers"],
    queryFn: () => fetchJson<{ servers: ServersRecord }>("/api/admin/native-mcp-servers"),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingDef, setEditingDef] = useState<NativeMcpServerDefinition | null>(null);

  const servers = query.data?.servers ?? {};
  const entries = Object.entries(servers);

  const saveMutation = useMutation({
    mutationFn: (payload: ServersRecord) =>
      fetchJson("/api/admin/native-mcp-servers", {
        method: "PUT",
        body: JSON.stringify({ servers: payload }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["native-mcp-servers"] });
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleDelete = (name: string) => {
    if (!confirm(`Remove the "${name}" MCP server? This will disconnect all its tools from the agent.`)) return;
    const updated = { ...servers };
    delete updated[name];
    saveMutation.mutate(updated);
    showToast(`Server "${name}" removed`, "success");
  };

  const handleEdit = (name: string, def: NativeMcpServerDefinition) => {
    setEditingName(name);
    setEditingDef(def);
    setDialogOpen(true);
  };

  const handleCreate = () => {
    setEditingName(null);
    setEditingDef(null);
    setDialogOpen(true);
  };

  const handleDialogSave = (name: string, def: NativeMcpServerDefinition) => {
    const updated = { ...servers };
    // If editing and name changed, remove old entry
    if (editingName && editingName !== name) {
      delete updated[editingName];
    }
    updated[name] = def;
    saveMutation.mutate(updated);
    showToast(editingName ? "Server updated" : "Server added", "success");
    setDialogOpen(false);
  };

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading MCP servers…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{entries.length} server{entries.length !== 1 ? "s" : ""} configured</p>
        <button
          onClick={handleCreate}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Server
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No native MCP servers configured. Click &ldquo;Add Server&rdquo; to define one.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {entries.map(([name, def]) => (
            <McpServerCard
              key={name}
              name={name}
              def={def}
              onEdit={() => handleEdit(name, def)}
              onDelete={() => handleDelete(name)}
            />
          ))}
        </div>
      )}

      {dialogOpen && (
        <McpServerEditorDialog
          name={editingName}
          def={editingDef}
          existingNames={Object.keys(servers)}
          onSave={handleDialogSave}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
};

/* ── Server Card ── */

const McpServerCard = ({
  name,
  def,
  onEdit,
  onDelete,
}: {
  name: string;
  def: NativeMcpServerDefinition;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const badgeColor = TYPE_BADGE_COLORS[def.type] ?? "bg-muted text-muted-foreground";

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">{name}</span>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${badgeColor}`}>
          {def.type}
        </span>
      </div>
      <p className="mb-2 break-all font-mono text-[11px] text-muted-foreground">
        {"command" in def ? `${def.command} ${(def.args ?? []).join(" ")}` : ("url" in def ? def.url : "")}
      </p>
      {"env" in def && def.env && Object.keys(def.env).length > 0 && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Env: {Object.keys(def.env).join(", ")}
        </p>
      )}
      {def.timeout && (
        <p className="mb-2 text-[11px] text-muted-foreground">Timeout: {def.timeout}ms</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={onEdit}
          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:border-primary/30"
        >
          <Edit className="h-3 w-3" />
          Edit
        </button>
        <button
          onClick={onDelete}
          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-destructive hover:border-destructive/30"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      </div>
    </div>
  );
};

/* ── Env Var Editor ── */

const SENSITIVE_KEYS = /key|secret|token|password|credential/i;

const EnvVarEditor = ({
  entries,
  onChange,
}: {
  entries: [string, string][];
  onChange: (entries: [string, string][]) => void;
}) => {
  const [showValues, setShowValues] = useState<Record<number, boolean>>({});

  const add = () => onChange([...entries, ["", ""]]);
  const remove = (idx: number) => onChange(entries.filter((_, i) => i !== idx));
  const update = (idx: number, field: 0 | 1, value: string) => {
    const next = [...entries];
    next[idx] = [...next[idx]] as [string, string];
    next[idx][field] = value;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Environment Variables</label>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
      {entries.map(([key, value], idx) => {
        const sensitive = SENSITIVE_KEYS.test(key);
        return (
          <div key={idx} className="flex items-center gap-1">
            <input
              type="text"
              className="w-1/3 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
              placeholder="KEY"
              value={key}
              onChange={(e) => update(idx, 0, e.target.value)}
            />
            <div className="flex flex-1 items-center gap-1">
              <input
                type={sensitive && !showValues[idx] ? "password" : "text"}
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
                placeholder="Value"
                value={value}
                onChange={(e) => update(idx, 1, e.target.value)}
                autoComplete="off"
              />
              {sensitive && (
                <button
                  type="button"
                  onClick={() => setShowValues((prev) => ({ ...prev, [idx]: !prev[idx] }))}
                  className="rounded border border-border p-1 text-muted-foreground hover:border-primary"
                  aria-label={showValues[idx] ? "Hide value" : "Show value"}
                >
                  {showValues[idx] ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => remove(idx)}
              className="rounded border border-border p-1 text-destructive hover:border-destructive"
              aria-label="Remove variable"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

/* ── String List Editor ── */

const StringListEditor = ({
  label,
  items,
  onChange,
  placeholder = "Value",
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
}) => {
  const add = () => onChange([...items, ""]);
  const remove = (idx: number) => onChange(items.filter((_, i) => i !== idx));
  const update = (idx: number, value: string) => {
    const next = [...items];
    next[idx] = value;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <input
            type="text"
            className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
            placeholder={placeholder}
            value={item}
            onChange={(e) => update(idx, e.target.value)}
          />
          <button
            type="button"
            onClick={() => remove(idx)}
            className="rounded border border-border p-1 text-destructive hover:border-destructive"
            aria-label="Remove item"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
};

/* ── Server Editor Dialog ── */

const McpServerEditorDialog = ({
  name: initialName,
  def,
  existingNames,
  onSave,
  onClose,
}: {
  name: string | null;
  def: NativeMcpServerDefinition | null;
  existingNames: string[];
  onSave: (name: string, def: NativeMcpServerDefinition) => void;
  onClose: () => void;
}) => {
  const isEdit = !!initialName;
  const initialType: NativeMcpServerType = def?.type ?? "local";

  const [serverName, setServerName] = useState(initialName ?? "");
  const [serverType, setServerType] = useState<NativeMcpServerType>(initialType === "stdio" ? "local" : initialType);
  const [command, setCommand] = useState("command" in (def ?? {}) ? (def as { command: string }).command : "");
  const [argEntries, setArgEntries] = useState<string[]>(
    "args" in (def ?? {}) ? ((def as { args?: string[] }).args ?? []) : []
  );
  const [cwd, setCwd] = useState("cwd" in (def ?? {}) ? ((def as { cwd?: string }).cwd ?? "") : "");
  const [url, setUrl] = useState("url" in (def ?? {}) ? (def as { url: string }).url : "");
  const [envEntries, setEnvEntries] = useState<[string, string][]>(
    def && "env" in def && def.env ? Object.entries(def.env) : []
  );
  const [headerEntries, setHeaderEntries] = useState<[string, string][]>(
    def && "headers" in def && def.headers ? Object.entries(def.headers) : []
  );
  const [timeout, setTimeout_] = useState(def?.timeout?.toString() ?? "30000");
  const [errors, setErrors] = useState<string[]>([]);

  const validate = useCallback((): string[] => {
    const errs: string[] = [];
    if (!serverName.trim()) errs.push("Server name is required");
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(serverName)) errs.push("Name must be lowercase alphanumeric with hyphens");
    else if (!isEdit && existingNames.includes(serverName)) errs.push("A server with this name already exists");

    if (serverType === "local") {
      if (!command.trim()) errs.push("Command is required");
    } else {
      if (!url.trim()) errs.push("URL is required");
    }
    if (timeout && isNaN(Number(timeout))) errs.push("Timeout must be a number");
    return errs;
  }, [serverName, serverType, command, url, timeout, isEdit, existingNames]);

  const handleSave = () => {
    const errs = validate();
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);

    const timeoutMs = timeout ? Number(timeout) : undefined;
    let definition: NativeMcpServerDefinition;

    if (serverType === "local") {
      const env = envEntries.length > 0
        ? Object.fromEntries(envEntries.filter(([k, v]) => k.trim() && v.trim()))
        : undefined;
      const parsedArgs = argEntries.map(a => a.trim()).filter(Boolean);
      definition = {
        type: "local",
        command: command.trim(),
        ...(parsedArgs.length > 0 && { args: parsedArgs }),
        ...(env && Object.keys(env).length > 0 && { env }),
        ...(cwd.trim() && { cwd: cwd.trim() }),
        ...(timeoutMs && { timeout: timeoutMs }),
      };
    } else {
      const headers = headerEntries.length > 0
        ? Object.fromEntries(headerEntries.filter(([k, v]) => k.trim() && v.trim()))
        : undefined;
      definition = {
        type: serverType as "http" | "sse",
        url: url.trim(),
        ...(headers && Object.keys(headers).length > 0 && { headers }),
        ...(timeoutMs && { timeout: timeoutMs }),
      };
    }

    onSave(serverName.trim(), definition);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={isEdit ? "Edit MCP Server" : "Add MCP Server"}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        <h3 className="mb-4 text-lg font-semibold text-foreground">
          {isEdit ? "Edit MCP Server" : "Add MCP Server"}
        </h3>

        {errors.length > 0 && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            {errors.map((e, i) => (
              <p key={i} className="text-xs text-destructive">{e}</p>
            ))}
          </div>
        )}

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Server Name</label>
            <input
              type="text"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground disabled:opacity-40"
              placeholder="my-custom-server"
              value={serverName}
              onChange={(e) => setServerName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              disabled={isEdit}
            />
          </div>

          {/* Type */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <div className="flex gap-2" role="radiogroup" aria-label="Server Type">
              {SERVER_TYPES.map((st) => (
                <button
                  key={st.value}
                  role="radio"
                  aria-checked={serverType === st.value}
                  onClick={() => setServerType(st.value)}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                    serverType === st.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:border-primary/30"
                  }`}
                >
                  <st.icon className="h-3.5 w-3.5" />
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          {/* Type-specific fields */}
          {serverType === "local" ? (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Command</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                  placeholder="node"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <StringListEditor
                label="Arguments"
                items={argEntries}
                onChange={setArgEntries}
                placeholder="--flag or value"
              />
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Working Directory</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                  placeholder="./servers/my-server"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
              </div>
              <EnvVarEditor entries={envEntries} onChange={setEnvEntries} />
            </>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">URL</label>
                <input
                  type="url"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                  placeholder={serverType === "sse" ? "http://localhost:3100/sse" : "https://api.example.com/mcp"}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Headers</label>
                  <button
                    type="button"
                    onClick={() => setHeaderEntries([...headerEntries, ["", ""]])}
                    className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                  >
                    <Plus className="h-3 w-3" />
                    Add
                  </button>
                </div>
                {headerEntries.map(([key, value], idx) => (
                  <div key={idx} className="flex items-center gap-1">
                    <input
                      type="text"
                      className="w-1/3 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
                      placeholder="Header"
                      value={key}
                      onChange={(e) => {
                        const next = [...headerEntries];
                        next[idx] = [e.target.value, next[idx][1]];
                        setHeaderEntries(next);
                      }}
                    />
                    <input
                      type="text"
                      className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
                      placeholder="Value"
                      value={value}
                      onChange={(e) => {
                        const next = [...headerEntries];
                        next[idx] = [next[idx][0], e.target.value];
                        setHeaderEntries(next);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setHeaderEntries(headerEntries.filter((_, i) => i !== idx))}
                      className="rounded border border-border p-1 text-destructive hover:border-destructive"
                      aria-label="Remove header"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Timeout */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Timeout (ms)</label>
            <input
              type="text"
              className="w-48 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
              placeholder="30000"
              value={timeout}
              onChange={(e) => setTimeout_(e.target.value)}
            />
          </div>
        </div>

        {/* Dialog Actions */}
        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {isEdit ? "Save Server" : "Add Server"}
          </button>
        </div>
      </div>
    </div>
  );
};
