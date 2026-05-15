"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Eye, EyeOff, Loader2, Wifi, WifiOff } from "lucide-react";

type NodeView = {
  nodeType: string;
  url: string | null;
  hasToken: boolean;
  allowLan: boolean;
  defaultPort: number;
  envVar?: string | null;
  cfAccessClientId?: string;
  hasCfAccessClientSecret?: boolean;
};

type NodeListResponse = { nodes: NodeView[] };

type TestResult = {
  ok: boolean;
  health?: { ok: boolean; status?: number; body?: unknown; error?: string };
  capabilities?: {
    ok: boolean;
    status?: number;
    body?: unknown;
    error?: string;
  };
};

const NODE_LABELS: Record<string, string> = {
  "image-gen": "Image Generation",
  "video-gen": "Video Generation",
  "music-gen": "Music Generation",
  rvc: "RVC Voice Conversion",
  "lip-sync": "Lip Sync",
  audio: "Audio",
  "sad-talker": "Sad Talker",
};

interface NodeCardProps {
  node: NodeView;
}

const NodeCard = ({ node }: NodeCardProps) => {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(node.url ?? "");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [cfAccessClientId, setCfAccessClientId] = useState(
    node.cfAccessClientId ?? "",
  );
  const [cfAccessClientSecret, setCfAccessClientSecret] = useState("");
  const [showCfSecret, setShowCfSecret] = useState(false);
  const [allowLan, setAllowLan] = useState(node.allowLan);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson(`/api/admin/remote-nodes/${node.nodeType}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["remote-nodes"] });
      showToast(`${NODE_LABELS[node.nodeType]} saved`, "success");
      setToken("");
      setCfAccessClientSecret("");
    },
    onError: (err) =>
      showToast(`Save failed: ${(err as Error).message}`, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/remote-nodes/${node.nodeType}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["remote-nodes"] });
      showToast(`${NODE_LABELS[node.nodeType]} reset to local`, "success");
      setUrl("");
      setToken("");
      setCfAccessClientId("");
      setCfAccessClientSecret("");
      setAllowLan(false);
      setTestResult(null);
    },
    onError: (err) =>
      showToast(`Reset failed: ${(err as Error).message}`, "error"),
  });

  const handleSave = () => {
    if (!url.trim()) {
      showToast("URL is required", "error");
      return;
    }
    const body: Record<string, unknown> = { url: url.trim(), allowLan };
    if (token.trim()) body.token = token.trim();
    body.cfAccessClientId = cfAccessClientId.trim();
    if (cfAccessClientSecret.trim())
      body.cfAccessClientSecret = cfAccessClientSecret.trim();
    saveMutation.mutate(body);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { allowLan };
      if (url.trim()) body.url = url.trim();
      if (token.trim()) body.token = token.trim();
      if (cfAccessClientId.trim())
        body.cfAccessClientId = cfAccessClientId.trim();
      if (cfAccessClientSecret.trim())
        body.cfAccessClientSecret = cfAccessClientSecret.trim();
      const result = await fetchJson<TestResult>(
        `/api/admin/remote-nodes/${node.nodeType}/test`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        health: { ok: false, error: (err as Error).message },
      });
    } finally {
      setTesting(false);
    }
  };

  const isConfigured = Boolean(node.url);

  return (
    <div className="border rounded-md p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-medium flex items-center gap-2">
          {isConfigured ? (
            <Wifi className="h-4 w-4 text-green-500" />
          ) : (
            <WifiOff className="h-4 w-4 text-muted-foreground" />
          )}
          {NODE_LABELS[node.nodeType] ?? node.nodeType}
        </h4>
        <span className="text-xs text-muted-foreground">
          default port {node.defaultPort}
        </span>
      </div>

      <div className="space-y-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Node URL</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={`https://${node.nodeType}.example.com`}
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
          />
        </label>

        <label className="block text-sm">
          <span className="text-muted-foreground">
            Secret Token{" "}
            {node.hasToken && <span className="text-xs">(configured)</span>}
          </span>
          <div className="mt-1 flex gap-1">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                node.hasToken ? "Leave blank to keep" : "Bearer token"
              }
              className="flex-1 rounded border px-2 py-1 text-sm"
            />
            <button
              type="button"
              aria-label={showToken ? "Hide token" : "Show token"}
              onClick={() => setShowToken((v) => !v)}
              className="px-2 border rounded"
            >
              {showToken ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowLan}
            onChange={(e) => setAllowLan(e.target.checked)}
          />
          <span>Allow LAN (RFC1918) addresses</span>
        </label>

        <div className="pt-2 border-t space-y-2">
          <p className="text-xs text-muted-foreground">
            Optional. Use a Cloudflare Access service token (Zero Trust → Access
            → Service Auth → Service Tokens) when this node&apos;s hostname is
            protected by an Access policy. The Bearer token field above is
            independent and continues to authenticate inside the sidecar.
          </p>
          <label className="block text-sm">
            <span className="text-muted-foreground">CF-Access-Client-Id</span>
            <input
              type="text"
              value={cfAccessClientId}
              onChange={(e) => setCfAccessClientId(e.target.value)}
              placeholder="abc123.access"
              autoComplete="off"
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              CF-Access-Client-Secret{" "}
              {node.hasCfAccessClientSecret && (
                <span className="text-xs">(configured)</span>
              )}
            </span>
            <div className="mt-1 flex gap-1">
              <input
                type={showCfSecret ? "text" : "password"}
                value={cfAccessClientSecret}
                onChange={(e) => setCfAccessClientSecret(e.target.value)}
                placeholder={
                  node.hasCfAccessClientSecret
                    ? "••••••••"
                    : "Service token secret"
                }
                autoComplete="new-password"
                className="flex-1 rounded border px-2 py-1 text-sm"
              />
              <button
                type="button"
                aria-label={
                  showCfSecret
                    ? "Hide CF Access secret"
                    : "Show CF Access secret"
                }
                onClick={() => setShowCfSecret((v) => !v)}
                className="px-2 border rounded"
              >
                {showCfSecret ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </label>
        </div>
      </div>

      {testResult && (
        <div className="text-xs space-y-1 rounded border p-2 bg-muted/30">
          <div>
            /health:{" "}
            {testResult.health?.ok ? (
              <span className="text-green-600">
                OK ({testResult.health.status})
              </span>
            ) : (
              <span className="text-red-600">
                FAIL ({testResult.health?.error ?? testResult.health?.status})
              </span>
            )}
          </div>
          <div>
            /capabilities:{" "}
            {testResult.capabilities?.ok ? (
              <span className="text-green-600">
                OK ({testResult.capabilities.status})
              </span>
            ) : (
              <span className="text-red-600">
                FAIL (
                {testResult.capabilities?.error ??
                  testResult.capabilities?.status}
                )
              </span>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className="px-3 py-1 text-sm border rounded hover:bg-muted/50 inline-flex items-center gap-1"
        >
          {testing && <Loader2 className="h-3 w-3 animate-spin" />}
          Test Connection
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded inline-flex items-center gap-1"
        >
          {saveMutation.isPending && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          Save
        </button>
        {isConfigured && (
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="px-3 py-1 text-sm border rounded text-red-600 hover:bg-red-50"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
};

export const RemoteNodesPanel = () => {
  const nodesQuery = useQuery({
    queryKey: ["remote-nodes"],
    queryFn: () => fetchJson<NodeListResponse>("/api/admin/remote-nodes"),
  });

  if (nodesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (nodesQuery.isError) {
    return (
      <p className="text-sm text-red-600">
        Failed to load: {(nodesQuery.error as Error).message}
      </p>
    );
  }

  const nodes = nodesQuery.data?.nodes ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Configure remote media worker nodes (e.g. via Cloudflare Tunnel). Each
        node URL is validated against SSRF rules before saving. See{" "}
        <code>docs/REMOTE_NODES_SETUP.md</code> for setup instructions.
      </p>
      <div className="grid gap-3">
        {nodes.map((n) => (
          <NodeCard key={n.nodeType} node={n} />
        ))}
      </div>
    </div>
  );
};
