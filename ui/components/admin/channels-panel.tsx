"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ChannelConfig, ModelInfo } from "@/lib/types";
import { showToast } from "@/components/toast";

const parseList = (value: string): string[] =>
  value.split(",").map((s) => s.trim()).filter(Boolean);

export const ChannelsPanel = () => {
  const queryClient = useQueryClient();

  const channelsQuery = useQuery({
    queryKey: ["channels"],
    queryFn: () => fetchJson<{ channels: ChannelConfig }>("/api/admin/channels"),
  });

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<{ models: ModelInfo[] }>("/api/models"),
  });

  const channels = channelsQuery.data?.channels;
  const models = modelsQuery.data?.models ?? [];

  const [tgEnabled, setTgEnabled] = useState<boolean | null>(null);
  const [tgModel, setTgModel] = useState<string | null>(null);
  const [tgWebhook, setTgWebhook] = useState<string | null>(null);
  const [tgSecret, setTgSecret] = useState<string | null>(null);
  const [tgAdmin, setTgAdmin] = useState<string | null>(null);
  const [tgAllowed, setTgAllowed] = useState<string | null>(null);
  const [dcEnabled, setDcEnabled] = useState<boolean | null>(null);
  const [dcGuilds, setDcGuilds] = useState<string | null>(null);

  // Initialize local state from fetched data
  const tg = channels?.telegram;
  const dc = channels?.discord;

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson("/api/admin/channels", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      showToast("Channels saved. Restart server to apply.", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleSave = () => {
    saveMutation.mutate({
      telegram: {
        enabled: tgEnabled ?? tg?.enabled ?? false,
        model: tgModel ?? tg?.model ?? "",
        webhookUrl: tgWebhook ?? tg?.webhookUrl ?? "",
        webhookSecret: tgSecret ?? tg?.webhookSecret ?? "",
        adminUserId: tgAdmin ?? tg?.adminUserId ?? "",
        allowedUsers: parseList(tgAllowed ?? (tg?.allowedUsers ?? []).join(", ")),
      },
      discord: {
        enabled: dcEnabled ?? dc?.enabled ?? false,
        allowedGuilds: parseList(dcGuilds ?? (dc?.allowedGuilds ?? []).join(", ")),
      },
    });
  };

  if (channelsQuery.isLoading) {
    return <p className="text-sm text-ink/50">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      {/* Telegram */}
      <div className="rounded-2xl border border-ink/10 bg-white/60 p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Telegram</h3>
          <ToggleSwitch
            checked={tgEnabled ?? tg?.enabled ?? false}
            onChange={(v) => setTgEnabled(v)}
          />
        </div>
        <div className="space-y-3">
          <Field label="Model">
            <select
              className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
              value={tgModel ?? tg?.model ?? ""}
              onChange={(e) => setTgModel(e.target.value)}
            >
              <option value="">Default (System)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>
          </Field>
          <Field label="Webhook URL" hint="Required for inbound messages (set via tunnel).">
            <input
              type="text"
              className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
              placeholder="https://example.com/telegram/webhook"
              value={tgWebhook ?? tg?.webhookUrl ?? ""}
              onChange={(e) => setTgWebhook(e.target.value)}
            />
          </Field>
          <Field label="Webhook Secret" hint="Optional: validates incoming webhooks.">
            <input
              type="text"
              className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
              placeholder="random-secret-token"
              value={tgSecret ?? tg?.webhookSecret ?? ""}
              onChange={(e) => setTgSecret(e.target.value)}
            />
          </Field>
          <Field label="Admin User ID" hint="Optional: user allowed to run /toggle.">
            <input
              type="text"
              className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
              placeholder="123456789"
              value={tgAdmin ?? tg?.adminUserId ?? ""}
              onChange={(e) => setTgAdmin(e.target.value)}
            />
          </Field>
          <Field label="Allowed Users" hint="Comma-separated Telegram user IDs.">
            <input
              type="text"
              className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
              placeholder="user1, user2"
              value={tgAllowed ?? (tg?.allowedUsers ?? []).join(", ")}
              onChange={(e) => setTgAllowed(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Discord */}
      <div className="rounded-2xl border border-ink/10 bg-white/60 p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Discord</h3>
          <ToggleSwitch
            checked={dcEnabled ?? dc?.enabled ?? false}
            onChange={(v) => setDcEnabled(v)}
          />
        </div>
        <Field label="Allowed Guilds" hint="Comma-separated guild IDs. Leave empty for DMs only.">
          <input
            type="text"
            className="w-full rounded-lg border border-ink/10 bg-white/80 px-3 py-2 text-sm"
            placeholder="guild-id-1, guild-id-2"
            value={dcGuilds ?? (dc?.allowedGuilds ?? []).join(", ")}
            onChange={(e) => setDcGuilds(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <button
          className="rounded-xl bg-tide px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          disabled={saveMutation.isPending}
          onClick={handleSave}
        >
          {saveMutation.isPending ? "Saving…" : "Save & Restart"}
        </button>
      </div>
    </div>
  );
};

/* ── Helper components ── */

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="space-y-1">
    <label className="text-xs text-ink/50">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-ink/40">{hint}</p>}
  </div>
);

const ToggleSwitch = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={`relative h-6 w-11 rounded-full transition-colors ${checked ? "bg-moss" : "bg-ink/20"}`}
    onClick={() => onChange(!checked)}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : ""}`}
    />
  </button>
);
