"use client";

/**
 * OllamaNodePanel — admin UI for the remote-Ollama feature (#1077-B).
 *
 * Mirrors `image-gen-panel.tsx` (FluxQ Network Node). Lets the user point
 * the local-LLM provider at either:
 *   - the local Ollama socket (default `http://127.0.0.1:11434`), or
 *   - a peer Ollama instance on the LAN (e.g. a beefier Mac running
 *     `gemma4:31b` INT4 — needs ≥36 GB unified memory).
 *
 * Backend endpoints:
 *   GET  /api/admin/local-llm/ollama/config           — masked config
 *   PUT  /api/admin/local-llm/ollama/config           — save (SSRF guarded)
 *   POST /api/admin/local-llm/ollama/test-connection  — probe + model list
 *
 * Env overrides (read by `getOllamaBaseUrl()` / `resolveOllamaTarget()`):
 *   OLLAMA_MODE, OLLAMA_NETWORK_URL, OLLAMA_NETWORK_TOKEN
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Eye, EyeOff, Loader2, Wifi, WifiOff } from "lucide-react";

type OllamaConfig = {
  mode: "local" | "network";
  localUrl: string;
  networkNodeUrl: string;
  networkNodeToken: string;
  hasToken: boolean;
};

type TestResult = {
  ok: boolean;
  status?: number | string;
  version?: string;
  models?: string[];
  modelCount?: number;
  error?: string;
};

type PlatformResponse = {
  platform?: { gpuKind?: string };
};

export const OllamaNodePanel = () => {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["ollama-node-config"],
    queryFn: () =>
      fetchJson<OllamaConfig>("/api/admin/local-llm/ollama/config"),
  });

  // Used for the Apple Silicon tip banner. Cheap, cached.
  const platformQuery = useQuery({
    queryKey: ["system", "platform"],
    queryFn: () => fetchJson<PlatformResponse>("/api/system/platform"),
    staleTime: 5 * 60_000,
  });
  const isAppleSilicon =
    platformQuery.data?.platform?.gpuKind === "apple-silicon";

  const [mode, setMode] = useState<"local" | "network">("local");
  const [localUrl, setLocalUrl] = useState("http://127.0.0.1:11434");
  const [nodeUrl, setNodeUrl] = useState("");
  const [nodeToken, setNodeToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // Hydrate form once config arrives.
  if (configQuery.data && !initialized) {
    setMode(configQuery.data.mode);
    setLocalUrl(configQuery.data.localUrl || "http://127.0.0.1:11434");
    setNodeUrl(configQuery.data.networkNodeUrl);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      fetchJson("/api/admin/local-llm/ollama/config", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ollama-node-config"] });
      showToast("Ollama node settings saved", "success");
    },
    onError: (err) =>
      showToast(`Save failed: ${(err as Error).message}`, "error"),
  });

  const handleSave = () => {
    const body: Record<string, string> = { mode };
    if (mode === "local") {
      body.localUrl = localUrl.trim() || "http://127.0.0.1:11434";
    } else {
      if (!nodeUrl.trim()) {
        showToast("Node URL is required for network mode", "error");
        return;
      }
      body.networkNodeUrl = nodeUrl.trim();
      if (nodeToken.trim()) {
        body.networkNodeToken = nodeToken.trim();
      }
    }
    saveMutation.mutate(body);
    setNodeToken("");
  };

  const handleTestConnection = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const body: Record<string, string> = { mode };
      if (mode === "local") {
        body.localUrl = localUrl.trim() || "http://127.0.0.1:11434";
      } else {
        body.networkNodeUrl = nodeUrl.trim();
        if (nodeToken.trim()) body.networkNodeToken = nodeToken.trim();
      }
      const result = await fetchJson<TestResult>(
        "/api/admin/local-llm/ollama/test-connection",
        { method: "POST", body: JSON.stringify(body) },
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTestLoading(false);
    }
  };

  if (configQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-5" data-testid="ollama-node-panel">
      {isAppleSilicon && (
        <div
          className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-blue-700 dark:text-blue-300"
          role="note"
          data-testid="ollama-apple-silicon-tip"
        >
          <strong>Tip:</strong> A second Mac with 36 GB+ unified memory can run{" "}
          <code>gemma4:31b</code> at INT4. Switch to <em>Network Node</em> below
          and point at the peer&apos;s Ollama socket. See{" "}
          <a
            href="/docs/REMOTE_OLLAMA_SETUP.md"
            className="underline hover:no-underline"
          >
            docs/REMOTE_OLLAMA_SETUP.md
          </a>
          .
        </div>
      )}

      {/* Mode Toggle */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          Ollama Target
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("local")}
            data-testid="ollama-mode-local"
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
              mode === "local"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:border-primary/30"
            }`}
          >
            Local Ollama
          </button>
          <button
            type="button"
            onClick={() => setMode("network")}
            data-testid="ollama-mode-network"
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
              mode === "network"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:border-primary/30"
            }`}
          >
            Network Node
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === "local"
            ? "Talk to Ollama on this machine (default 11434)."
            : "Talk to Ollama on a peer machine on your LAN."}
        </p>
      </div>

      {mode === "local" && (
        <div className="space-y-1.5">
          <label
            htmlFor="ollama-local-url"
            className="text-xs font-medium text-muted-foreground"
          >
            Local URL
          </label>
          <input
            id="ollama-local-url"
            type="text"
            placeholder="http://127.0.0.1:11434"
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )}

      {mode === "network" && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="space-y-1.5">
            <label
              htmlFor="ollama-network-url"
              className="text-xs font-medium text-muted-foreground"
            >
              Network Node URL
            </label>
            <input
              id="ollama-network-url"
              type="text"
              placeholder="http://192.168.1.50:11434"
              value={nodeUrl}
              onChange={(e) => setNodeUrl(e.target.value)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50"
            />
            <p className="text-[11px] text-muted-foreground">
              Must be on a private LAN range (RFC1918). Loopback addresses are
              rejected — use Local Ollama mode for that.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="ollama-token"
              className="text-xs font-medium text-muted-foreground"
            >
              Bearer Token{" "}
              {configQuery.data?.hasToken && !nodeToken && (
                <span className="text-green-500">(configured)</span>
              )}
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  id="ollama-token"
                  type={showToken ? "text" : "password"}
                  placeholder={
                    configQuery.data?.hasToken
                      ? "••••••••  (leave blank to keep)"
                      : "Optional — only if peer is behind a reverse-proxy"
                  }
                  value={nodeToken}
                  onChange={(e) => setNodeToken(e.target.value)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Test connection */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleTestConnection}
          disabled={testLoading}
          data-testid="ollama-test-connection"
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
        >
          {testLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wifi className="h-4 w-4" />
          )}
          Test Connection
        </button>

        {testResult && (
          <span
            data-testid="ollama-test-result"
            className={`flex items-center gap-1.5 text-sm font-medium ${
              testResult.ok ? "text-green-500" : "text-red-500"
            }`}
          >
            {testResult.ok ? (
              <Wifi className="h-4 w-4" />
            ) : (
              <WifiOff className="h-4 w-4" />
            )}
            {testResult.ok
              ? `✅ Ollama ${testResult.version ?? "?"} · ${testResult.modelCount ?? 0} models`
              : `❌ ${testResult.error ?? "unreachable"}`}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saveMutation.isPending}
        data-testid="ollama-save"
        className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
      >
        {saveMutation.isPending ? "Saving…" : "Save"}
      </button>
    </div>
  );
};
