"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ToolInfo } from "@/lib/types";
import { SectionCard } from "@/components/section-card";
import { ChannelsPanel } from "@/components/admin/channels-panel";
import { SidecarsPanel } from "@/components/admin/sidecars-panel";
import { LocalServersPanel } from "@/components/admin/local-servers-panel";
import { ToolsPanel } from "@/components/admin/tools-panel";
import { EnvPanel } from "@/components/admin/env-panel";
import { ToastContainer } from "@/components/toast";

export default function AdminPage() {
  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => fetchJson<{ tools: Record<string, ToolInfo[]> }>("/api/admin/tools"),
  });

  const toolGroups = toolsQuery.data?.tools ?? {};

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">Administration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Channels, sidecars, tool controls, and environment at a glance.
        </p>
      </header>

      <div className="flex flex-col gap-8">
        <SectionCard title="Channels">
          <ChannelsPanel />
        </SectionCard>

        <SectionCard title="MCP Sidecars (Docker)">
          <SidecarsPanel />
        </SectionCard>

        <SectionCard title="Local MCP Servers">
          <LocalServersPanel />
        </SectionCard>

        <SectionCard title="Tools">
          {toolsQuery.isLoading ? (
            <p className="text-sm text-ink/50">Loading…</p>
          ) : (
            <ToolsPanel toolGroups={toolGroups} />
          )}
        </SectionCard>

        <SectionCard title="Environment">
          <EnvPanel />
        </SectionCard>
      </div>

      <ToastContainer />
    </main>
  );
}
