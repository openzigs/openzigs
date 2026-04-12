"use client";

export const dynamic = "force-dynamic";

import { useState, useCallback, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSeoHistory } from "@/hooks/useSeoHistory";
import { useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { CrawlProgressPanel } from "@/components/seo/crawl-progress-panel";
import { SiteHealthScore } from "@/components/seo/site-health-score";
import { AuditTrends } from "@/components/seo/audit-trends";
import { ExportDialog } from "@/components/seo/export-dialog";
import { LinkGraph } from "@/components/seo/link-graph";
import { InlineModelPicker } from "@/components/model-picker-select";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  buildSiteAuditPrompt,
  buildSeoGapAnalysisPrompt,
  buildMonitorPrompt,
  buildExtractPrompt,
  buildLeadPrompt,
  buildPricePrompt,
  buildDatasetPrompt,
  buildIngestPrompt,
  getSeoGapAnalysisTools,
  FIRECRAWL_TOOLS,
  type OrchestrationMode,
} from "@/lib/seo-prompts";
import {
  Search,
  BarChart3,
  History,
  Download,
  AlertTriangle,
  Link2,
  FileText,
  Gauge,
  Play,
  Loader2,
  AlertCircle,
  Globe,
  Database,
  FileJson,
  Users,
  DollarSign,
  HardDrive,
  Info,
  TrendingUp,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────

type SeoMode =
  | "site-audit"
  | "gap-analysis"
  | "competitors"
  | "extract"
  | "leads"
  | "prices"
  | "dataset"
  | "ingest";

interface AuditIssue {
  severity: string;
  category: string;
  message: string;
}

interface AuditPage {
  url: string;
  issues: AuditIssue[];
  metrics?: Record<string, number>;
}

interface BrokenLink {
  sourceUrl: string;
  targetUrl: string;
  anchorText: string;
  statusCode: number;
}

interface RedirectChain {
  chain?: string[];
}

interface LinkAnalysis {
  totalLinks: number;
  brokenLinks?: BrokenLink[];
  orphanPages?: (string | Record<string, unknown>)[];
  redirectChains?: RedirectChain[];
  links?: { source: string; target: string }[];
  nodes?: { id: string; issues?: number }[];
}

interface DuplicateGroup {
  urls?: string[];
}

interface ThinContentPage {
  url?: string;
  wordCount?: number;
}

interface ContentAnalysis {
  duplicateGroups?: DuplicateGroup[];
  thinContentPages?: (string | ThinContentPage)[];
}

interface CwvMetric {
  name: string;
  value: number;
  unit: string;
  rating: string;
}

interface CwvEntry {
  url: string;
  performanceScore: number;
  metrics?: CwvMetric[];
}

interface SeoData {
  pages?: AuditPage[];
  linkAnalysis?: LinkAnalysis;
  contentAnalysis?: ContentAnalysis;
  coreWebVitals?: CwvEntry[];
}

// ── Mode metadata ────────────────────────────────────────────────────────

const MODES: { key: SeoMode; label: string; icon: React.ReactNode }[] = [
  {
    key: "site-audit",
    label: "Site Audit",
    icon: <Search className="h-3.5 w-3.5" />,
  },
  {
    key: "gap-analysis",
    label: "Gap Analysis",
    icon: <TrendingUp className="h-3.5 w-3.5" />,
  },
  {
    key: "competitors",
    label: "Competitors",
    icon: <BarChart3 className="h-3.5 w-3.5" />,
  },
  {
    key: "extract",
    label: "Extract",
    icon: <FileJson className="h-3.5 w-3.5" />,
  },
  { key: "leads", label: "Leads", icon: <Users className="h-3.5 w-3.5" /> },
  {
    key: "prices",
    label: "Prices",
    icon: <DollarSign className="h-3.5 w-3.5" />,
  },
  {
    key: "dataset",
    label: "Dataset",
    icon: <HardDrive className="h-3.5 w-3.5" />,
  },
  {
    key: "ingest",
    label: "Ingest",
    icon: <Database className="h-3.5 w-3.5" />,
  },
];

// ── Component ────────────────────────────────────────────────────────────

export default function SeoPage() {
  const { data: history } = useSeoHistory();
  const queryClient = useQueryClient();
  const { socket, connected } = useSocket();
  const latest = history?.[0] ?? null;
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // ── Mode state ──
  const [mode, setMode] = useState<SeoMode>("site-audit");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Shared form fields ──
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(3);
  const [model, setModel] = useState("");

  // ── Gap Analysis fields ──
  const [targetKeyword, setTargetKeyword] = useState("");
  const [searchProvider, setSearchProvider] = useState("auto");
  const [orchestrationMode, setOrchestrationMode] =
    useState<OrchestrationMode>("standard");
  const [exportPdf, setExportPdf] = useState(true);

  // ── Ingest fields ──
  const [category, setCategory] = useState("document");
  const [visibility, setVisibility] = useState("internal");

  // ── Competitors fields ──
  const [monitorAction, setMonitorAction] = useState<
    "add" | "snapshot" | "report" | "list"
  >("add");
  const [competitorName, setCompetitorName] = useState("");

  // ── Extract fields ──
  const [extractSchema, setExtractSchema] = useState("");
  const [extractPrompt, setExtractPrompt] = useState("");
  const [extractTemplate, setExtractTemplate] = useState("custom");
  const [scrollForContent, setScrollForContent] = useState(false);
  const [waitForDynamic, setWaitForDynamic] = useState(false);

  // ── Price fields ──
  const [priceAction, setPriceAction] = useState<
    "snapshot" | "compare" | "history" | "list"
  >("snapshot");
  const [scrollToLoad, setScrollToLoad] = useState(false);
  const [priceLabel, setPriceLabel] = useState("");

  // ── Dataset fields ──
  const [datasetFormat, setDatasetFormat] = useState<
    "markdown" | "jsonl" | "csv"
  >("markdown");
  const [includePaths, setIncludePaths] = useState("");
  const [excludePaths, setExcludePaths] = useState("");

  // ── Firecrawl health ──
  const [firecrawlHealth, setFirecrawlHealth] = useState<{
    available: boolean;
    message: string;
    checking: boolean;
  }>({ available: false, message: "", checking: true });

  useEffect(() => {
    let cancelled = false;
    const checkHealth = async () => {
      try {
        const [seoHealth, adminStatus] = await Promise.allSettled([
          fetchJson<{ available: boolean; message: string }>("/api/seo/health"),
          fetchJson<{ enabled: boolean }>("/api/admin/firecrawl/status"),
        ]);
        const seoAvailable =
          seoHealth.status === "fulfilled" && seoHealth.value.available;
        const adminEnabled =
          adminStatus.status === "fulfilled" && adminStatus.value.enabled;
        if (!cancelled) {
          setFirecrawlHealth({
            available: seoAvailable || adminEnabled,
            message:
              seoHealth.status === "fulfilled"
                ? seoHealth.value.message
                : "Failed to check status",
            checking: false,
          });
        }
      } catch {
        if (!cancelled) {
          setFirecrawlHealth({
            available: false,
            message: "Failed to check Firecrawl status",
            checking: false,
          });
        }
      }
    };
    checkHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  const isFirecrawlMode = mode !== "gap-analysis";
  const showUrlInput =
    !(mode === "competitors" && monitorAction === "list") &&
    !(mode === "prices" && priceAction === "list");
  const showMaxPagesDepth =
    mode === "site-audit" ||
    mode === "ingest" ||
    mode === "leads" ||
    mode === "dataset";

  const handleSubmit = useCallback(() => {
    if (showUrlInput && !url.trim()) {
      setError("URL is required");
      return;
    }
    if (!socket || !connected) {
      setError("Not connected to server");
      return;
    }
    if (mode === "gap-analysis") {
      try {
        new URL(url.trim());
      } catch {
        setError("Please enter a valid URL");
        return;
      }
    }

    setError(null);
    setSubmitting(true);

    let prompt = "";
    let tools: string[] = FIRECRAWL_TOOLS;

    switch (mode) {
      case "site-audit":
        prompt = buildSiteAuditPrompt(url, maxPages, maxDepth);
        break;
      case "gap-analysis": {
        prompt = buildSeoGapAnalysisPrompt({
          targetUrl: url.trim(),
          targetKeyword: targetKeyword.trim(),
          searchProvider,
          exportPdf,
          orchestrationMode,
        });
        tools = getSeoGapAnalysisTools(orchestrationMode);
        break;
      }
      case "competitors":
        prompt = buildMonitorPrompt(
          monitorAction,
          url,
          competitorName,
          maxPages,
        );
        break;
      case "extract":
        prompt = buildExtractPrompt(
          url,
          extractSchema,
          extractPrompt,
          maxPages,
          extractTemplate,
          scrollForContent,
          waitForDynamic,
        );
        break;
      case "leads":
        prompt = buildLeadPrompt(url, maxPages);
        break;
      case "prices":
        prompt = buildPricePrompt(priceAction, url, priceLabel, scrollToLoad);
        break;
      case "dataset":
        prompt = buildDatasetPrompt(
          url,
          maxPages,
          maxDepth,
          datasetFormat,
          includePaths,
          excludePaths,
        );
        break;
      case "ingest":
        prompt = buildIngestPrompt(
          url,
          maxPages,
          maxDepth,
          category,
          visibility,
        );
        break;
    }

    socket.emit("chat:message", {
      content: prompt,
      model: model || undefined,
      tools,
    });

    setSubmitting(false);
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["seo-history"] });
    }, 3000);
  }, [
    mode,
    url,
    maxPages,
    maxDepth,
    model,
    socket,
    connected,
    showUrlInput,
    targetKeyword,
    searchProvider,
    orchestrationMode,
    exportPdf,
    monitorAction,
    competitorName,
    extractSchema,
    extractPrompt,
    extractTemplate,
    scrollForContent,
    waitForDynamic,
    priceAction,
    priceLabel,
    scrollToLoad,
    datasetFormat,
    includePaths,
    excludePaths,
    category,
    visibility,
    queryClient,
  ]);

  const latestData = latest ? safeParseDataJson(latest.dataJson) : null;

  return (
    <main className="px-6 py-10 lg:px-12 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">SEO Suite</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monitor site health, track audit history, and export reports.
        </p>
      </div>

      {/* ── Mode selector ──────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 mb-4">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => {
              setMode(m.key);
              setError(null);
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              mode === m.key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:bg-accent",
            )}
          >
            {m.icon}
            {m.label}
          </button>
        ))}
      </div>

      {/* ── Mode-specific form ─────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 mb-4">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Play className="h-4 w-4" />
          {MODES.find((m) => m.key === mode)?.label}
        </h3>

        {/* Firecrawl health warning */}
        {!firecrawlHealth.checking &&
          !firecrawlHealth.available &&
          isFirecrawlMode && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 mb-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
              <div className="text-sm">
                <p className="font-medium text-yellow-700 dark:text-yellow-500">
                  Firecrawl sidecar not available
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {firecrawlHealth.message ||
                    "Run docker compose -f docker-compose.firecrawl.yml up -d to start the Firecrawl sidecar."}
                </p>
              </div>
            </div>
          )}

        <div className="space-y-3">
          {/* URL input */}
          {showUrlInput && (
            <div>
              <label
                htmlFor="seo-url"
                className="mb-1 block text-sm font-medium"
              >
                {mode === "gap-analysis" ? "Target URL" : "Website URL"}{" "}
                <span className="text-destructive">*</span>
              </label>
              <input
                id="seo-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
                placeholder={
                  mode === "gap-analysis"
                    ? "https://example.com/my-blog-post"
                    : "https://example.com"
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {/* Max pages & depth */}
          {showMaxPagesDepth && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="max-pages"
                  className="mb-1 block text-sm font-medium"
                >
                  Max Pages
                </label>
                <input
                  id="max-pages"
                  type="number"
                  min={1}
                  max={mode === "site-audit" ? 500 : 200}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label
                  htmlFor="max-depth"
                  className="mb-1 block text-sm font-medium"
                >
                  Max Depth
                </label>
                <input
                  id="max-depth"
                  type="number"
                  min={1}
                  max={10}
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          )}

          {/* ── Gap Analysis fields ─── */}
          {mode === "gap-analysis" && (
            <>
              <div>
                <label
                  htmlFor="seo-keyword"
                  className="mb-1 block text-sm font-medium"
                >
                  Target Keyword
                </label>
                <input
                  id="seo-keyword"
                  type="text"
                  maxLength={200}
                  value={targetKeyword}
                  onChange={(e) => setTargetKeyword(e.target.value)}
                  placeholder="e.g. best project management tools"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Leave blank to auto-detect from page content
                </p>
              </div>
              <div>
                <label
                  htmlFor="seo-provider"
                  className="mb-1 block text-sm font-medium"
                >
                  Search Provider
                </label>
                <select
                  id="seo-provider"
                  value={searchProvider}
                  onChange={(e) => setSearchProvider(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="auto">Auto (use available API key)</option>
                  <option value="serper">Serper.dev (Google results)</option>
                  <option value="brave">Brave Search</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="seo-orch-mode"
                  className="mb-1 block text-sm font-medium"
                >
                  Analysis Mode
                </label>
                <select
                  id="seo-orch-mode"
                  value={orchestrationMode}
                  onChange={(e) =>
                    setOrchestrationMode(e.target.value as OrchestrationMode)
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="standard">
                    Standard — single session, 1 API call
                  </option>
                  <option value="session">
                    Session — SDK subagent delegation, ~2 API calls
                  </option>
                  <option value="task">
                    Parallel — fan-out agents, ~5 API calls
                  </option>
                </select>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exportPdf}
                  onChange={(e) => setExportPdf(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input"
                />
                <span className="text-sm">Also export as PDF</span>
              </label>
            </>
          )}

          {/* ── Ingest fields ─── */}
          {mode === "ingest" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="category"
                  className="mb-1 block text-sm font-medium"
                >
                  Category
                </label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="general">General</option>
                  <option value="document">Document</option>
                  <option value="reference">Reference</option>
                  <option value="tutorial">Tutorial</option>
                  <option value="api-docs">API Docs</option>
                  <option value="blog">Blog</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="visibility"
                  className="mb-1 block text-sm font-medium"
                >
                  Visibility
                </label>
                <select
                  id="visibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="internal">Internal</option>
                  <option value="public">Public</option>
                </select>
              </div>
            </div>
          )}

          {/* ── Competitors fields ─── */}
          {mode === "competitors" && (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="monitor-action"
                  className="mb-1 block text-sm font-medium"
                >
                  Action
                </label>
                <select
                  id="monitor-action"
                  value={monitorAction}
                  onChange={(e) =>
                    setMonitorAction(e.target.value as typeof monitorAction)
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="add">Add Competitor</option>
                  <option value="snapshot">Take Snapshot</option>
                  <option value="report">Generate Report</option>
                  <option value="list">List Competitors</option>
                </select>
              </div>
              {monitorAction === "add" && (
                <div>
                  <label
                    htmlFor="competitor-name"
                    className="mb-1 block text-sm font-medium"
                  >
                    Name (optional)
                  </label>
                  <input
                    id="competitor-name"
                    type="text"
                    value={competitorName}
                    onChange={(e) => setCompetitorName(e.target.value)}
                    placeholder="Friendly name"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Extract fields ─── */}
          {mode === "extract" && (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="extract-template"
                  className="mb-1 block text-sm font-medium"
                >
                  Template
                </label>
                <select
                  id="extract-template"
                  value={extractTemplate}
                  onChange={(e) => setExtractTemplate(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="custom">Custom</option>
                  <option value="contacts">Contacts</option>
                  <option value="pricing">Pricing</option>
                  <option value="jobs">Job Listings</option>
                  <option value="products">Products</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="extract-prompt"
                  className="mb-1 block text-sm font-medium"
                >
                  What to extract
                </label>
                <textarea
                  id="extract-prompt"
                  value={extractPrompt}
                  onChange={(e) => setExtractPrompt(e.target.value)}
                  placeholder="Describe what data to extract"
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {extractTemplate === "custom" && (
                <div>
                  <label
                    htmlFor="extract-schema"
                    className="mb-1 block text-sm font-medium"
                  >
                    JSON Schema (optional)
                  </label>
                  <textarea
                    id="extract-schema"
                    value={extractSchema}
                    onChange={(e) => setExtractSchema(e.target.value)}
                    placeholder='{"products": [{"name": "string", "price": "number"}]}'
                    rows={3}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              )}
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scrollForContent}
                    onChange={(e) => setScrollForContent(e.target.checked)}
                    className="rounded border-input"
                  />
                  Scroll to load all content
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={waitForDynamic}
                    onChange={(e) => setWaitForDynamic(e.target.checked)}
                    className="rounded border-input"
                  />
                  Wait for dynamic content
                </label>
              </div>
              <div>
                <label
                  htmlFor="extract-max-pages"
                  className="mb-1 block text-sm font-medium"
                >
                  Max Pages
                </label>
                <input
                  id="extract-max-pages"
                  type="number"
                  min={1}
                  max={200}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          )}

          {/* ── Price fields ─── */}
          {mode === "prices" && (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="price-action"
                  className="mb-1 block text-sm font-medium"
                >
                  Action
                </label>
                <select
                  id="price-action"
                  value={priceAction}
                  onChange={(e) =>
                    setPriceAction(e.target.value as typeof priceAction)
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="snapshot">Capture Snapshot</option>
                  <option value="compare">Compare Snapshots</option>
                  <option value="history">View History</option>
                  <option value="list">List Monitored URLs</option>
                </select>
              </div>
              {priceAction === "snapshot" && (
                <>
                  <div>
                    <label
                      htmlFor="price-label"
                      className="mb-1 block text-sm font-medium"
                    >
                      Label (optional)
                    </label>
                    <input
                      id="price-label"
                      type="text"
                      value={priceLabel}
                      onChange={(e) => setPriceLabel(e.target.value)}
                      placeholder="e.g. Competitor Pro Plan"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={scrollToLoad}
                      onChange={(e) => setScrollToLoad(e.target.checked)}
                      className="rounded border-input"
                    />
                    Scroll to load dynamic content
                  </label>
                </>
              )}
            </div>
          )}

          {/* ── Dataset fields ─── */}
          {mode === "dataset" && (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="dataset-format"
                  className="mb-1 block text-sm font-medium"
                >
                  Output Format
                </label>
                <select
                  id="dataset-format"
                  value={datasetFormat}
                  onChange={(e) =>
                    setDatasetFormat(e.target.value as typeof datasetFormat)
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="markdown">Markdown</option>
                  <option value="jsonl">JSONL</option>
                  <option value="csv">CSV</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="include-paths"
                  className="mb-1 block text-sm font-medium"
                >
                  Include paths (comma-separated)
                </label>
                <input
                  id="include-paths"
                  type="text"
                  value={includePaths}
                  onChange={(e) => setIncludePaths(e.target.value)}
                  placeholder="/docs, /blog"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label
                  htmlFor="exclude-paths"
                  className="mb-1 block text-sm font-medium"
                >
                  Exclude paths (comma-separated)
                </label>
                <input
                  id="exclude-paths"
                  type="text"
                  value={excludePaths}
                  onChange={(e) => setExcludePaths(e.target.value)}
                  placeholder="/admin, /login"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          )}

          {/* Model picker */}
          <div>
            <label className="mb-1 block text-sm font-medium">Model</label>
            <InlineModelPicker value={model} onChange={setModel} />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={
              submitting ||
              (isFirecrawlMode &&
                !firecrawlHealth.available &&
                !firecrawlHealth.checking)
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting || firecrawlHealth.checking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Globe className="h-4 w-4" />
            )}
            {getSubmitLabel(mode)}
          </button>
        </div>
      </div>

      <CrawlProgressPanel />

      <Tabs defaultValue="overview" className="mt-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview" className="gap-1.5">
            <Search className="h-3.5 w-3.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Audit
          </TabsTrigger>
          <TabsTrigger value="links" className="gap-1.5">
            <Link2 className="h-3.5 w-3.5" /> Links
          </TabsTrigger>
          <TabsTrigger value="content" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" /> Content
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-1.5">
            <Gauge className="h-3.5 w-3.5" /> Performance
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> History
          </TabsTrigger>
          <TabsTrigger value="export" className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> Export
          </TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-6">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <BarChart3 className="h-4 w-4" /> Health Score
              </h3>
              <SiteHealthScore snapshot={latest} />
            </div>

            <div className="rounded-xl border bg-card p-6">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <History className="h-4 w-4" /> Recent Trends
              </h3>
              <AuditTrends siteUrl={latest?.siteUrl} />
            </div>
          </div>

          {latest && (
            <div className="mt-6 rounded-xl border bg-card p-6">
              <h3 className="text-sm font-semibold mb-3">
                Latest Audit Details
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Stat label="Pages Audited" value={latest.pagesAudited} />
                <Stat label="Total Issues" value={latest.totalIssues} />
                <Stat
                  label="Critical"
                  value={latest.critical}
                  color="text-red-500"
                />
                <Stat
                  label="High"
                  value={latest.high}
                  color="text-orange-500"
                />
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── Audit (results detail) ───────────────────────────── */}
        <TabsContent value="audit" className="mt-6">
          {latestData?.pages && latestData.pages.length > 0 ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">
                Audit Results — {latest?.siteUrl}
              </h3>
              {(["error", "warning", "info"] as const).map((severity) => {
                const pagesWithIssues = latestData.pages!.filter((p) =>
                  p.issues.some((i) => i.severity === severity),
                );
                if (pagesWithIssues.length === 0) return null;
                return (
                  <div key={severity} className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5">
                      <SeverityDot severity={severity} />
                      {severity === "error"
                        ? "Errors"
                        : severity === "warning"
                          ? "Warnings"
                          : "Info"}{" "}
                      (
                      {pagesWithIssues.reduce(
                        (acc, p) =>
                          acc +
                          p.issues.filter((i) => i.severity === severity)
                            .length,
                        0,
                      )}
                      )
                    </h4>
                    {pagesWithIssues.map((page) => (
                      <div
                        key={page.url}
                        className="rounded-lg border bg-card p-3"
                      >
                        <p className="text-sm font-medium truncate">
                          {page.url}
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {page.issues
                            .filter((i) => i.severity === severity)
                            .map((issue, idx) => (
                              <li
                                key={idx}
                                className="text-xs text-muted-foreground"
                              >
                                [{issue.category}] {issue.message}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState message="No audit results yet. Run an audit to see detailed findings." />
          )}
        </TabsContent>

        {/* ── Links ────────────────────────────────────────────── */}
        <TabsContent value="links" className="mt-6">
          {latestData?.linkAnalysis ? (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                <StatCard
                  label="Total Links"
                  value={latestData.linkAnalysis.totalLinks}
                />
                <StatCard
                  label="Broken Links"
                  value={latestData.linkAnalysis.brokenLinks?.length ?? 0}
                  color="text-red-500"
                />
                <StatCard
                  label="Orphan Pages"
                  value={latestData.linkAnalysis.orphanPages?.length ?? 0}
                  color="text-orange-500"
                />
              </div>

              {latestData.linkAnalysis.brokenLinks &&
                latestData.linkAnalysis.brokenLinks.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Broken Links</h4>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">
                              Source
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Target
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Text
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Status
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {latestData.linkAnalysis.brokenLinks.map(
                            (link, idx) => (
                              <tr key={idx} className="border-t">
                                <td className="px-3 py-2 truncate max-w-[200px]">
                                  {link.sourceUrl}
                                </td>
                                <td className="px-3 py-2 truncate max-w-[200px]">
                                  {link.targetUrl}
                                </td>
                                <td className="px-3 py-2 truncate max-w-[120px]">
                                  {link.anchorText}
                                </td>
                                <td className="px-3 py-2 text-red-500 font-medium">
                                  {link.statusCode}
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

              {latestData.linkAnalysis.redirectChains &&
                latestData.linkAnalysis.redirectChains.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Redirect Chains
                    </h4>
                    <div className="space-y-1">
                      {latestData.linkAnalysis.redirectChains.map(
                        (chain, idx) => (
                          <div
                            key={idx}
                            className="text-xs bg-card border rounded-lg px-3 py-2"
                          >
                            {chain.chain?.join(" → ") ?? JSON.stringify(chain)}
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                )}

              {latestData.linkAnalysis.orphanPages &&
                latestData.linkAnalysis.orphanPages.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Orphan Pages</h4>
                    <ul className="space-y-1">
                      {latestData.linkAnalysis.orphanPages.map((url, idx) => (
                        <li
                          key={idx}
                          className="text-xs bg-card border rounded-lg px-3 py-2 truncate"
                        >
                          {typeof url === "string" ? url : JSON.stringify(url)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              <div>
                <h4 className="text-sm font-semibold mb-2">Link Graph</h4>
                <LinkGraph linkAnalysis={latestData.linkAnalysis} />
              </div>
            </div>
          ) : (
            <EmptyState message="No link analysis data. Run an audit to analyze your site's link structure." />
          )}
        </TabsContent>

        {/* ── Content ──────────────────────────────────────────── */}
        <TabsContent value="content" className="mt-6">
          {latestData?.contentAnalysis ? (
            <div className="space-y-6">
              {latestData.contentAnalysis.duplicateGroups &&
              latestData.contentAnalysis.duplicateGroups.length > 0 ? (
                <div>
                  <h4 className="text-sm font-semibold mb-2">
                    Duplicate Content Groups
                  </h4>
                  <div className="space-y-2">
                    {latestData.contentAnalysis.duplicateGroups.map(
                      (group, idx) => (
                        <div
                          key={idx}
                          className="rounded-lg border bg-card p-3"
                        >
                          <p className="text-xs font-medium text-orange-500 mb-1">
                            Group {idx + 1} — {group.urls?.length ?? 0} pages
                          </p>
                          <ul className="space-y-0.5">
                            {(group.urls ?? []).map(
                              (url: string, i: number) => (
                                <li
                                  key={i}
                                  className="text-xs text-muted-foreground truncate"
                                >
                                  {url}
                                </li>
                              ),
                            )}
                          </ul>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No duplicate content detected.
                </p>
              )}

              {latestData.contentAnalysis.thinContentPages &&
              latestData.contentAnalysis.thinContentPages.length > 0 ? (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Thin Content</h4>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">
                            URL
                          </th>
                          <th className="px-3 py-2 text-left font-medium">
                            Word Count
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {latestData.contentAnalysis.thinContentPages.map(
                          (page, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="px-3 py-2 truncate max-w-[300px]">
                                {typeof page === "string"
                                  ? page
                                  : (page.url ?? JSON.stringify(page))}
                              </td>
                              <td className="px-3 py-2 text-orange-500">
                                {typeof page === "object" && page.wordCount
                                  ? page.wordCount
                                  : "—"}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No thin content pages detected.
                </p>
              )}
            </div>
          ) : (
            <EmptyState message="No content analysis data. Run an audit to check for duplicate and thin content." />
          )}
        </TabsContent>

        {/* ── Performance (CWV) ────────────────────────────────── */}
        <TabsContent value="performance" className="mt-6">
          {latestData?.coreWebVitals && latestData.coreWebVitals.length > 0 ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Core Web Vitals</h3>
              {latestData.coreWebVitals.map((cwv, idx) => (
                <div key={idx} className="rounded-lg border bg-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium truncate flex-1">
                      {cwv.url}
                    </p>
                    <span className="text-lg font-bold ml-3">
                      {cwv.performanceScore}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {(cwv.metrics ?? []).map((m) => (
                      <div key={m.name} className="text-xs">
                        <span className="font-medium">{m.name}</span>
                        <span className="ml-1 text-muted-foreground">
                          {m.value}
                          {m.unit}
                        </span>
                        <CwvRatingBadge rating={m.rating} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message="No Core Web Vitals data. Run an audit with performance analysis enabled." />
          )}
        </TabsContent>

        {/* ── History ──────────────────────────────────────────── */}
        <TabsContent value="history" className="mt-6">
          <AuditTrends />
        </TabsContent>

        {/* ── Export ───────────────────────────────────────────── */}
        <TabsContent value="export" className="mt-6">
          <div className="rounded-xl border bg-card p-6 space-y-4">
            {history && history.length > 0 ? (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Select Audit</label>
                  <select
                    value={selectedId ?? ""}
                    onChange={(e) =>
                      setSelectedId(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Choose an audit…</option>
                    {history.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.siteUrl} — Score {s.healthScore} —{" "}
                        {new Date(s.createdAt).toLocaleDateString()}
                      </option>
                    ))}
                  </select>
                </div>
                <ExportDialog snapshotId={selectedId} />
              </>
            ) : (
              <ExportDialog snapshotId={null} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}

// ── Helper Components ────────────────────────────────────────────────────

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold ${color ?? ""}`}>{value}</p>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color ?? ""}`}>{value}</p>
    </div>
  );
}

function SeverityDot({ severity }: { severity: string }) {
  const color =
    severity === "error"
      ? "bg-red-500"
      : severity === "warning"
        ? "bg-yellow-500"
        : "bg-blue-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function CwvRatingBadge({ rating }: { rating: string }) {
  const colors: Record<string, string> = {
    good: "text-green-600 bg-green-50",
    "needs-improvement": "text-yellow-600 bg-yellow-50",
    poor: "text-red-600 bg-red-50",
  };
  return (
    <span
      className={`ml-1.5 inline-block rounded px-1 py-0.5 text-[10px] font-medium ${colors[rating] ?? "text-muted-foreground bg-muted"}`}
    >
      {rating}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 text-center">
      <AlertTriangle className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function getSubmitLabel(mode: SeoMode): string {
  switch (mode) {
    case "site-audit":
      return "Run Audit";
    case "gap-analysis":
      return "Analyze";
    case "competitors":
      return "Execute";
    case "extract":
      return "Extract Data";
    case "leads":
      return "Find Leads";
    case "prices":
      return "Monitor Prices";
    case "dataset":
      return "Build Dataset";
    case "ingest":
      return "Start Ingestion";
  }
}

function safeParseDataJson(json: string | undefined): SeoData | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
