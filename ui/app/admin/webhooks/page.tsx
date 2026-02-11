"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";

type WebhookSummary = {
  id: string;
  name: string;
  action: "prompt" | "goal";
  actionPayload: Record<string, unknown>;
  enabled: boolean;
  allowedIps: string[];
  rateLimit: number;
  triggerCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
};

type CreateWebhookResponse = {
  webhook: WebhookSummary & { secret: string };
  apiKey: string;
};

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [revealedKey, setRevealedKey] = useState<{ id: string; apiKey: string; secret: string } | null>(null);

  const webhooksQuery = useQuery({
    queryKey: ["webhooks"],
    queryFn: () => fetchJson<{ webhooks: WebhookSummary[] }>("/api/admin/webhooks"),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      fetchJson(`/api/admin/webhooks/${id}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
      showToast("Webhook toggled", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/webhooks/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
      showToast("Webhook deleted", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const rotateKeyMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ apiKey: string }>(`/api/admin/webhooks/${id}/rotate-key`, { method: "POST" }),
    onSuccess: (data, id) => {
      showToast("API key rotated — copy the new key below", "success");
      setRevealedKey((prev) => prev ? { ...prev, apiKey: data.apiKey } : { id, apiKey: data.apiKey, secret: "" });
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const webhooks = webhooksQuery.data?.webhooks ?? [];

  const handleDelete = (wh: WebhookSummary) => {
    if (!confirm(`Delete webhook "${wh.name}"? This cannot be undone.`)) return;
    deleteMutation.mutate(wh.id);
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 lg:px-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">Webhooks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create inbound webhooks that trigger prompts or agent goals from external systems.
        </p>
      </header>

      <div className="mb-6 flex justify-end">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          + New Webhook
        </button>
      </div>

      {showForm && (
        <div className="mb-6">
          <WebhookForm
            onCreated={(res) => {
              queryClient.invalidateQueries({ queryKey: ["webhooks"] });
              setShowForm(false);
              setRevealedKey({ id: res.webhook.id, apiKey: res.apiKey, secret: res.webhook.secret });
            }}
          />
        </div>
      )}

      {/* Newly created key reveal banner */}
      {revealedKey && (
        <div className="mb-6 rounded-2xl border border-amber-400/30 bg-amber-50/5 p-4">
          <p className="text-sm font-semibold text-amber-500">
            🔑 Save this API key — it won&apos;t be shown again
          </p>
          <code className="mt-2 block break-all rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {revealedKey.apiKey}
          </code>
          {revealedKey.secret && (
            <>
              <p className="mt-3 text-xs text-muted-foreground">HMAC Secret (for signature verification):</p>
              <code className="mt-1 block break-all rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {revealedKey.secret}
              </code>
            </>
          )}
          <button
            onClick={() => setRevealedKey(null)}
            className="mt-3 text-xs text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}

      <SectionCard title="Configured Webhooks">
        {webhooksQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : webhooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No webhooks configured yet. Click &quot;+ New Webhook&quot; to create one.
          </p>
        ) : (
          <div className="space-y-3">
            {webhooks.map((wh) => (
              <div key={wh.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{wh.name}</p>
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
                      {wh.action}
                    </span>
                    {!wh.enabled && (
                      <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                        Disabled
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <ToggleSwitch
                      checked={wh.enabled}
                      onChange={(v) => toggleMutation.mutate({ id: wh.id, enabled: v })}
                    />
                    <button
                      onClick={() => rotateKeyMutation.mutate(wh.id)}
                      disabled={rotateKeyMutation.isPending}
                      className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-500 hover:bg-amber-500/5 disabled:opacity-40"
                    >
                      🔄 Rotate Key
                    </button>
                    <button
                      onClick={() => handleDelete(wh)}
                      className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>ID: <code className="font-mono">{wh.id}</code></span>
                  <span>Rate: {wh.rateLimit}/min</span>
                  {wh.allowedIps.length > 0 && <span>IPs: {wh.allowedIps.join(", ")}</span>}
                </div>
                <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span>Triggers: {wh.triggerCount}</span>
                  {wh.lastTriggeredAt && <span>Last: {new Date(wh.lastTriggeredAt).toLocaleString()}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <ToastContainer />
    </main>
  );
}

/* ── Webhook Form ── */

const WebhookForm = ({ onCreated }: { onCreated: (res: CreateWebhookResponse) => void }) => {
  const [name, setName] = useState("");
  const [action, setAction] = useState<"prompt" | "goal">("prompt");
  const [promptName, setPromptName] = useState("");
  const [goal, setGoal] = useState("");
  const [rateLimit, setRateLimit] = useState("60");
  const [allowedIps, setAllowedIps] = useState("");

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson<CreateWebhookResponse>("/api/admin/webhooks", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      showToast("Webhook created", "success");
      onCreated(data);
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleCreate = () => {
    if (!name.trim()) { showToast("Name is required", "error"); return; }
    const actionPayload: Record<string, unknown> =
      action === "prompt" ? { promptName: promptName.trim() } : { goal: goal.trim() };

    createMutation.mutate({
      name: name.trim(),
      action,
      actionPayload,
      rateLimit: parseInt(rateLimit, 10) || 60,
      allowedIps: allowedIps.trim()
        ? allowedIps.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
    });
  };

  return (
    <div className="rounded-2xl border border-primary/20 bg-card p-5">
      <h3 className="mb-4 text-lg font-semibold text-foreground">New Webhook</h3>
      <div className="space-y-3">
        <Field label="Name">
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            placeholder="e.g., github-deploy-hook"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Action">
          <select
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            value={action}
            onChange={(e) => setAction(e.target.value as "prompt" | "goal")}
          >
            <option value="prompt">Prompt</option>
            <option value="goal">Goal</option>
          </select>
        </Field>
        {action === "prompt" ? (
          <Field label="Prompt Name" hint="The saved prompt to execute when triggered.">
            <input
              type="text"
              className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
              placeholder="daily-summary"
              value={promptName}
              onChange={(e) => setPromptName(e.target.value)}
            />
          </Field>
        ) : (
          <Field label="Goal" hint="Natural language goal to pass to the agent.">
            <textarea
              className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
              rows={2}
              placeholder="Analyze the incoming data and generate a report"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </Field>
        )}
        <Field label="Rate Limit (per minute)" hint="0 = unlimited.">
          <input
            type="number"
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 text-sm"
            value={rateLimit}
            onChange={(e) => setRateLimit(e.target.value)}
          />
        </Field>
        <Field label="Allowed IPs" hint="Comma-separated list. Leave empty to allow all.">
          <input
            type="text"
            className="w-full rounded-lg border border-border bg-card text-foreground px-3 py-2 font-mono text-sm"
            placeholder="192.168.1.1, 10.0.0.0/8"
            value={allowedIps}
            onChange={(e) => setAllowedIps(e.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={handleCreate}
            disabled={createMutation.isPending}
            className="rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {createMutation.isPending ? "Creating…" : "Create Webhook"}
          </button>
        </div>
      </div>
    </div>
  );
};

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="space-y-1">
    <label className="text-xs font-medium text-muted-foreground">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-muted-foreground/60">{hint}</p>}
  </div>
);

const ToggleSwitch = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-moss" : "bg-muted"}`}
    onClick={() => onChange(!checked)}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`}
    />
  </button>
);
