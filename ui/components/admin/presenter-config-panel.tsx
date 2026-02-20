"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

type PresenterConfig = {
  baseUrl: string;
  hasInviteSecret: boolean;
};

export const PresenterConfigPanel = () => {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["presenter-config"],
    queryFn: () => fetchJson<PresenterConfig>("/api/admin/presenter/config"),
  });

  const [baseUrl, setBaseUrl] = useState("");
  const [initialized, setInitialized] = useState(false);

  if (configQuery.data && !initialized) {
    setBaseUrl(configQuery.data.baseUrl);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: { baseUrl: string }) =>
      fetchJson("/api/admin/presenter/config", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["presenter-config"] });
      showToast("Presenter config saved. Restart server to apply.", "success");
    },
    onError: (err) => showToast(`Save failed: ${(err as Error).message}`, "error"),
  });

  if (configQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Base URL
        </label>
        <input
          type="text"
          placeholder="https://your-tunnel.trycloudflare.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50"
        />
        <p className="text-xs text-muted-foreground">
          Public URL used in guest invite links. Leave blank to use{" "}
          <code className="text-xs">localhost</code>. Use your Cloudflare Tunnel
          domain so guests can join remotely.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => saveMutation.mutate({ baseUrl })}
          disabled={saveMutation.isPending}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>

        {configQuery.data && (
          <span className={`text-xs ${configQuery.data.hasInviteSecret ? "text-green-500" : "text-muted-foreground"}`}>
            {configQuery.data.hasInviteSecret
              ? "Invite secret configured"
              : "No invite secret — set PRESENTER_INVITE_SECRET env var"}
          </span>
        )}
      </div>
    </div>
  );
};
