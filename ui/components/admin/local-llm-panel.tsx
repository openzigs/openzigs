"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Loader2, RefreshCw, ShieldAlert, Zap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
type ProviderPreset = "ollama" | "vllm" | "custom";

const PROVIDER_PRESETS: {
  value: ProviderPreset;
  label: string;
  defaultEndpoint: string;
}[] = [
  {
    value: "ollama",
    label: "Ollama (local)",
    defaultEndpoint: "http://127.0.0.1:11434/v1",
  },
  {
    value: "vllm",
    label: "vLLM (local)",
    defaultEndpoint: "http://127.0.0.1:8000/v1",
  },
  { value: "custom", label: "Custom OpenAI-compatible", defaultEndpoint: "" },
];

/**
 * Subset of the `/api/system/platform` response we consume for the admin
 * parity bug-fix (#1077). The wizard already labels vLLM as unsupported
 * on Apple Silicon — the admin combobox + dedicated vLLM panel must too.
 */
interface PlatformResponse {
  vllmSupported?: boolean;
  vllmUnsupportedReason?: string | null;
}

function detectPreset(endpoint: string): ProviderPreset {
  if (endpoint.includes("11434")) return "ollama";
  if (endpoint.includes("8000")) return "vllm";
  return "custom";
}

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

interface SmartRouterResponse {
  enabled: boolean;
  cloudThresholdTokens: number;
  thresholdStops: number[];
}

const ROUTER_THRESHOLD_STOPS = [256, 1024, 4096, 8192] as const;
type RouterThreshold = (typeof ROUTER_THRESHOLD_STOPS)[number];

const PRIVACY_LS_KEY = "openzigs:privacy-mode";

const HEALTH_BADGE = {
  healthy: {
    label: "Healthy",
    className: "bg-green-100 text-green-800 border-green-300",
  },
  degraded: {
    label: "Degraded",
    className: "bg-amber-100 text-amber-900 border-amber-300",
  },
  "failed-over": {
    label: "Failed over",
    className: "bg-red-100 text-red-800 border-red-300",
  },
  disabled: {
    label: "Disabled",
    className: "bg-gray-100 text-gray-700 border-gray-300",
  },
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
  const [preset, setPreset] = useState<ProviderPreset>("ollama");
  // Bug #1064-PN-B: shadcn Dialog state replaces native window.confirm calls.
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void;
  } | null>(null);

  // Hydrate per-session privacy from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setPerSessionPrivacy(
      window.localStorage.getItem(PRIVACY_LS_KEY) === "true",
    );
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
    // Bug #1064-PN-A: drop poll cadence from 5s→30s to keep the admin tab
    // from hammering the API (~12 req/min instead of ~15 req/min). Sentinel
    // pushes status changes via Socket.IO between polls anyway.
    refetchInterval: 30_000,
  });

  // Bug #1077-A1: gate the vLLM preset on host capability so Mac users
  // can't silently pick a backend that won't run. Cheap, cached, no poll.
  const platformQuery = useQuery({
    queryKey: ["system", "platform"],
    queryFn: () => fetchJson<PlatformResponse>("/api/system/platform"),
    staleTime: 5 * 60_000,
  });
  const vllmSupported = platformQuery.data?.vllmSupported !== false;
  const vllmUnsupportedReason =
    platformQuery.data?.vllmUnsupportedReason ?? null;

  // Hydrate form from status whenever provider changes server-side.
  useEffect(() => {
    if (statusQuery.data?.provider) {
      setEndpoint(statusQuery.data.provider.endpoint);
      setModel(statusQuery.data.provider.model);
      setPreset(detectPreset(statusQuery.data.provider.endpoint));
    }
  }, [statusQuery.data?.provider]);

  const testConnection = useMutation({
    mutationFn: () =>
      fetchJson<AutodetectResponse>("/api/admin/local-llm/autodetect"),
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
      setPreset(detectPreset(hit.endpoint));
      // Bug #1064-#7: explicit success toast naming the provider/endpoint.
      const providerName = data.ollama ? "Ollama" : "vLLM";
      showToast(
        `Connection OK — found ${providerName} at ${hit.endpoint}`,
        "success",
      );
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
        variables
          ? "Global privacy lockdown ENABLED"
          : "Global lockdown disabled",
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
      showToast(
        "vLLM API key rotated. Copy now — you won't see it again.",
        "info",
      );
      void queryClient.invalidateQueries({ queryKey: ["local-llm"] });
    },
    onError: (err) => showToast(extractError(err), "error"),
  });

  // ── Smart router (Phase 3.5) ──
  const routerQuery = useQuery({
    queryKey: ["local-llm", "router"],
    queryFn: () =>
      fetchJson<SmartRouterResponse>("/api/admin/local-llm/router"),
  });

  const routerEnabled = routerQuery.data?.enabled ?? true;
  const routerThreshold = (routerQuery.data?.cloudThresholdTokens ??
    4096) as RouterThreshold;

  // Bug #1064-PN-C: track the slider's value locally so the input isn't
  // visually re-controlled (and refocused-from-elsewhere) on every React
  // Query refetch. We sync from server when the query data changes and
  // we're not in the middle of a pending update.
  const [draftThreshold, setDraftThreshold] =
    useState<RouterThreshold>(routerThreshold);
  useEffect(() => {
    setDraftThreshold(routerThreshold);
  }, [routerThreshold]);

  const updateRouter = useMutation({
    mutationFn: (next: {
      enabled: boolean;
      cloudThresholdTokens: RouterThreshold;
    }) =>
      fetchJson("/api/admin/local-llm/router", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }),
    onSuccess: (_data, vars) => {
      showToast(
        vars.enabled
          ? `Smart router enabled (≤ ${vars.cloudThresholdTokens} tokens → local)`
          : "Smart router disabled",
        "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["local-llm", "router"] });
    },
    onError: (err) => showToast(extractError(err), "error"),
  });

  const health = statusQuery.data?.health;
  const healthBadge = HEALTH_BADGE[health?.status ?? "disabled"];
  const globalLockdown = !!statusQuery.data?.privacyMode.globalLockdown;
  const masked = statusQuery.data?.vllmKey.masked;
  const keyPresent = !!statusQuery.data?.vllmKey.present;

  const dirty = useMemo(() => {
    // Bug #1064-#7: defensive null-coalesce. `endpoint`/`model` are
    // initialized to "" via useState, but a stray setState with an undefined
    // value (e.g., a malformed autodetect or status response) used to crash
    // the panel here with `Cannot read properties of undefined (reading
    // 'length')`. Coalescing keeps the form dirty-check resilient regardless
    // of upstream payload shape.
    const safeEndpoint = endpoint ?? "";
    const safeModel = model ?? "";
    const cur = statusQuery.data?.provider;
    if (!cur) return safeEndpoint.length > 0 && safeModel.length > 0;
    return (
      cur.endpoint !== safeEndpoint ||
      cur.model !== safeModel ||
      (apiKey ?? "").length > 0
    );
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
            Run Copilot CLI fully offline against a local OpenAI-compatible
            endpoint (Ollama or vLLM). Privacy mode hard-blocks any remote
            fallback.
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
        {/* Bug #1064-#6c: provider preset dropdown so users don't have to
            remember the canonical Ollama/vLLM ports. Selecting a preset
            pre-fills the endpoint; "Custom" leaves the inputs untouched. */}
        <label className="flex flex-col gap-1 text-sm md:max-w-xs">
          <span className="font-medium text-gray-700">Provider type</span>
          <Select
            value={preset}
            onValueChange={(value) => {
              const next = value as ProviderPreset;
              setPreset(next);
              const opt = PROVIDER_PRESETS.find((p) => p.value === next);
              if (
                opt &&
                opt.defaultEndpoint &&
                (!endpoint || endpoint !== opt.defaultEndpoint)
              ) {
                setEndpoint(opt.defaultEndpoint);
              }
            }}
          >
            <SelectTrigger
              aria-label="Provider preset"
              data-testid="provider-preset"
              className="w-full"
            >
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_PRESETS.map((p) => {
                // Bug #1077-A1: vLLM has no Apple Silicon build. Disable
                // the option AND prefix its label with the wizard's "⛔"
                // affordance so users on Mac can't pick a backend that
                // won't run, but can still see WHY it's unavailable.
                const isVllmDisabled = p.value === "vllm" && !vllmSupported;
                const label = isVllmDisabled
                  ? `⛔ ${p.label} — ${vllmUnsupportedReason ?? "not supported on this platform"}`
                  : p.label;
                return (
                  <SelectItem
                    key={p.value}
                    value={p.value}
                    disabled={isVllmDisabled}
                    aria-disabled={isVllmDisabled || undefined}
                    data-testid={`provider-preset-${p.value}`}
                  >
                    {label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </label>
        {!vllmSupported && (
          <p
            className="text-xs text-amber-700 dark:text-amber-400"
            data-testid="vllm-unsupported-notice"
            role="note"
          >
            ⛔{" "}
            {vllmUnsupportedReason ??
              "vLLM is not supported on this platform — use Ollama instead."}
          </p>
        )}
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
              placeholder="gemma4:e2b-mlx-bf16"
              className="rounded border border-gray-300 px-3 py-2 font-mono text-xs"
              aria-label="Model name"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="font-medium text-gray-700">
              API Key (optional)
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                statusQuery.data?.provider?.hasApiKey
                  ? "•••• stored ••••"
                  : "Leave blank for none"
              }
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
            {testConnection.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Test connection
          </button>
          <button
            type="button"
            onClick={() => saveProvider.mutate()}
            disabled={!dirty || saveProvider.isPending || !endpoint || !model}
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saveProvider.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save provider
          </button>
          {statusQuery.data?.provider && (
            <button
              type="button"
              onClick={() =>
                setConfirmDialog({
                  title: "Clear local provider?",
                  description:
                    "The active local-copilot provider will be cleared. New chats will route to cloud providers (subject to privacy mode).",
                  confirmLabel: "Clear provider",
                  destructive: true,
                  onConfirm: () => clearProvider.mutate(),
                })
              }
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
            <strong>Per-session</strong>: hard-block remote provider fallback
            for new chats from this browser only.
          </span>
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={globalLockdown}
            onChange={(e) => {
              const next = e.target.checked;
              setConfirmDialog({
                title: next
                  ? "Enable global privacy lockdown?"
                  : "Disable global privacy lockdown?",
                description: next
                  ? "All sessions will refuse remote fallback even if the local endpoint fails. This applies server-wide and persists across restarts."
                  : "Sessions will be allowed to fall back to remote providers when the local endpoint fails.",
                confirmLabel: next ? "Enable lockdown" : "Disable lockdown",
                destructive: !next,
                onConfirm: () => toggleGlobalLockdown.mutate(next),
              });
            }}
            disabled={toggleGlobalLockdown.isPending}
            aria-label="Global privacy lockdown"
          />
          <span>
            <strong>Global lockdown</strong>: server-enforced; persisted across
            restarts.
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
                Stored key:{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                  {masked}
                </code>
              </>
            ) : (
              "No key stored yet."
            )}
          </p>
        )}
        <button
          type="button"
          onClick={() =>
            setConfirmDialog({
              title: "Rotate vLLM API key?",
              description:
                "A new key will be generated. Any clients using the old key will need to be updated. The new key will be revealed once.",
              confirmLabel: "Rotate key",
              destructive: true,
              onConfirm: () => rotateKey.mutate(),
            })
          }
          disabled={rotateKey.isPending}
          className="inline-flex items-center gap-2 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          {rotateKey.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Rotate key
        </button>
      </section>

      <section
        className="space-y-3 rounded border border-blue-200 bg-blue-50 p-4"
        data-testid="smart-router-section"
      >
        <h3 className="text-sm font-semibold text-blue-900">Smart router</h3>
        <p className="text-xs text-blue-900/80">
          When enabled, requests with an estimated input ≤ the threshold go to
          the local provider; everything else goes to cloud. Privacy mode always
          overrides the router.
        </p>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={routerEnabled}
            disabled={routerQuery.isPending || updateRouter.isPending}
            onChange={(e) =>
              updateRouter.mutate({
                enabled: e.target.checked,
                cloudThresholdTokens: routerThreshold,
              })
            }
            aria-label="Smart router enabled"
            data-testid="smart-router-toggle"
          />
          <span>
            <strong>Enabled</strong>: route per-call based on token estimate.
          </span>
        </label>
        <div className="space-y-1">
          <label
            htmlFor="smart-router-threshold"
            className="block text-xs font-medium text-blue-900"
          >
            Cloud threshold (tokens):{" "}
            <span data-testid="smart-router-threshold-value">
              {draftThreshold}
            </span>
          </label>
          <input
            id="smart-router-threshold"
            type="range"
            min={0}
            max={ROUTER_THRESHOLD_STOPS.length - 1}
            step={1}
            value={ROUTER_THRESHOLD_STOPS.indexOf(draftThreshold)}
            disabled={!routerEnabled}
            onChange={(e) => {
              const next = ROUTER_THRESHOLD_STOPS[Number(e.target.value)];
              setDraftThreshold(next);
              updateRouter.mutate({
                enabled: routerEnabled,
                cloudThresholdTokens: next,
              });
            }}
            aria-label="Cloud threshold tokens"
            data-testid="smart-router-threshold"
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-blue-900/70">
            {ROUTER_THRESHOLD_STOPS.map((stop) => (
              <span key={stop}>{stop}</span>
            ))}
          </div>
        </div>
      </section>

      <Dialog
        open={confirmDialog != null}
        onOpenChange={(open) => {
          if (!open) setConfirmDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmDialog?.title}</DialogTitle>
            <DialogDescription>{confirmDialog?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmDialog(null)}
              className="rounded border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="confirm-dialog-confirm"
              onClick={() => {
                const action = confirmDialog?.onConfirm;
                setConfirmDialog(null);
                action?.();
              }}
              className={`rounded px-3 py-1.5 text-sm font-medium text-white ${
                confirmDialog?.destructive
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {confirmDialog?.confirmLabel ?? "Confirm"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
