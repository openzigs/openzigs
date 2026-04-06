"use client";

import { useState } from "react";
import {
  Film,
  Globe,
  FolderOpen,
  Scissors,
  Sparkles,
  MonitorUp,
  Palette,
  Layers,
  BarChart3,
} from "lucide-react";
import { DirectorWizard } from "@/components/director/director-wizard";
import { BlogToVideoPanel } from "@/components/director/blog-to-video-panel";
import { ShortsPanel } from "@/components/director/shorts-panel";
import { DraftsPanel } from "@/components/director/drafts-panel";
import { HeroReelPanel } from "@/components/director/hero-reel-panel";
import { CaptureAndTrimPanel } from "@/components/director/studio/capture-and-trim-panel";
import { BrandKitEditor } from "@/components/director/brand-kit-editor";
import { BatchRenderPanel } from "@/components/director/batch-render-panel";
import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard";
import { ToastContainer } from "@/components/toast";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";

type DirectorTab =
  | "wizard"
  | "blog"
  | "shorts"
  | "drafts"
  | "hero-reel"
  | "capture"
  | "brand-kit"
  | "batch-render"
  | "analytics";

export default function DirectorPage() {
  const [tab, setTab] = useState<DirectorTab>("wizard");
  const [askAiOpen, setAskAiOpen] = useState(false);

  return (
    <main
      className={`mx-auto flex h-[calc(100vh-4rem)] flex-col px-6 py-10 lg:px-12 ${tab === "capture" ? "max-w-7xl" : "max-w-4xl"}`}
    >
      <header className="mb-4 shrink-0">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">
          OpenZigs
        </p>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="mt-1 text-3xl font-semibold text-foreground">
              Director Mode
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Produce AI-directed videos from raw clips, text documents, or blog
              posts.
            </p>
          </div>
          <AskAiButton onClick={() => setAskAiOpen(true)} />
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 border-b border-border mb-4 shrink-0">
        <button
          onClick={() => setTab("wizard")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "wizard"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Film className="h-4 w-4" />
          Video Wizard
        </button>
        <button
          onClick={() => setTab("blog")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "blog"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Globe className="h-4 w-4" />
          Blog to YouTube
        </button>
        <button
          onClick={() => setTab("shorts")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "shorts"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Scissors className="h-4 w-4" />
          YouTube Shorts
        </button>
        <button
          onClick={() => setTab("drafts")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "drafts"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <FolderOpen className="h-4 w-4" />
          My Drafts
        </button>
        <button
          onClick={() => setTab("hero-reel")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "hero-reel"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Sparkles className="h-4 w-4" />✨ Hero Reel
        </button>
        <button
          onClick={() => setTab("capture")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "capture"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <MonitorUp className="h-4 w-4" />
          Capture &amp; Trim
        </button>
        <button
          onClick={() => setTab("brand-kit")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "brand-kit"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Palette className="h-4 w-4" />
          Brand Kit
        </button>
        <button
          onClick={() => setTab("batch-render")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "batch-render"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Layers className="h-4 w-4" />
          Batch Render
        </button>
        <button
          onClick={() => setTab("analytics")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "analytics"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <BarChart3 className="h-4 w-4" />
          Analytics
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "wizard" && <DirectorWizard />}
        {tab === "blog" && <BlogToVideoPanel />}
        {tab === "shorts" && <ShortsPanel />}
        {tab === "drafts" && <DraftsPanel />}
        {tab === "hero-reel" && <HeroReelPanel />}
        {tab === "capture" && <CaptureAndTrimPanel />}
        {tab === "brand-kit" && <BrandKitEditor />}
        {tab === "batch-render" && <BatchRenderPanel />}
        {tab === "analytics" && <AnalyticsDashboard />}
      </div>
      <ToastContainer />
      <AskAiPanel
        pageContext={PAGE_CONTEXTS["director"]}
        open={askAiOpen}
        onClose={() => setAskAiOpen(false)}
      />
    </main>
  );
}
