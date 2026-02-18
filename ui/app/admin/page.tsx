"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ToolInfo } from "@/lib/types";
import { SectionCard } from "@/components/section-card";
import { ChannelsPanel } from "@/components/admin/channels-panel";
import { SidecarsPanel } from "@/components/admin/sidecars-panel";
import { LocalServersPanel } from "@/components/admin/local-servers-panel";
import { ToolsPanel } from "@/components/admin/tools-panel";
import { EnvPanel } from "@/components/admin/env-panel";
import { PersonalityPanel } from "@/components/admin/personality-panel";
import { TaskEnginePanel } from "@/components/admin/task-engine-panel";
import { SessionsPanel } from "@/components/admin/sessions-panel";
import { ModelConfigPanel } from "@/components/admin/model-config-panel";
import { AgentsPanel } from "@/components/admin/agents-panel";
import { McpEditorPanel } from "@/components/admin/mcp-editor-panel";
import { SentinelPanel } from "@/components/admin/sentinel-panel";
import { KnowledgeConfigPanel } from "@/components/admin/knowledge-config-panel";
import { VaultPanel } from "@/components/admin/vault-panel";
import { DirectorPanel } from "@/components/admin/director-panel";
import { VoiceConfigPanel } from "@/components/admin/voice-config-panel";
import { ToastContainer, showToast } from "@/components/toast";
import { RotateCw } from "lucide-react";

export default function AdminPage() {
  const [restarting, setRestarting] = useState(false);

  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => fetchJson<{ tools: Record<string, ToolInfo[]> }>("/api/admin/tools"),
  });

  const toolGroups = toolsQuery.data?.tools ?? {};

  const handleRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await fetchJson("/api/admin/restart", { method: "POST" });
      showToast("Server restarting… page will reconnect automatically.", "info");
    } catch {
      showToast("Failed to send restart command.", "error");
    }
    // Keep the restarting state for a few seconds while the server restarts
    setTimeout(() => setRestarting(false), 5000);
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-12">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">Administration</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Channels, sidecars, tool controls, and environment at a glance.
          </p>
        </div>
        <button
          className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
          onClick={handleRestart}
          disabled={restarting}
          title="Restart the backend server (applies pending config changes)"
        >
          <RotateCw className={`h-4 w-4 ${restarting ? "animate-spin" : ""}`} />
          {restarting ? "Restarting…" : "Restart Server"}
        </button>
      </header>

      <div className="flex flex-col gap-8">
        <SectionCard title="Channels">
          <ChannelsPanel />
        </SectionCard>

        <SectionCard title="AI Personality">
          <PersonalityPanel />
        </SectionCard>

        <SectionCard title="Model Configuration">
          <ModelConfigPanel />
        </SectionCard>

        <SectionCard title="Task Engine" defaultOpen={false}>
          <TaskEnginePanel />
        </SectionCard>

        <SectionCard title="Sentinel Monitor" defaultOpen={false}>
          <SentinelPanel />
        </SectionCard>

        <SectionCard title="Knowledge Base" defaultOpen={false}>
          <KnowledgeConfigPanel />
        </SectionCard>

        <SectionCard title="Secret Vault" defaultOpen={false}>
          <VaultPanel />
        </SectionCard>

        <SectionCard title="Director Mode">
          <DirectorPanel />
        </SectionCard>

        <SectionCard title="Custom Agents" defaultOpen={false}>
          <AgentsPanel />
        </SectionCard>

        <SectionCard title="Sessions" defaultOpen={false}>
          <SessionsPanel />
        </SectionCard>

        <SectionCard title="MCP Sidecars (Docker)" defaultOpen={false}>
          <SidecarsPanel />
        </SectionCard>

        <SectionCard title="Local MCP Servers" defaultOpen={false}>
          <LocalServersPanel />
        </SectionCard>

        <SectionCard title="Native MCP Servers" defaultOpen={false}>
          <McpEditorPanel />
        </SectionCard>

        <SectionCard title="Tools" defaultOpen={false}>
          {toolsQuery.isLoading ? (
            <p className="text-sm text-ink/50">Loading…</p>
          ) : (
            <ToolsPanel toolGroups={toolGroups} />
          )}
        </SectionCard>

        <SectionCard title="Voice & Audio">
          <VoiceConfigPanel />
        </SectionCard>

        <SectionCard title="Environment" defaultOpen={false}>
          <EnvPanel />
        </SectionCard>
      </div>

      <ToastContainer />
    </main>
  );
}
