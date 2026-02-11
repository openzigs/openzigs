"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ModelConfig, ReasoningEffort, ProviderType } from "@/lib/types";
import { showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RotateCw, Key, Eye, EyeOff, CheckCircle, XCircle, Cloud, Trash2 } from "lucide-react";

const EFFORT_LEVELS: { value: ReasoningEffort; label: string; dots: number }[] = [
  { value: "low", label: "Low", dots: 1 },
  { value: "medium", label: "Medium", dots: 2 },
  { value: "high", label: "High", dots: 3 },
  { value: "xhigh", label: "xHigh", dots: 4 },
];

const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "azure", label: "Azure" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom" },
];

const DEFAULT_URLS: Record<ProviderType, string> = {
  openai: "https://api.openai.com/v1",
  azure: "",
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434",
  custom: "",
};

export const ModelConfigPanel = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["models-config"],
    queryFn: () => fetchJson<ModelConfig>("/api/admin/models/config"),
  });

  const config = query.data;

  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [byokEnabled, setByokEnabled] = useState(false);
  const [providerType, setProviderType] = useState<ProviderType>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [azureApiVersion, setAzureApiVersion] = useState("2024-10-21");
  const [showKey, setShowKey] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  useEffect(() => {
    if (config) {
      setReasoningEffort(config.reasoningEffort ?? "medium");
      if (config.provider) {
        setByokEnabled(true);
        setProviderType(config.provider.type as ProviderType);
        setBaseUrl(config.provider.baseUrl ?? "");
        if (config.provider.azure?.apiVersion) {
          setAzureApiVersion(config.provider.azure.apiVersion);
        }
      } else {
        setByokEnabled(false);
      }
    }
  }, [config]);

  const hasChanges =
    config &&
    (reasoningEffort !== (config.reasoningEffort ?? "medium") ||
      byokEnabled !== !!config.provider ||
      (byokEnabled && providerType !== config.provider?.type) ||
      (byokEnabled && baseUrl !== (config.provider?.baseUrl ?? "")) ||
      apiKey.length > 0);

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson("/api/admin/models/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models-config"] });
      setApiKey("");
      showToast("Model configuration saved", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const testMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson<{ success: boolean; latency?: number; error?: string; model?: string }>(
        "/api/admin/models/test-connection",
        { method: "POST", body: JSON.stringify(payload) }
      ),
    onSuccess: (data) => {
      if (data.success) {
        setConnectionResult({
          success: true,
          message: `Connected${data.model ? ` — Model: ${data.model}` : ""}${data.latency ? `, Latency: ${data.latency}ms` : ""}`,
        });
      } else {
        setConnectionResult({ success: false, message: `Failed — ${data.error ?? "Unknown error"}` });
      }
    },
    onError: (err) => {
      setConnectionResult({ success: false, message: `Failed — ${err.message}` });
    },
  });

  const handleSave = () => {
    const payload: Record<string, unknown> = { reasoningEffort };
    if (byokEnabled) {
      const provider: Record<string, unknown> = { type: providerType, baseUrl };
      if (apiKey) provider.apiKey = apiKey;
      if (providerType === "azure" && azureApiVersion) {
        provider.azure = { apiVersion: azureApiVersion };
      }
      payload.provider = provider;
    } else {
      payload.provider = null;
    }
    saveMutation.mutate(payload);
  };

  const handleTest = () => {
    setConnectionResult(null);
    const provider: Record<string, unknown> = { type: providerType, baseUrl };
    if (apiKey) provider.apiKey = apiKey;
    if (providerType === "azure" && azureApiVersion) {
      provider.azure = { apiVersion: azureApiVersion };
    }
    testMutation.mutate({ provider });
  };

  const handleClearProvider = () => {
    setShowClearConfirm(true);
  };

  const confirmClearProvider = () => {
    setShowClearConfirm(false);
    setByokEnabled(false);
    setProviderType("openai");
    setBaseUrl("");
    setApiKey("");
    saveMutation.mutate({ reasoningEffort, provider: null });
  };

  const handleProviderTypeChange = (type: ProviderType) => {
    setProviderType(type);
    setBaseUrl(DEFAULT_URLS[type] ?? "");
    setConnectionResult(null);
  };

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading model config…</p>;
  }

  if (query.isError) {
    return <p className="text-sm text-destructive">Failed to load model configuration.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Reasoning Effort */}
      <div className="space-y-2">
        <p className="text-sm font-semibold text-foreground">Default Reasoning Effort</p>
        <div className="flex gap-2" role="radiogroup" aria-label="Default Reasoning Effort">
          {EFFORT_LEVELS.map((level) => (
            <button
              key={level.value}
              role="radio"
              aria-checked={reasoningEffort === level.value}
              onClick={() => setReasoningEffort(level.value)}
              className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-xs font-semibold transition ${
                reasoningEffort === level.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-primary/30"
              }`}
            >
              <span className="flex gap-0.5">
                {Array.from({ length: level.dots }, (_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-1.5 rounded-full ${
                      reasoningEffort === level.value ? "bg-primary" : "bg-muted-foreground/40"
                    }`}
                  />
                ))}
              </span>
              {level.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          Applies to reasoning models (o1, o3, o4-mini). Non-reasoning models ignore this setting. Users can override per-message in chat.
        </p>
      </div>

      {/* Provider Configuration */}
      <div className="space-y-4 border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">Provider Configuration</p>
            <p className="text-xs text-muted-foreground">
              Bring your own API key to use a custom model provider.
            </p>
          </div>
          <button
            onClick={() => setByokEnabled(!byokEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              byokEnabled ? "bg-moss" : "bg-muted"
            }`}
            role="switch"
            aria-checked={byokEnabled}
            aria-label="BYOK Provider"
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                byokEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {byokEnabled && (
          <div className="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
            {/* Provider Type */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Provider Type</label>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Provider Type">
                {PROVIDER_TYPES.map((pt) => (
                  <button
                    key={pt.value}
                    role="radio"
                    aria-checked={providerType === pt.value}
                    onClick={() => handleProviderTypeChange(pt.value)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                      providerType === pt.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    {pt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Base URL */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                <Cloud className="mr-1 inline h-3.5 w-3.5" />
                Base URL
              </label>
              <input
                type="url"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                placeholder={DEFAULT_URLS[providerType] || "https://..."}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              {providerType === "azure" && (
                <p className="text-[11px] text-muted-foreground/60">
                  Your Azure resource endpoint (e.g. https://my-resource.openai.azure.com/)
                </p>
              )}
            </div>

            {/* API Key */}
            {providerType !== "ollama" && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  <Key className="mr-1 inline h-3.5 w-3.5" />
                  API Key
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type={showKey ? "text" : "password"}
                    className="flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                    placeholder={config?.provider?.apiKey ? "••••••••  (already set)" : "sk-..."}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="rounded-lg border border-border px-2.5 py-2 text-muted-foreground hover:border-primary"
                    onClick={() => setShowKey(!showKey)}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {/* Azure API Version */}
            {providerType === "azure" && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Azure API Version</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                  placeholder="2024-10-21"
                  value={azureApiVersion}
                  onChange={(e) => setAzureApiVersion(e.target.value)}
                />
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleTest}
                disabled={!baseUrl || testMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-primary px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5 disabled:opacity-40"
              >
                {testMutation.isPending ? (
                  <><RotateCw className="h-3.5 w-3.5 animate-spin" />Testing…</>
                ) : (
                  "Test Connection"
                )}
              </button>
              {config?.provider && (
                <button
                  onClick={handleClearProvider}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear Provider
                </button>
              )}
            </div>

            {connectionResult && (
              <div
                className={`flex items-center gap-2 rounded-lg border p-3 text-xs ${
                  connectionResult.success
                    ? "border-moss/30 bg-moss/10 text-moss"
                    : "border-destructive/30 bg-destructive/10 text-destructive"
                }`}
              >
                {connectionResult.success ? (
                  <CheckCircle className="h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0" />
                )}
                {connectionResult.message}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Save */}
      <div className="flex justify-end border-t border-border pt-4">
        <button
          onClick={handleSave}
          disabled={!hasChanges || saveMutation.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
        >
          {saveMutation.isPending ? (
            <><RotateCw className="h-3.5 w-3.5 animate-spin" />Saving…</>
          ) : (
            "Save Configuration"
          )}
        </button>
      </div>

      {showClearConfirm && (
        <ConfirmDialog
          title="Clear Provider"
          message="Clear provider configuration? This will disable BYOK and use the default Copilot provider."
          confirmLabel="Clear"
          variant="danger"
          onConfirm={confirmClearProvider}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  );
};
