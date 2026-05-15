"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ToolInfo } from "@/lib/types";
import { SectionCard } from "@/components/section-card";
import { ChannelsPanel } from "@/components/admin/channels-panel";
import { LocalServersPanel } from "@/components/admin/local-servers-panel";
import { ToolsPanel } from "@/components/admin/tools-panel";
import { EnvPanel } from "@/components/admin/env-panel";
import { PersonalityPanel } from "@/components/admin/personality-panel";
import { TaskEnginePanel } from "@/components/admin/task-engine-panel";
import { SessionsPanel } from "@/components/admin/sessions-panel";
import { ModelConfigPanel } from "@/components/admin/model-config-panel";
import { LocalLlmPanel } from "@/components/admin/local-llm-panel";
import { OllamaNodePanel } from "@/components/admin/ollama-node-panel";
import { SystemRequirementsCard } from "@/components/admin/system-requirements-card";
import { CostSummaryCard } from "@/components/admin/cost-summary-card";
import { AgentsPanel } from "@/components/admin/agents-panel";
import { McpEditorPanel } from "@/components/admin/mcp-editor-panel";
import { SentinelPanel } from "@/components/admin/sentinel-panel";
import { KnowledgeConfigPanel } from "@/components/admin/knowledge-config-panel";
import { VaultPanel } from "@/components/admin/vault-panel";
import { IntegrationsPanel } from "@/components/admin/integrations-panel";
import { MemoryPanel } from "@/components/admin/memory-panel";
import { DirectorPanel } from "@/components/admin/director-panel";
import { ImageGenPanel } from "@/components/admin/image-gen-panel";
import { RemoteNodesPanel } from "@/components/admin/remote-nodes-panel";
import { VideoGenPanel } from "@/components/admin/video-gen-panel";
import { MusicGenPanel } from "@/components/admin/music-gen-panel";
import { PresenterConfigPanel } from "@/components/admin/presenter-config-panel";
import { VoiceConfigPanel } from "@/components/admin/voice-config-panel";
import { VoiceLabPanel } from "@/components/voice-lab/voice-lab-panel";
import { BrandVoicePanel } from "@/components/admin/brand-voice-panel";
import { PinterestPanel } from "@/components/admin/pinterest-panel";
import { LinkedInPanel } from "@/components/admin/linkedin-panel";
import { TikTokPanel } from "@/components/admin/tiktok-panel";
import { SocialBrainPanel } from "@/components/admin/social-brain-panel";
import { OrchestrationTemplatesPanel } from "@/components/admin/orchestration-templates-panel";
import { GpuPanel } from "@/components/admin/gpu-panel";
import { VllmPanel } from "@/components/admin/vllm-panel";
import { ToastContainer, showToast } from "@/components/toast";
import { PlatformBadge } from "@/components/platform-badge";
import { usePlatform } from "@/lib/hooks/use-platform";
import { RotateCw } from "lucide-react";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";

export default function AdminPage() {
  const [restarting, setRestarting] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const { data: platformData } = usePlatform();

  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () =>
      fetchJson<{ tools: Record<string, ToolInfo[]> }>("/api/admin/tools"),
  });

  const toolGroups = toolsQuery.data?.tools ?? {};

  const handleRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await fetchJson("/api/admin/restart", { method: "POST" });
      showToast(
        "Server restarting… page will reconnect automatically.",
        "info",
      );
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
          <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">
            OpenZigs
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">
            Administration
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Channels, MCP servers, tool controls, and environment at a glance.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AskAiButton onClick={() => setAskAiOpen(true)} />
          <button
            className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground transition hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
            onClick={handleRestart}
            disabled={restarting}
            title="Restart the backend server (applies pending config changes)"
          >
            <RotateCw
              className={`h-4 w-4 ${restarting ? "animate-spin" : ""}`}
            />
            {restarting ? "Restarting…" : "Restart Server"}
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-8">
        <SectionCard title="Channels">
          <ChannelsPanel />
        </SectionCard>

        <SectionCard title="AI Personality">
          <PersonalityPanel />
        </SectionCard>

        <SectionCard title="Brand Voice" defaultOpen={false}>
          <BrandVoicePanel />
        </SectionCard>

        <SectionCard title="Model Configuration">
          <ModelConfigPanel />
        </SectionCard>

        <SectionCard title="Local LLM Provider">
          <LocalLlmPanel />
        </SectionCard>

        <SectionCard title="Ollama Node" defaultOpen={false}>
          <OllamaNodePanel />
        </SectionCard>

        <SystemRequirementsCard />

        <SectionCard title="Cost Summary">
          <CostSummaryCard />
        </SectionCard>

        <SectionCard title="Task Engine" defaultOpen={false}>
          <TaskEnginePanel />
        </SectionCard>

        <SectionCard title="Orchestration Templates" defaultOpen={false}>
          <OrchestrationTemplatesPanel />
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

        <SectionCard title="Integrations" defaultOpen={false}>
          <IntegrationsPanel />
        </SectionCard>

        <SectionCard title="Agent Memory" defaultOpen={false}>
          <MemoryPanel />
        </SectionCard>

        <SectionCard title="Presenter Mode" defaultOpen={false}>
          <PresenterConfigPanel />
        </SectionCard>

        <SectionCard title="Director Mode">
          <DirectorPanel />
        </SectionCard>

        <SectionCard
          title={
            <span className="flex items-center gap-2">
              Image Generation Node{" "}
              <PlatformBadge
                feature={platformData?.features?.imageGeneration}
              />
            </span>
          }
          defaultOpen={false}
        >
          <ImageGenPanel />
        </SectionCard>

        <SectionCard title="Remote Media Worker Nodes" defaultOpen={false}>
          <RemoteNodesPanel />
        </SectionCard>

        <SectionCard
          id="video-gen-node"
          title={
            <span className="flex items-center gap-2">
              Video Generation Node{" "}
              <PlatformBadge feature={platformData?.features?.videoRendering} />
            </span>
          }
          defaultOpen={false}
        >
          <VideoGenPanel />
        </SectionCard>

        <SectionCard
          title={
            <span className="flex items-center gap-2">
              Music Generation Node{" "}
              <PlatformBadge
                feature={platformData?.features?.musicGeneration}
              />
            </span>
          }
          defaultOpen={false}
        >
          <MusicGenPanel />
        </SectionCard>

        <SectionCard title="GPU & VRAM" defaultOpen={false}>
          <GpuPanel />
        </SectionCard>

        <SectionCard title="Local vLLM (TP=2)" defaultOpen={false}>
          <VllmPanel />
        </SectionCard>

        <SectionCard title="Pinterest SEO" defaultOpen={false}>
          <PinterestPanel />
        </SectionCard>

        <SectionCard title="LinkedIn" defaultOpen={false}>
          <LinkedInPanel />
        </SectionCard>

        <SectionCard title="TikTok" defaultOpen={false}>
          <TikTokPanel />
        </SectionCard>

        <SectionCard title="Social Brain Credentials" defaultOpen={false}>
          <SocialBrainPanel />
        </SectionCard>

        <SectionCard title="Custom Agents" defaultOpen={false}>
          <AgentsPanel />
        </SectionCard>

        <SectionCard title="Sessions" defaultOpen={false}>
          <SessionsPanel />
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

        <SectionCard title="Voice Lab" defaultOpen={true}>
          <VoiceLabPanel />
        </SectionCard>

        <SectionCard title="Environment" defaultOpen={false}>
          <EnvPanel />
        </SectionCard>
      </div>

      <ToastContainer />
      <AskAiPanel
        pageContext={PAGE_CONTEXTS["admin"]}
        open={askAiOpen}
        onClose={() => setAskAiOpen(false)}
      />
    </main>
  );
}
