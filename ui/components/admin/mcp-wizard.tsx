"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { NativeMcpServerDefinition } from "@/lib/types";
import { showToast } from "@/components/toast";
import { CheckCircle2, Globe, Terminal, XCircle, Plus, X } from "lucide-react";

type WizardProps = {
  initialName: string | null;
  initialDef: NativeMcpServerDefinition | null;
  existingNames: string[];
  locked: boolean;
  onSave: (name: string, def: NativeMcpServerDefinition) => void;
  onClose: () => void;
};

type TestResult = {
  ok: boolean;
  serverName: string;
  tools?: Array<{ name: string; description: string }>;
  connectionTimeMs?: number;
  error?: string;
};

type ServerType = "local" | "http" | "sse";

const KeyValueEditor = ({
  label,
  values,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  values: [string, string][];
  onChange: (next: [string, string][]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        <button
          type="button"
          onClick={() => onChange([...values, ["", ""]])}
          className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>

      {values.map(([key, value], idx) => (
        <div key={idx} className="flex items-center gap-1">
          <input
            type="text"
            className="w-1/3 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
            placeholder={keyPlaceholder}
            value={key}
            onChange={(e) => {
              const next = [...values];
              next[idx] = [e.target.value, value];
              onChange(next);
            }}
          />
          <input
            type="text"
            className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
            placeholder={valuePlaceholder}
            value={value}
            onChange={(e) => {
              const next = [...values];
              next[idx] = [key, e.target.value];
              onChange(next);
            }}
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, i) => i !== idx))}
            className="rounded border border-border p-1 text-destructive hover:border-destructive"
            aria-label="Remove"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
};

const ListEditor = ({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        <button
          type="button"
          onClick={() => onChange([...values, ""])}
          className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>

      {values.map((value, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <input
            type="text"
            className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              const next = [...values];
              next[idx] = e.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, i) => i !== idx))}
            className="rounded border border-border p-1 text-destructive hover:border-destructive"
            aria-label="Remove"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
};

export const McpWizard = ({
  initialName,
  initialDef,
  existingNames,
  locked,
  onSave,
  onClose,
}: WizardProps) => {
  const isEdit = !!initialName;
  const initialType: ServerType = initialDef?.type === "sse" || initialDef?.type === "http" ? initialDef.type : "local";

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [serverName, setServerName] = useState(initialName ?? "");
  const [type, setType] = useState<ServerType>(initialType);
  const [command, setCommand] = useState("command" in (initialDef ?? {}) ? (initialDef as { command: string }).command : "");
  const [args, setArgs] = useState<string[]>("args" in (initialDef ?? {}) ? ((initialDef as { args?: string[] }).args ?? []) : []);
  const [env, setEnv] = useState<[string, string][]>(initialDef && "env" in initialDef && initialDef.env ? Object.entries(initialDef.env) : []);
  const [cwd, setCwd] = useState("cwd" in (initialDef ?? {}) ? ((initialDef as { cwd?: string }).cwd ?? "") : "");
  const [url, setUrl] = useState("url" in (initialDef ?? {}) ? (initialDef as { url: string }).url : "");
  const [headers, setHeaders] = useState<[string, string][]>(initialDef && "headers" in initialDef && initialDef.headers ? Object.entries(initialDef.headers) : []);
  const [timeout, setTimeoutMs] = useState(String(initialDef?.timeout ?? (initialType === "local" ? 30_000 : 60_000)));
  const [skipTest, setSkipTest] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const builtServer = useMemo<NativeMcpServerDefinition>(() => {
    const timeoutNumber = Number.parseInt(timeout, 10);
    const hasTimeout = Number.isFinite(timeoutNumber) && timeoutNumber > 0;

    if (type === "local") {
      const parsedEnv = Object.fromEntries(env.filter(([k, v]) => k.trim() && v.trim()));
      const parsedArgs = args.map((value) => value.trim()).filter(Boolean);
      return {
        type: "local",
        command: command.trim(),
        ...(parsedArgs.length > 0 ? { args: parsedArgs } : {}),
        ...(Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(hasTimeout ? { timeout: timeoutNumber } : {}),
      };
    }

    const parsedHeaders = Object.fromEntries(headers.filter(([k, v]) => k.trim() && v.trim()));
    return {
      type,
      url: url.trim(),
      ...(Object.keys(parsedHeaders).length > 0 ? { headers: parsedHeaders } : {}),
      ...(hasTimeout ? { timeout: timeoutNumber } : {}),
    };
  }, [args, command, cwd, env, headers, timeout, type, url]);

  const validateStep = (targetStep: 1 | 2 | 3): boolean => {
    if (targetStep === 1) return true;

    if (!serverName.trim()) {
      setValidationError("Server name is required.");
      return false;
    }
    if (!isEdit && existingNames.includes(serverName.trim())) {
      setValidationError("A server with that name already exists.");
      return false;
    }

    if (targetStep === 2) return true;

    if (type === "local" && !command.trim()) {
      setValidationError("Command is required for local stdio servers.");
      return false;
    }
    if ((type === "http" || type === "sse") && !url.trim()) {
      setValidationError("URL is required for HTTP/SSE servers.");
      return false;
    }

    setValidationError(null);
    return true;
  };

  const testMutation = useMutation({
    mutationFn: () =>
      fetchJson<TestResult>("/api/admin/native-mcp-servers/test", {
        method: "POST",
        body: JSON.stringify({
          serverName: serverName.trim(),
          server: builtServer,
        }),
      }),
    onSuccess: (result) => {
      setTestResult(result);
      if (result.ok) {
        showToast(`Connected in ${result.connectionTimeMs ?? 0}ms`, "success");
      } else {
        showToast(result.error ?? "Connection test failed", "error");
      }
    },
    onError: (error) => {
      setTestResult({ ok: false, serverName: serverName.trim(), error: error.message });
      showToast(error.message, "error");
    },
  });

  const canSave = !locked && (skipTest || !!testResult?.ok);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={isEdit ? "Edit Native MCP Server" : "Add Native MCP Server"}
      >
        <button onClick={onClose} className="absolute right-4 top-4 text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-semibold text-foreground">{isEdit ? "Edit Native MCP Server" : "Add Native MCP Server"}</h3>
        <p className="mt-1 text-xs text-muted-foreground">Step {step} of 3</p>

        {validationError && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {validationError}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              className={`rounded-full px-3 py-1 text-[11px] font-semibold ${step === n ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
              onClick={() => {
                const target = n as 1 | 2 | 3;
                if (validateStep(target)) setStep(target);
              }}
            >
              Step {n}
            </button>
          ))}
        </div>

        <div className="mt-5 space-y-4">
          {step === 1 && (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Server Name</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground disabled:opacity-40"
                  value={serverName}
                  disabled={isEdit}
                  placeholder="my-database"
                  onChange={(e) => setServerName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                />
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${type === "local" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                  onClick={() => setType("local")}
                >
                  <Terminal className="mr-1 inline h-3.5 w-3.5" />
                  Stdio (Local)
                </button>
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${type === "http" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                  onClick={() => setType("http")}
                >
                  <Globe className="mr-1 inline h-3.5 w-3.5" />
                  HTTP
                </button>
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${type === "sse" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                  onClick={() => setType("sse")}
                >
                  <Globe className="mr-1 inline h-3.5 w-3.5" />
                  SSE
                </button>
              </div>

              <p className="text-xs text-muted-foreground">
                {type === "local"
                  ? "Run an MCP server via local stdio command."
                  : "Connect to a remote MCP server over HTTP or SSE."}
              </p>
            </>
          )}

          {step === 2 && (
            <>
              {type === "local" ? (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Command</label>
                    <input
                      type="text"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                      placeholder="npx"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                    />
                  </div>
                  <ListEditor label="Arguments" values={args} onChange={setArgs} placeholder="@modelcontextprotocol/server-..." />
                  <KeyValueEditor
                    label="Environment Variables"
                    values={env}
                    onChange={setEnv}
                    keyPlaceholder="KEY"
                    valuePlaceholder="VALUE"
                  />
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Working Directory (optional)</label>
                    <input
                      type="text"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                      placeholder="./servers"
                      value={cwd}
                      onChange={(e) => setCwd(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">URL</label>
                    <input
                      type="url"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                      placeholder={type === "sse" ? "https://my-mcp.example.com/sse" : "https://my-mcp.example.com/mcp"}
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </div>
                  <KeyValueEditor
                    label="Headers"
                    values={headers}
                    onChange={setHeaders}
                    keyPlaceholder="Header"
                    valuePlaceholder="Value"
                  />
                </>
              )}

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Timeout (ms)</label>
                <input
                  type="number"
                  className="w-48 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                  value={timeout}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                Test this connection before saving. You can still proceed with Skip Test.
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:border-primary/30 disabled:opacity-40"
                  disabled={testMutation.isPending || locked}
                  onClick={() => testMutation.mutate()}
                >
                  {testMutation.isPending ? "Testing…" : "Test Connection"}
                </button>

                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={skipTest} onChange={(e) => setSkipTest(e.target.checked)} />
                  Skip Test
                </label>
              </div>

              {testResult && (
                <div className={`rounded-lg border px-3 py-2 text-xs ${testResult.ok ? "border-moss/30 bg-moss/10 text-moss" : "border-ember/30 bg-ember/10 text-ember"}`}>
                  <div className="flex items-center gap-1.5 font-semibold">
                    {testResult.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                    {testResult.ok ? "Connected" : "Connection failed"}
                  </div>
                  {testResult.ok ? (
                    <>
                      <p className="mt-1">Found {testResult.tools?.length ?? 0} tool(s).</p>
                      {!!testResult.tools?.length && (
                        <ul className="mt-2 list-disc pl-4">
                          {testResult.tools.map((tool) => (
                            <li key={tool.name} className="font-mono">{tool.name}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="mt-1">{testResult.error}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>

          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
              className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-foreground hover:bg-muted"
            >
              Back
            </button>
          )}

          {step < 3 ? (
            <button
              type="button"
              onClick={() => {
                const next = (step + 1) as 1 | 2 | 3;
                if (validateStep(next)) setStep(next);
              }}
              className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-primary/90"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSave}
              title={locked ? "Cannot save while tasks are running" : (!canSave ? "Run test or choose Skip Test" : undefined)}
              onClick={() => {
                if (!canSave) return;
                onSave(serverName.trim(), builtServer);
              }}
              className="rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white hover:bg-moss/90 disabled:opacity-40"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
