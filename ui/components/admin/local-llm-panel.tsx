"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Loader2, RefreshCw, ShieldAlert, Zap } from "lucide-react";

/**
 * Admin panel for local LLM provider (epic #1053 / issue #1057).
 *
 * Surfaces:
 *   - Provider selector (Ollama / vLLM / custom) with endpoint + model fields
 *   - "Test Connection" → calls /autodetect, hydrates the form on hit
 *   - Health badge (green/amber/red) polled from /status every 5s
 *   - Per-session privacy toggle (localStorage-backed; UI-only signal here,
 *     consumed by the chat client via the `openzigs:privacy-mode` localStorage key)
 *   - Global lockdown switch (calls POST /privacy/global with confirm)
 *   - vLLM API key reveal-once UI on rotation, masked thereafter
 */

type ProviderType = "local-copilot";

interface DetectedEndpoint {
  endpoint: string;
  models: string[];
  recommendedModel: string | null;
}

interface AutodetectResponse {
  ollama: DetectedEndpoint | null;
  vllm: DetectedEndpoint | null;
  skipped?: boolean;
}

interface StatusResponse {
  provider: {
    type: ProviderType;
    endpoint: string;
    model: string;
    timeoutMs?: number;
    hasApiKey: boolean;
  } | null;
  privacyMode: { globalLockdown: boolean };
  health: {
    status: "healthy" | "degraded" | "failed-over" | "disabled";
    lastProbeAt: string | null;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    failoverActive: boolean;
  };
  vllmKey: { masked: string | null; present: boolean };
}

const PRIVACY_LS_KEY = "openzigs:privacy-mode";

const HEALTH_BADGE = {
  healthy: { label: "Healthy", className: "bg-green-100 text-green-800 border-green-300" },
  degraded: { label: "Degraded", className: "bg-amber-100 text-amber-900 border-amber-300" },
  "failed-over": { label: "Failed over", className: "bg-red-100 text-red-800 border-red-300" },
  disabled: { label: "Disabled", className: "bg-gray-100 text-gray-700 border-gray-300" },
} as const;

const extractError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const t = err.message.trim();
  if (!t.startsWith("{")) return t;
  try {
    const parsed = JSON.parse(t) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? t;
  } catch {
    return t;
  }
};

export function LocalLlmPanel() {
  const queryClient = useQueryClient();
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [perSessionPrivacy, setPerSessionPrivacy] = useState(false);

  // Hydrate per-session privacy from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setPerSessionPrivacy(window.localStorage.getItem(PRIVACY_LS_KEY) === "true");
  }, []);

  const togglePerSessionPrivacy = (next: boolean) => {
    setPerSessionPrivacy(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PRIVACY_LS_KEY, next ? "true" : "false");
    }
  };

  const statusQuery = useQuery({
    queryKey: ["local-llm", "status"],
    queryFn: () => fetchJson<StatusResponse>("/api/admin/local-llm/status"),
    refetchInterval: 5000,
  });

  // Hydrate form from status whenever provider changes server-side.
  useEffect(() => {
    if (statusQuery.data?.provider) {
      setEndpoint(statusQuery.data.provider.endpoint);
      setModel(statusQuery.data.provider.model);
    }
  }, [statusQuery.data?.provider]);

  const testConnection = useMutation({
    mutationFn: () => fetchJson<AutodetectResponse>("/api/admin/local-llm/autodetect"),
    onSuccess: (data) => {
      if (data.skipped) {
        showToast("Autodetect disabled in config", "info");
        return;
      }
      const hit = data.ollama ?? data.vllm;
      if (!hit) {
        showToast("No local LLM detected on 11434 or 8000", "info");
        return;
      }
      setEndpoint(hit.endpoint);
      if (hit.recommendedModel) setModel(hit.recommendedModel);
      showToast(`Detected at ${hit.endpoint}`, "success");
    },
    onError: (err) => showToast(extractError(err), "error"),
  });

  const saveProvider = useMutation({
    mutationFn: () =>
      fetchJson("/api/admin/local-llm/provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "local-copilot",
          endpoint,
          model,
          ...(apiKey ? { apiKey } : {}),
        }),
      }),
    onSuccess: () => {
      showToast("Provider saved", "success");
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["local-llm"] });
    },
    onError: (err) => showToast(extractError(err), "error"),
  });

  const clearProvider = useMutation({
    mutationFn: () =>
      fetchJson("/api/admin/local-llm/provider", { method: "DELETE" }),
    onSuccess: () => {
      showToast("Provider cleared", "success");
      setEndpoint("");
      setModel("");
      void queryClient.invalidateQueries({ queryKey: ["local-llm"] });
    },
    onError: (err) => showToast(extractError(err), "error"),
  });

  const toggleGlobalLockdown = useMutation({
    mutationFn: (next: boolean) =>
      fetchJson("/api/admin/local-llm/privacy/global", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ globalLockdown: next }),
      }),
    onSuccess: (_data, variables) => {
      showToast(
        variables ? "Global privacy lockdown ENABLED" : "Global lockdown disabled",
        variables ? "info" : "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["local-llm"] });
    },
    onError: (err) => showToast(extractError(err), "error"),
  });

  const rotateKey = useMutation({
    mutationFn: () =>
      fetchJson<{ apiKey: string; masked: string }>(
        "/api/admin/local-llm/vllm-key/rotate",
        { method: "POST" },
      ),
    onSuccess: (data) => {
      setRevealedKey(data.apiKey);
      showToast("vLLM API key rotated. Copy now — you won't see it again.", "info");
      void queryClient.invalidateQueries({ queryKey: ["local-llm"] });
    },
    onError: (err) => showToast(extractError(err), "error"),
  });

  const health = statusQuery.data?.health;
  const healthBadge = HEALTH_BADGE[health?.status ?? "disabled"];
  const globalLockdown = !!statusQuery.data?.privacyMode.globalLockdown;
  const masked = statusQuery.data?.vllmKey.masked;
  const keyPresent = !!statusQuery.data?.vllmKey.present;

  const dirty = useMemo(() => {
    const cur = statusQuery.data?.provider;
    if (!cur) return endpoint.length > 0 && model.length > 0;
    return cur.endpoint !== endpoint || cur.model !== model || apiKey.length > 0;
  }, [statusQuery.data?.provider, endpoint, model, apiKey]);

  return (
    <div className="space-y-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <Zap className="h-5 w-5 text-amber-500" aria-hidden="true" />
            Local LLM Provider
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Run Copilot CLI fully offline against a local OpenAI-compatible endpoint
            (Ollama or vLLM). Privacy mode hard-blocks any remote fallback.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${healthBadge.className}`}
          data-testid="health-badge"
        >
          {healthBadge.label}
        </span>
      </header>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Provider</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Endpoint</span>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="http://127.0.0.1:11434/v1"
              className="rounded border border-gray-300 px-3 py-2 font-mono text-xs"
              aria-label="Endpoint URL"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Model</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gemma4:26b"
              className="rounded border border-gray-300 px-3 py-2 font-mono text-xs"
              aria-label="Model name"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="font-medium text-gray-700">API Key (optional)</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={statusQuery.data?.provider?.hasApiKey ? "•••• stored ••••" : "Leave blank for none"}
              className="rounded border border-gray-300 px-3 py-2 font-mono text-xs"
              aria-label="API key"
              autoComplete="off"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => testConnection.mutate()}
            disabled={testConnection.isPending}
            className="inline-flex items-center gap-2 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {testConnection.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Test connection
          </button>
          <button
            type="button"
            onClick={() => saveProvider.mutate()}
            disabled={!dirty || saveProvider.isPending || !endpoint || !model}
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saveProvider.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save provider
          </button>
          {statusQuery.data?.provider && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Clear the active local-copilot provider?")) {
                  clearProvider.mutate();
                }
              }}
              disabled={clearProvider.isPending}
              className="inline-flex items-center gap-2 rounded border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Clear provider
            </button>
          )}
        </div>
      </section>

      <section className="space-y-3 rounded border border-amber-200 bg-amber-50 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          Privacy mode
        </h3>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={perSessionPrivacy}
            onChange={(e) => togglePerSessionPrivacy(e.target.checked)}
            aria-label="Per-session privacy mode"
          />
          <span>
            <strong>Per-session</strong>: hard-block remote provider fallback for new
            chats from this browser only.
          </span>
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={globalLockdown}
            onChange={(e) => {
              const next = e.target.checked;
              const msg = next
                ? "Enable GLOBAL privacy lockdown? All sessions will refuse remote fallback even if the local endpoint fails."
                : "Disable global privacy lockdown? Sessions will be allowed to fall back to remote providers when the local endpoint fails.";
              if (window.confirm(msg)) toggleGlobalLockdown.mutate(next);
            }}
            disabled={toggleGlobalLockdown.isPending}
            aria-label="Global privacy lockdown"
          />
          <span>
            <strong>Global lockdown</strong>: server-enforced; persisted across restarts.
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">vLLM API Key</h3>
        {revealedKey ? (
          <div className="rounded border border-amber-300 bg-amber-50 p-3">
            <p className="mb-2 text-xs font-medium text-amber-900">
              New key — copy now. It will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs">
                {revealedKey}
              </code>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-xs"
                onClick={() => {
                  void navigator.clipboard.writeText(revealedKey);
                  showToast("Copied to clipboard", "success");
                }}
              >
                Copy
              </button>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-xs"
                onClick={() => setRevealedKey(null)}
              >
                Hide
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-600">
            {keyPresent ? (
              <>
                Stored key: <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">{masked}</code>
              </>
            ) : (
              "No key stored yet."
            )}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                "Rotate the vLLM API key? Any clients using the old key will need to be updated.",
              )
            ) {
              rotateKey.mutate();
            }
          }}
          disabled={rotateKey.isPending}
          className="inline-flex items-center gap-2 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          {rotateKey.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Rotate key
        </button>
      </section>
    </div>
  );
}
