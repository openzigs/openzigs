"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Eye, EyeOff, Loader2, Wifi, WifiOff } from "lucide-react";

type MusicGenConfig = {
  mode: "local" | "network";
  networkNodeUrl: string;
  networkNodeToken: string;
  hasToken: boolean;
};

type HealthResult = {
  ok: boolean;
  status?: string;
  model?: string;
  device?: string;
  backend?: string;
  error?: string;
};

export const MusicGenPanel = () => {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["music-gen-config"],
    queryFn: () => fetchJson<MusicGenConfig>("/api/admin/music-gen/config"),
  });

  const [mode, setMode] = useState<"local" | "network">("local");
  const [nodeUrl, setNodeUrl] = useState("");
  const [nodeToken, setNodeToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [healthResult, setHealthResult] = useState<HealthResult | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  if (configQuery.data && !initialized) {
    setMode(configQuery.data.mode);
    setNodeUrl(configQuery.data.networkNodeUrl);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      fetchJson("/api/admin/music-gen/config", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["music-gen-config"] });
      showToast("Music generation settings saved", "success");
    },
    onError: (err) => showToast(`Save failed: ${(err as Error).message}`, "error"),
  });

  const handleSave = () => {
    const body: Record<string, string> = { mode };
    if (mode === "network") {
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

  const handleHealthCheck = async () => {
    setHealthLoading(true);
    setHealthResult(null);
    try {
      const params = new URLSearchParams();
      if (mode === "network" && nodeUrl.trim()) {
        params.set("url", nodeUrl.trim());
        if (nodeToken.trim()) params.set("token", nodeToken.trim());
      }
      const qs = params.toString();
      const result = await fetchJson<HealthResult>(
        `/api/admin/music-gen/health${qs ? `?${qs}` : ""}`,
      );
      setHealthResult(result);
    } catch (err) {
      setHealthResult({ ok: false, error: (err as Error).message });
    } finally {
      setHealthLoading(false);
    }
  };

  if (configQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-5">
      {/* Mode Toggle */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Sidecar Mode</label>
        <div className="flex gap-2">
          <button
            onClick={() => setMode("local")}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
              mode === "local"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:border-primary/30"
            }`}
          >
            Local Process
          </button>
          <button
            onClick={() => setMode("network")}
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
            ? "ACE-Step music generation runs on this machine (localhost:5009)."
            : "Music generation is offloaded to a remote ACE-Step node on your network."}
        </p>
      </div>

      {/* Network Node Config */}
      {mode === "network" && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Node URL</label>
            <input
              type="text"
              placeholder="http://192.168.1.50:5009"
              value={nodeUrl}
              onChange={(e) => setNodeUrl(e.target.value)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Secret Token{" "}
              {configQuery.data?.hasToken && !nodeToken && (
                <span className="text-green-500">(configured)</span>
              )}
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showToken ? "text" : "password"}
                  placeholder={configQuery.data?.hasToken ? "••••••••  (leave blank to keep)" : "Paste secret token from remote node"}
                  value={nodeToken}
                  onChange={(e) => setNodeToken(e.target.value)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Health Check */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleHealthCheck}
          disabled={healthLoading}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
        >
          {healthLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wifi className="h-4 w-4" />
          )}
          Test Connection
        </button>

        {healthResult && (
          <span className={`flex items-center gap-1.5 text-sm font-medium ${healthResult.ok ? "text-green-500" : "text-red-500"}`}>
            {healthResult.ok ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            {healthResult.ok
              ? `Connected${healthResult.model ? ` · ${healthResult.model}` : ""}${healthResult.device ? ` · ${healthResult.device}` : ""}${healthResult.backend ? ` · ${healthResult.backend}` : ""}`
              : `Failed: ${healthResult.error ?? "unreachable"}`}
          </span>
        )}
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saveMutation.isPending}
        className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
      >
        {saveMutation.isPending ? "Saving…" : "Save"}
      </button>
    </div>
  );
};
