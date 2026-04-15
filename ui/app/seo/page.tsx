"use client";

export const dynamic = "force-dynamic";

import { useState, useCallback, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSeoHistory } from "@/hooks/useSeoHistory";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-context";
import { CrawlProgressPanel } from "@/components/seo/crawl-progress-panel";
import { SiteHealthScore } from "@/components/seo/site-health-score";
import { AuditTrends } from "@/components/seo/audit-trends";
import { ExportDialog } from "@/components/seo/export-dialog";
import { LinkGraph } from "@/components/seo/link-graph";
import { ActivityLog } from "@/components/seo/activity-log";
import { SchemaGeneratorPanel } from "@/components/seo/schema-generator-panel";
import { MetaGeneratorPanel } from "@/components/seo/meta-generator-panel";
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
  Calendar,
  Plus,
  Power,
  Trash2,
  ExternalLink,
  Wand2,
  Code2,
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
  internalLinks?: number;
  externalLinks?: number;
  brokenLinks?: BrokenLink[];
  orphanPages?: (string | Record<string, unknown>)[];
  redirectChains?: RedirectChain[];
  linkDepths?: Array<{ url: string; depth: number }>;
  links?: { source: string; target: string }[];
  nodes?: { id: string; issues?: number }[];
  linkDistribution?: Array<{
    url: string;
    incomingCount: number;
    outgoingCount: number;
  }>;
  linkingSuggestions?: Array<{
    sourcePage: string;
    targetPage: string;
    suggestedAnchor: string;
    reason: string;
    priority: string;
  }>;
}

interface DuplicateGroup {
  urls?: string[];
  similarity?: number;
  recommendation?: string;
}

interface ThinContentPage {
  url?: string;
  wordCount?: number;
}

interface ContentAnalysis {
  duplicateGroups?: DuplicateGroup[];
  thinContentPages?: (string | ThinContentPage)[];
  keywordDensity?: Array<{
    url: string;
    keyword: string;
    count: number;
    density: number;
  }>;
  freshness?: Array<{
    url: string;
    freshnessRating: string;
    ageInDays: number | null;
    dateModified?: string;
    datePublished?: string;
  }>;
  paaQuestions?: string[];
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
  optimizations?: Array<{
    auditId: string;
    title: string;
    description: string;
    score: number;
    savingsMs: number | null;
    savingsBytes: number | null;
    category: "opportunity" | "diagnostic";
  }>;
  fetchedAt?: string;
  strategy?: "mobile" | "desktop";
  error?: string;
}

// Metric definitions with thresholds and formatters
const CWV_METRIC_DEFS: Array<{
  name: string;
  label: string;
  hint: string;
  format: (v: number) => string;
}> = [
  {
    name: "LCP",
    label: "Largest Contentful Paint",
    hint: "Good < 2.5 s",
    format: (v) => `${(v / 1000).toFixed(1)} s`,
  },
  {
    name: "FCP",
    label: "First Contentful Paint",
    hint: "Good < 1.8 s",
    format: (v) => `${(v / 1000).toFixed(1)} s`,
  },
  {
    name: "TBT",
    label: "Total Blocking Time",
    hint: "Good < 200 ms",
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    name: "CLS",
    label: "Cumulative Layout Shift",
    hint: "Good < 0.1",
    format: (v) => v.toFixed(3),
  },
  {
    name: "SI",
    label: "Speed Index",
    hint: "Good < 3.4 s",
    format: (v) => `${(v / 1000).toFixed(1)} s`,
  },
  {
    name: "TTI",
    label: "Time to Interactive",
    hint: "Good < 3.8 s",
    format: (v) => `${(v / 1000).toFixed(1)} s`,
  },
];

interface SeoData {
  pages?: AuditPage[];
  linkAnalysis?: LinkAnalysis;
  contentAnalysis?: ContentAnalysis;
  coreWebVitals?: CwvEntry[];
  issues?: Array<{
    severity: string;
    category: string;
    message: string;
    url?: string;
  }>;
  categoryStats?: Array<{
    category: string;
    affectedCount: number;
    percentage: number;
  }>;
  healthScore?: { score: number; rating: string };
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

  // ── Results data (leads / prices / competitors) ──
  const { data: leadsData, refetch: refetchLeads } = useQuery<
    Array<{
      domain: string;
      files: Array<{ name: string; capturedAt: string; sizeBytes: number }>;
    }>
  >({
    queryKey: ["seo-leads"],
    queryFn: () => fetchJson("/api/seo/leads"),
    staleTime: 30_000,
  });
  const { data: pricesData, refetch: refetchPrices } = useQuery<
    Array<{
      url: string;
      label: string | null;
      snapshotCount: number;
      lastCapture: string;
    }>
  >({
    queryKey: ["seo-prices"],
    queryFn: () => fetchJson("/api/seo/prices"),
    staleTime: 30_000,
  });
  const { data: competitorsData, refetch: refetchCompetitors } = useQuery<
    Array<{
      url: string;
      name: string | null;
      addedAt: string;
      lastSnapshotAt: string | null;
    }>
  >({
    queryKey: ["seo-competitors"],
    queryFn: () => fetchJson("/api/seo/competitors"),
    staleTime: 30_000,
  });

  // ── Shared form fields ──
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(3);
  const [model, setModel] = useState("");

  // ── Gap Analysis fields ──
  const [targetKeyword, setTargetKeyword] = useState("");
  const [searchProvider, setSearchProvider] = useState("auto");
  const [orchestrationMode, setOrchestrationMode] =
    useState<OrchestrationMode>("session");
  const [exportPdf, setExportPdf] = useState(true);

  // ── Ingest fields ──
  const [category, setCategory] = useState("document");
  const [visibility, setVisibility] = useState("internal");

  // ── Competitors fields ──
  const [monitorAction, setMonitorAction] = useState<
    "add" | "snapshot" | "report" | "list" | "discover"
  >("add");
  const [competitorName, setCompetitorName] = useState("");

  // ── Competitor discovery state ──
  const [discoveredCompetitors, setDiscoveredCompetitors] = useState<
    Array<{
      domain: string;
      url: string;
      title: string;
      snippet: string;
      bestPosition: number;
      keywordsFound: string[];
      frequencyScore: number;
    }>
  >([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryRequiresKey, setDiscoveryRequiresKey] = useState(false);
  const [selectedDiscovered, setSelectedDiscovered] = useState<Set<string>>(
    new Set(),
  );
  const [isAddingBulk, setIsAddingBulk] = useState(false);

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

  // ── Leads export fields ──
  const [leadsOutputType, setLeadsOutputType] = useState<
    "" | "airtable" | "sheets"
  >("" as "" | "airtable" | "sheets");
  const [leadsAirtableBase, setLeadsAirtableBase] = useState("");
  const [leadsAirtableTable, setLeadsAirtableTable] = useState("Leads");
  const [leadsSheetsId, setLeadsSheetsId] = useState("");
  const [leadsSheetsRange, setLeadsSheetsRange] = useState("Sheet1");

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

  // ── Core Web Vitals on-demand analysis ──
  const [cwvAnalyzing, setCwvAnalyzing] = useState(false);
  const [cwvError, setCwvError] = useState<string | null>(null);

  // ── Schedule Audit (inline near Run Audit) ──
  const [showScheduleInline, setShowScheduleInline] = useState(false);
  const [scheduleFrequency, setScheduleFrequency] = useState("weekly");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleCreating, setScheduleCreating] = useState(false);

  const scheduleCronMap: Record<string, string> = {
    daily: "0 6 * * *",
    weekly: "0 6 * * 1",
    monthly: "0 6 1 * *",
  };

  const handleScheduleCreate = useCallback(async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setScheduleError("Enter a site URL first");
      return;
    }
    try {
      new URL(
        trimmedUrl.startsWith("http") ? trimmedUrl : `https://${trimmedUrl}`,
      );
    } catch {
      setScheduleError("Please enter a valid URL");
      return;
    }
    const normalizedUrl = trimmedUrl.startsWith("http")
      ? trimmedUrl
      : `https://${trimmedUrl}`;
    setScheduleError(null);
    setScheduleCreating(true);
    try {
      await fetchJson("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `SEO Audit — ${new URL(normalizedUrl).hostname}`,
          cronExpression: scheduleCronMap[scheduleFrequency],
          actionType: "prompt",
          actionPayload: {
            promptName: "seo-site-audit",
            variables: { url: normalizedUrl },
          },
          allowedTools: [
            "seo-site-audit",
            "firecrawl-crawl",
            "firecrawl-scrape",
          ],
          enabled: true,
        }),
      });
      setShowScheduleInline(false);
      setScheduleError(null);
      queryClient.invalidateQueries({ queryKey: ["seo-scheduled-jobs"] });
    } catch (err) {
      setScheduleError(
        err instanceof Error ? err.message : "Failed to create schedule",
      );
    } finally {
      setScheduleCreating(false);
    }
  }, [url, scheduleFrequency, scheduleCronMap, queryClient]);

  const runCwvAnalysis = useCallback(async () => {
    if (!latest?.id) return;
    setCwvAnalyzing(true);
    setCwvError(null);
    try {
      const result = await fetchJson<{
        results: unknown[];
        urlsAnalyzed: number;
      }>("/api/seo/cwv", {
        method: "POST",
        body: JSON.stringify({ snapshotId: latest.id, maxUrls: 5, dual: true }),
      });
      if (result.urlsAnalyzed === 0) {
        setCwvError("No pages analyzed. The snapshot may have no page data.");
      } else {
        queryClient.invalidateQueries({ queryKey: ["seo-history"] });
      }
    } catch (err) {
      setCwvError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setCwvAnalyzing(false);
    }
  }, [latest?.id, queryClient]);

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

  // ── Competitor discovery handlers ──
  const handleDiscover = useCallback(async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError("URL is required");
      return;
    }
    setError(null);
    setDiscoveryError(null);
    setIsDiscovering(true);
    setDiscoveredCompetitors([]);
    setDiscoveryRequiresKey(false);
    setSelectedDiscovered(new Set());

    try {
      const result = await fetchJson<{
        targetDomain: string;
        keywordsSearched: string[];
        competitors: Array<{
          domain: string;
          url: string;
          title: string;
          snippet: string;
          bestPosition: number;
          keywordsFound: string[];
          frequencyScore: number;
        }>;
        serpFeatures: { paa: string[]; relatedSearches: string[] };
        requiresApiKey: boolean;
        error?: string;
      }>("/api/seo/competitors/discover", {
        method: "POST",
        body: JSON.stringify({ url: trimmedUrl }),
      });

      if (result.error) {
        setDiscoveryError(result.error);
        return;
      }

      if (result.requiresApiKey) {
        setDiscoveryRequiresKey(true);
        return;
      }

      setDiscoveredCompetitors(result.competitors);
    } catch (err) {
      setDiscoveryError(
        err instanceof Error ? err.message : "Discovery failed",
      );
    } finally {
      setIsDiscovering(false);
    }
  }, [url]);

  const handleAddBulkCompetitors = useCallback(async () => {
    if (selectedDiscovered.size === 0) return;
    setIsAddingBulk(true);
    try {
      const items = discoveredCompetitors
        .filter((c) => selectedDiscovered.has(c.domain))
        .map((c) => ({ url: c.url, name: c.domain }));

      await fetchJson("/api/seo/competitors/add-bulk", {
        method: "POST",
        body: JSON.stringify({ competitors: items }),
      });

      setSelectedDiscovered(new Set());
      void refetchCompetitors();
    } catch (err) {
      setDiscoveryError(
        err instanceof Error ? err.message : "Failed to add competitors",
      );
    } finally {
      setIsAddingBulk(false);
    }
  }, [selectedDiscovered, discoveredCompetitors, refetchCompetitors]);

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

    // Discover action uses REST API, not Socket.IO chat
    if (mode === "competitors" && monitorAction === "discover") {
      handleDiscover();
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
        prompt = buildLeadPrompt(
          url,
          maxPages,
          leadsOutputType === "airtable" && leadsAirtableBase
            ? {
                type: "airtable" as const,
                baseId: leadsAirtableBase,
                tableIdOrName: leadsAirtableTable,
              }
            : leadsOutputType === "sheets" && leadsSheetsId
              ? {
                  type: "sheets" as const,
                  spreadsheetId: leadsSheetsId,
                  range: leadsSheetsRange,
                }
              : undefined,
        );
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

    // submitting stays true — cleared by handleOperationComplete
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
    handleDiscover,
  ]);

  const handleOperationComplete = useCallback(() => {
    setSubmitting(false);
    queryClient.invalidateQueries({ queryKey: ["seo-history"] });
    // Refresh mode-specific data panels
    void refetchLeads();
    void refetchPrices();
    void refetchCompetitors();
  }, [queryClient, refetchLeads, refetchPrices, refetchCompetitors]);

  // Listen for socket events that indicate operation completion
  useEffect(() => {
    if (!socket) return;
    if (!submitting) return;

    const onEnd = () => handleOperationComplete();
    const onResponse = () => handleOperationComplete();
    const onError = () => handleOperationComplete();

    socket.on("chat:stream:end", onEnd);
    socket.on("chat:response", onResponse);
    socket.on("chat:error", onError);

    return () => {
      socket.off("chat:stream:end", onEnd);
      socket.off("chat:response", onResponse);
      socket.off("chat:error", onError);
    };
  }, [socket, submitting, handleOperationComplete]);

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
                  <option value="discover">Discover</option>
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

          {/* ── Leads export ─── */}
          {mode === "leads" && (
            <div className="rounded-md border border-input p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Export results to (optional)
              </p>
              <div className="flex gap-2">
                {(["", "airtable", "sheets"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setLeadsOutputType(t)}
                    className={`text-xs px-2.5 py-1 rounded border ${leadsOutputType === t ? "bg-primary text-primary-foreground border-primary" : "border-input hover:bg-muted"}`}
                  >
                    {t === ""
                      ? "None"
                      : t === "airtable"
                        ? "Airtable"
                        : "Google Sheets"}
                  </button>
                ))}
              </div>
              {leadsOutputType === "airtable" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Base ID
                    </label>
                    <input
                      value={leadsAirtableBase}
                      onChange={(e) => setLeadsAirtableBase(e.target.value)}
                      placeholder="appXXXXXX"
                      className="mt-0.5 w-full rounded border border-input bg-background px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Table name
                    </label>
                    <input
                      value={leadsAirtableTable}
                      onChange={(e) => setLeadsAirtableTable(e.target.value)}
                      placeholder="Leads"
                      className="mt-0.5 w-full rounded border border-input bg-background px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
              )}
              {leadsOutputType === "sheets" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Spreadsheet ID
                    </label>
                    <input
                      value={leadsSheetsId}
                      onChange={(e) => setLeadsSheetsId(e.target.value)}
                      placeholder="1ABC..."
                      className="mt-0.5 w-full rounded border border-input bg-background px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Range
                    </label>
                    <input
                      value={leadsSheetsRange}
                      onChange={(e) => setLeadsSheetsRange(e.target.value)}
                      placeholder="Sheet1"
                      className="mt-0.5 w-full rounded border border-input bg-background px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
              )}
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
          <div className="flex items-center gap-2">
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
              {submitting ? "Processing…" : getSubmitLabel(mode)}
            </button>

            {mode === "site-audit" && (
              <button
                type="button"
                onClick={() => setShowScheduleInline(!showScheduleInline)}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
              >
                <Calendar className="h-4 w-4" />
                Schedule Audit
              </button>
            )}
          </div>

          {/* Inline schedule form */}
          {showScheduleInline && mode === "site-audit" && (
            <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
              <p className="text-xs font-medium">
                Schedule recurring audit for{" "}
                <span className="font-semibold">
                  {url.trim() || "(enter URL above)"}
                </span>
              </p>
              <div>
                <label className="text-xs font-medium">Frequency</label>
                <select
                  value={scheduleFrequency}
                  onChange={(e) => setScheduleFrequency(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                >
                  <option value="daily">Daily (6:00 AM)</option>
                  <option value="weekly">Weekly (Monday 6:00 AM)</option>
                  <option value="monthly">Monthly (1st, 6:00 AM)</option>
                </select>
              </div>
              {scheduleError && (
                <p className="text-xs text-red-500">{scheduleError}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowScheduleInline(false);
                    setScheduleError(null);
                  }}
                  className="rounded-md border px-3 py-1 text-xs hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleScheduleCreate}
                  disabled={scheduleCreating}
                  className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {scheduleCreating ? "Creating…" : "Create Schedule"}
                </button>
              </div>
            </div>
          )}

          {/* Persistent loading indicator */}
          {submitting && (
            <div className="flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
              <Loader2 className="h-4 w-4 animate-spin text-blue-500 shrink-0" />
              <p className="text-sm text-blue-700 dark:text-blue-400">
                Running{" "}
                {MODES.find((m) => m.key === mode)?.label?.toLowerCase() ??
                  "operation"}
                … This may take a few minutes.
              </p>
            </div>
          )}
        </div>
      </div>

      <CrawlProgressPanel />
      <ActivityLog active={submitting} onComplete={handleOperationComplete} />

      {/* ── Leads results panel ─────────────────────────────────────── */}
      {mode === "leads" && (
        <div className="mt-4 rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4" /> Lead Extractions
            </h3>
            <button
              type="button"
              onClick={() => void refetchLeads()}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Refresh
            </button>
          </div>
          {!leadsData || leadsData.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No lead extractions yet. Run &quot;Find Leads&quot; to extract
              contacts.
            </p>
          ) : (
            <div className="space-y-3">
              {leadsData.map((domain) => (
                <div
                  key={domain.domain}
                  className="rounded-md border bg-muted/20 p-3"
                >
                  <p className="text-xs font-medium mb-2">{domain.domain}</p>
                  <div className="space-y-1">
                    {domain.files.map((f) => (
                      <div
                        key={f.name}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-xs text-muted-foreground truncate flex-1">
                          {new Date(f.capturedAt).toLocaleString()} —{" "}
                          {Math.round(f.sizeBytes / 1024)} KB
                        </span>
                        <a
                          href={`/api/seo/leads/${encodeURIComponent(domain.domain)}/${encodeURIComponent(f.name)}`}
                          download={f.name}
                          className="text-xs text-primary hover:underline flex items-center gap-0.5 flex-shrink-0"
                        >
                          <Download className="h-3 w-3" /> Download
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            Raw scraped content only — the AI-extracted contacts appear in the
            chat above.
          </p>
        </div>
      )}

      {/* ── Prices results panel ─────────────────────────────────────── */}
      {mode === "prices" && (
        <div className="mt-4 rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <DollarSign className="h-4 w-4" /> Monitored Price URLs
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refetchPrices()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Refresh
              </button>
              {pricesData && pricesData.length > 0 && (
                <a
                  href="/api/seo/prices/export.csv"
                  download="price-monitors.csv"
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  <Download className="h-3 w-3" /> Export CSV
                </a>
              )}
            </div>
          </div>
          {!pricesData || pricesData.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No price snapshots yet. Use &quot;Capture Snapshot&quot; to start
              monitoring.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-1.5 pr-3 font-medium">URL / Label</th>
                    <th className="pb-1.5 pr-3 font-medium text-right">
                      Snapshots
                    </th>
                    <th className="pb-1.5 font-medium">Last Captured</th>
                  </tr>
                </thead>
                <tbody>
                  {pricesData.map((r) => (
                    <tr key={r.url} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">
                        <p className="truncate max-w-[260px]">{r.url}</p>
                        {r.label && (
                          <p className="text-muted-foreground">{r.label}</p>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-medium">
                        {r.snapshotCount}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {new Date(r.lastCapture).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Competitors results panel ────────────────────────────────── */}
      {mode === "competitors" && (
        <div className="mt-4 rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Tracked Competitors
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refetchCompetitors()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Refresh
              </button>
              {competitorsData && competitorsData.length > 0 && (
                <a
                  href="/api/seo/competitors/export.csv"
                  download="competitors.csv"
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  <Download className="h-3 w-3" /> Export CSV
                </a>
              )}
            </div>
          </div>
          {!competitorsData || competitorsData.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No competitors tracked yet. Use &quot;Add Competitor&quot; to
              start monitoring.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-1.5 pr-3 font-medium">Competitor</th>
                    <th className="pb-1.5 pr-3 font-medium">Added</th>
                    <th className="pb-1.5 font-medium">Last Snapshot</th>
                  </tr>
                </thead>
                <tbody>
                  {competitorsData.map((c) => (
                    <tr key={c.url} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">
                        <p className="truncate max-w-[260px]">{c.url}</p>
                        {c.name && (
                          <p className="text-muted-foreground">{c.name}</p>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {new Date(c.addedAt).toLocaleDateString()}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {c.lastSnapshotAt ? (
                          new Date(c.lastSnapshotAt).toLocaleDateString()
                        ) : (
                          <span className="italic">Never</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Competitor Discovery Results ───────────────────────────── */}
      {mode === "competitors" && monitorAction === "discover" && (
        <div className="mt-4 rounded-lg border bg-card p-4 space-y-3">
          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Competitor discovery searches Google/Brave for your site&apos;s
              top keywords. Requires a Serper.dev API key (SERPER_API_KEY) or
              Brave Search API key (BRAVE_API_KEY).
            </span>
          </div>

          {isDiscovering && (
            <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Discovering competitors…
            </div>
          )}

          {discoveryRequiresKey && !isDiscovering && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                No search API key configured. Add SERPER_API_KEY or
                BRAVE_API_KEY in your environment variables.
              </span>
            </div>
          )}

          {discoveryError && !isDiscovering && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{discoveryError}</span>
            </div>
          )}

          {discoveredCompetitors.length > 0 && !isDiscovering && (
            <>
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">
                  Discovered Competitors ({discoveredCompetitors.length})
                </h4>
                <button
                  type="button"
                  disabled={selectedDiscovered.size === 0 || isAddingBulk}
                  onClick={() => void handleAddBulkCompetitors()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isAddingBulk ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  Add Selected to Monitoring
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-1.5 pr-2 font-medium w-8">
                        <input
                          type="checkbox"
                          checked={
                            selectedDiscovered.size ===
                            discoveredCompetitors.length
                          }
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedDiscovered(
                                new Set(
                                  discoveredCompetitors.map((c) => c.domain),
                                ),
                              );
                            } else {
                              setSelectedDiscovered(new Set());
                            }
                          }}
                          className="rounded border-input"
                        />
                      </th>
                      <th className="pb-1.5 pr-3 font-medium">Domain</th>
                      <th className="pb-1.5 pr-3 font-medium">Best Rank</th>
                      <th className="pb-1.5 pr-3 font-medium">Keywords</th>
                      <th className="pb-1.5 font-medium">Frequency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discoveredCompetitors.map((c) => (
                      <tr key={c.domain} className="border-b last:border-0">
                        <td className="py-1.5 pr-2">
                          <input
                            type="checkbox"
                            checked={selectedDiscovered.has(c.domain)}
                            onChange={(e) => {
                              const next = new Set(selectedDiscovered);
                              if (e.target.checked) {
                                next.add(c.domain);
                              } else {
                                next.delete(c.domain);
                              }
                              setSelectedDiscovered(next);
                            }}
                            className="rounded border-input"
                          />
                        </td>
                        <td className="py-1.5 pr-3">
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline flex items-center gap-1"
                          >
                            {c.domain}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </td>
                        <td className="py-1.5 pr-3 text-center">
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                            #{c.bestPosition}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {c.keywordsFound.slice(0, 3).map((kw) => (
                              <span
                                key={kw}
                                className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                              >
                                {kw}
                              </span>
                            ))}
                            {c.keywordsFound.length > 3 && (
                              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                +{c.keywordsFound.length - 3} more
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 text-center font-medium">
                          {c.frequencyScore}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!isDiscovering &&
            !discoveryError &&
            !discoveryRequiresKey &&
            discoveredCompetitors.length === 0 && (
              <p className="text-xs text-muted-foreground py-4 text-center">
                Enter a website URL and click Execute to discover competitors
                from your latest audit data.
              </p>
            )}
        </div>
      )}

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
          <TabsTrigger value="schema" className="gap-1.5">
            <Code2 className="h-3.5 w-3.5" /> Schema
          </TabsTrigger>
          <TabsTrigger value="meta-gen" className="gap-1.5">
            <Wand2 className="h-3.5 w-3.5" /> Meta Gen
          </TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────── */}
        <TabsContent
          value="overview"
          className="mt-6 overflow-y-auto max-h-[calc(100vh-20rem)]"
        >
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
        <TabsContent
          value="audit"
          className="mt-6 overflow-y-auto max-h-[calc(100vh-20rem)]"
        >
          {(latestData?.pages && latestData.pages.length > 0) ||
          (latestData?.issues && latestData.issues.length > 0) ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">
                Audit Results — {latest?.siteUrl}
              </h3>

              {/* Category Stats */}
              {latestData.categoryStats &&
                latestData.categoryStats.length > 0 && (
                  <div className="rounded-xl border bg-card p-4">
                    <h4 className="text-xs font-semibold uppercase tracking-wide mb-3">
                      Issue Categories
                    </h4>
                    <div className="space-y-2">
                      {latestData.categoryStats.map((cat) => (
                        <div
                          key={cat.category}
                          className="flex items-center gap-3"
                        >
                          <span className="text-xs font-medium w-28 truncate capitalize">
                            {cat.category}
                          </span>
                          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{
                                width: `${Math.min(cat.percentage, 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-24 text-right">
                            {cat.affectedCount} pages ({cat.percentage}%)
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* Site-Wide Issues */}
              {latestData.issues && latestData.issues.length > 0 && (
                <div className="rounded-xl border bg-card p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide mb-3">
                    Site-Wide Issues ({latestData.issues.length})
                  </h4>
                  {(["error", "warning", "info"] as const).map((sev) => {
                    const filtered = latestData.issues!.filter(
                      (i) => i.severity === sev,
                    );
                    if (filtered.length === 0) return null;
                    return (
                      <div key={sev} className="mb-3 last:mb-0">
                        <h5 className="text-xs font-semibold flex items-center gap-1.5 mb-1">
                          <SeverityDot severity={sev} />
                          {sev === "error"
                            ? "Errors"
                            : sev === "warning"
                              ? "Warnings"
                              : "Info"}{" "}
                          ({filtered.length})
                        </h5>
                        <ul className="space-y-1 ml-3.5">
                          {filtered.map((issue, idx) => (
                            <li
                              key={idx}
                              className="text-xs text-muted-foreground"
                            >
                              <span className="font-medium capitalize">
                                [{issue.category}]
                              </span>{" "}
                              {issue.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Per-Page Issues */}
              {latestData.pages &&
                latestData.pages.length > 0 &&
                (["error", "warning", "info"] as const).map((severity) => {
                  const pagesWithIssues = latestData.pages!.filter((p) =>
                    p.issues.some((i) => i.severity === severity),
                  );
                  if (pagesWithIssues.length === 0) return null;
                  const totalPages = latestData.pages!.length;
                  const percentAffected =
                    totalPages > 0
                      ? Math.round((pagesWithIssues.length / totalPages) * 100)
                      : 0;
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
                        <span
                          className={cn(
                            "ml-1.5 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                            severity === "error"
                              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                              : severity === "warning"
                                ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                                : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
                          )}
                        >
                          Affects {percentAffected}% of pages
                        </span>
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
        <TabsContent
          value="links"
          className="mt-6 overflow-y-auto max-h-[calc(100vh-20rem)]"
        >
          {latestData?.linkAnalysis ? (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-5">
                <StatCard
                  label="Total Links"
                  value={latestData.linkAnalysis.totalLinks}
                />
                <StatCard
                  label="Internal"
                  value={latestData.linkAnalysis.internalLinks ?? 0}
                />
                <StatCard
                  label="External"
                  value={latestData.linkAnalysis.externalLinks ?? 0}
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
                      {latestData.linkAnalysis.orphanPages.map((item, idx) => (
                        <li
                          key={idx}
                          className="text-xs bg-card border rounded-lg px-3 py-2 truncate"
                        >
                          {typeof item === "string"
                            ? item
                            : typeof item === "object" &&
                                item !== null &&
                                "url" in item
                              ? String(item.url)
                              : JSON.stringify(item)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              {(!latestData.linkAnalysis.brokenLinks ||
                latestData.linkAnalysis.brokenLinks.length === 0) &&
                (!latestData.linkAnalysis.orphanPages ||
                  latestData.linkAnalysis.orphanPages.length === 0) && (
                  <div className="rounded-lg border bg-emerald-50 dark:bg-emerald-950/20 p-3 text-sm text-emerald-700 dark:text-emerald-400">
                    ✓ No broken links or orphan pages detected.
                  </div>
                )}

              {/* Link Distribution Table */}
              {latestData.linkAnalysis.linkDistribution &&
                latestData.linkAnalysis.linkDistribution.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Link Distribution (Top Pages)
                    </h4>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">
                              URL
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Incoming
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Outgoing
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {latestData.linkAnalysis.linkDistribution
                            .slice(0, 20)
                            .map((entry, idx) => (
                              <tr key={idx} className="border-t">
                                <td className="px-3 py-2 truncate max-w-[300px]">
                                  {entry.url}
                                </td>
                                <td className="px-3 py-2 text-right font-medium">
                                  {entry.incomingCount}
                                </td>
                                <td className="px-3 py-2 text-right font-medium">
                                  {entry.outgoingCount}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

              <div>
                <h4 className="text-sm font-semibold mb-2">Link Graph</h4>
                <LinkGraph linkAnalysis={latestData.linkAnalysis} />
              </div>

              {/* Link Depth Distribution */}
              {latestData.linkAnalysis.linkDepths &&
                latestData.linkAnalysis.linkDepths.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Link Depth Distribution
                    </h4>
                    <LinkDepthTable
                      depths={latestData.linkAnalysis.linkDepths}
                    />
                  </div>
                )}

              {/* Internal Linking Suggestions (#881) */}
              {latestData.linkAnalysis.linkingSuggestions &&
                latestData.linkAnalysis.linkingSuggestions.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Internal Linking Suggestions
                    </h4>
                    <p className="text-xs text-muted-foreground mb-3">
                      Opportunities to improve your internal link structure
                      based on keyword overlap analysis.
                    </p>
                    <div className="space-y-2">
                      {latestData.linkAnalysis.linkingSuggestions
                        .slice(0, 20)
                        .map(
                          (
                            s: {
                              sourcePage: string;
                              targetPage: string;
                              suggestedAnchor: string;
                              reason: string;
                              priority: string;
                            },
                            idx: number,
                          ) => (
                            <div
                              key={idx}
                              className="rounded-lg border bg-card p-3 text-xs"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <p>
                                    <span className="font-medium">From:</span>{" "}
                                    <span className="truncate">
                                      {s.sourcePage}
                                    </span>
                                  </p>
                                  <p>
                                    <span className="font-medium">To:</span>{" "}
                                    <span className="truncate">
                                      {s.targetPage}
                                    </span>
                                  </p>
                                  <p className="text-muted-foreground mt-1">
                                    Anchor: &quot;{s.suggestedAnchor}&quot; —{" "}
                                    {s.reason}
                                  </p>
                                </div>
                                <span
                                  className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                    s.priority === "high"
                                      ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                                      : s.priority === "medium"
                                        ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                                        : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                                  }`}
                                >
                                  {s.priority}
                                </span>
                              </div>
                            </div>
                          ),
                        )}
                    </div>
                  </div>
                )}
            </div>
          ) : (
            <EmptyState message="No link analysis data. Run an audit to analyze your site's link structure." />
          )}
        </TabsContent>

        {/* ── Content ──────────────────────────────────────────── */}
        <TabsContent
          value="content"
          className="mt-6 overflow-y-auto max-h-[calc(100vh-20rem)]"
        >
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
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-xs font-medium text-orange-500">
                              Group {idx + 1} — {group.urls?.length ?? 0} pages
                            </p>
                            {group.similarity != null && (
                              <span className="text-[10px] rounded bg-orange-50 text-orange-600 px-1 py-0.5 font-medium">
                                {group.similarity}% similar
                              </span>
                            )}
                            {group.recommendation && (
                              <span className="text-[10px] rounded bg-blue-50 text-blue-600 px-1 py-0.5 font-medium">
                                {group.recommendation}
                              </span>
                            )}
                          </div>
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

              {/* Keyword Density */}
              {latestData.contentAnalysis.keywordDensity &&
              latestData.contentAnalysis.keywordDensity.length > 0 ? (
                <div>
                  <h4 className="text-sm font-semibold mb-2">
                    Keyword Density
                  </h4>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">
                            URL
                          </th>
                          <th className="px-3 py-2 text-left font-medium">
                            Keyword
                          </th>
                          <th className="px-3 py-2 text-left font-medium">
                            Count
                          </th>
                          <th className="px-3 py-2 text-left font-medium">
                            Density
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {latestData.contentAnalysis.keywordDensity
                          .slice(0, 50)
                          .map((kd, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="px-3 py-2 truncate max-w-[200px]">
                                {kd.url}
                              </td>
                              <td className="px-3 py-2 font-medium">
                                {kd.keyword}
                              </td>
                              <td className="px-3 py-2">{kd.count}</td>
                              <td
                                className={`px-3 py-2 font-medium ${kd.density > 3 ? "text-red-500" : ""}`}
                              >
                                {kd.density}%
                                {kd.density > 3 && (
                                  <span className="ml-1 text-[10px] text-red-500">
                                    over-optimized
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No keyword density data available.
                </p>
              )}

              {/* Content Freshness (#877) */}
              {latestData.contentAnalysis.freshness &&
                latestData.contentAnalysis.freshness.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Content Freshness
                    </h4>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">
                              URL
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Status
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Age
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Last Modified
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {latestData.contentAnalysis.freshness.map(
                            (
                              f: {
                                url: string;
                                freshnessRating: string;
                                ageInDays: number | null;
                                dateModified?: string;
                                datePublished?: string;
                              },
                              idx: number,
                            ) => (
                              <tr key={idx} className="border-t">
                                <td className="px-3 py-2 truncate max-w-[200px]">
                                  {f.url}
                                </td>
                                <td className="px-3 py-2">
                                  <span
                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                      f.freshnessRating === "Fresh"
                                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                        : f.freshnessRating === "Aging"
                                          ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                                          : f.freshnessRating === "Stale"
                                            ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                                            : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400"
                                    }`}
                                  >
                                    {f.freshnessRating}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">
                                  {f.ageInDays != null
                                    ? `${f.ageInDays}d`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">
                                  {f.dateModified ?? f.datePublished ?? "—"}
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

              {/* Content Ideas / PAA (#880) */}
              {latestData.contentAnalysis.paaQuestions &&
                latestData.contentAnalysis.paaQuestions.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Content Ideas (People Also Ask)
                    </h4>
                    <p className="text-xs text-muted-foreground mb-3">
                      Questions from Google&apos;s &quot;People Also Ask&quot;
                      section — use these as content topics or FAQ entries.
                    </p>
                    <div className="grid gap-1.5">
                      {latestData.contentAnalysis.paaQuestions.map(
                        (q: string, idx: number) => (
                          <div
                            key={idx}
                            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs"
                          >
                            <span className="text-muted-foreground shrink-0">
                              Q:
                            </span>
                            <span>{q}</span>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                )}
            </div>
          ) : (
            <EmptyState message="No content analysis data. Run an audit to check for duplicate and thin content." />
          )}
        </TabsContent>

        {/* ── Performance (CWV) ────────────────────────────────── */}
        <TabsContent
          value="performance"
          className="mt-6 overflow-y-auto max-h-[calc(100vh-20rem)]"
        >
          {latestData?.coreWebVitals && latestData.coreWebVitals.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Core Web Vitals</h3>
                <button
                  onClick={runCwvAnalysis}
                  disabled={cwvAnalyzing || !latest?.id}
                  className="text-xs px-3 py-1.5 rounded-md border bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cwvAnalyzing ? "Analyzing…" : "Re-analyze"}
                </button>
              </div>

              {/* Aggregate CWV Summary */}
              <CwvAggregateSummary results={latestData.coreWebVitals} />

              {/* Per-page results */}
              {latestData.coreWebVitals.map((cwv, idx) => {
                const metricMap = new Map(
                  (cwv.metrics ?? []).map((m) => [m.name, m]),
                );
                const hasFailed =
                  !!cwv.error || (cwv.metrics ?? []).length === 0;
                const psiUrl = `https://pagespeed.web.dev/analysis/${encodeURIComponent(cwv.url)}`;
                return (
                  <div key={idx} className="rounded-lg border bg-card p-4">
                    {/* Card header */}
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">
                            {cwv.url}
                          </p>
                          {cwv.strategy && (
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0",
                                cwv.strategy === "mobile"
                                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                                  : "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
                              )}
                            >
                              {cwv.strategy === "mobile"
                                ? "📱 Mobile"
                                : "🖥️ Desktop"}
                            </span>
                          )}
                        </div>
                        {cwv.fetchedAt && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Analyzed {new Date(cwv.fetchedAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <a
                          href={psiUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                          title="Open in PageSpeed Insights"
                        >
                          <ExternalLink className="h-3 w-3" /> PSI
                        </a>
                        <PerfScoreBadge score={cwv.performanceScore} />
                      </div>
                    </div>

                    {/* Error / no-data state */}
                    {hasFailed && (
                      <div className="mb-3 rounded bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
                        {cwv.error?.includes("429") ||
                        cwv.error?.includes("quota")
                          ? "Rate limited by PageSpeed Insights API. Add a GOOGLE_PSI_API_KEY for higher limits."
                          : cwv.error
                            ? `PSI fetch failed: ${cwv.error}`
                            : "PSI returned no lighthouse metrics — the page may have timed out or blocked the crawler."}
                      </div>
                    )}

                    {/* Metric grid — always show all 6 slots */}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {CWV_METRIC_DEFS.map((def) => {
                        const m = metricMap.get(def.name);
                        const ratingColor = !m
                          ? "text-muted-foreground"
                          : m.rating === "good"
                            ? "text-green-600"
                            : m.rating === "poor"
                              ? "text-red-600"
                              : "text-yellow-600";
                        return (
                          <div
                            key={def.name}
                            className="rounded border bg-muted/20 px-2.5 py-2"
                          >
                            <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-0.5">
                              {def.name}
                            </div>
                            <div
                              className={`text-lg font-bold leading-tight ${ratingColor}`}
                            >
                              {m ? def.format(m.value) : "—"}
                            </div>
                            <div className="flex items-center justify-between mt-0.5">
                              <span className="text-[10px] text-muted-foreground">
                                {def.hint}
                              </span>
                              {m && <CwvRatingBadge rating={m.rating} />}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Lighthouse Optimizations (#875) */}
                    {cwv.optimizations && cwv.optimizations.length > 0 && (
                      <div className="mt-3">
                        <h5 className="text-xs font-semibold mb-1.5">
                          Optimization Opportunities
                        </h5>
                        <div className="space-y-1">
                          {cwv.optimizations.slice(0, 5).map((opt) => (
                            <div
                              key={opt.auditId}
                              className="flex items-start gap-2 rounded border bg-muted/20 px-2.5 py-1.5"
                            >
                              <span
                                className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${
                                  opt.category === "opportunity"
                                    ? "bg-orange-500"
                                    : "bg-blue-500"
                                }`}
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium">
                                  {opt.title}
                                </p>
                                {(opt.savingsMs || opt.savingsBytes) && (
                                  <p className="text-[10px] text-muted-foreground">
                                    {opt.savingsMs
                                      ? `Save ~${(opt.savingsMs / 1000).toFixed(1)}s`
                                      : ""}
                                    {opt.savingsMs && opt.savingsBytes
                                      ? " · "
                                      : ""}
                                    {opt.savingsBytes
                                      ? `${(opt.savingsBytes / 1024).toFixed(0)} KB`
                                      : ""}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <div className="flex flex-col items-center gap-2 text-center">
                <Gauge className="h-10 w-10 text-muted-foreground/40" />
                <p className="text-sm font-medium">
                  No Core Web Vitals data yet
                </p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  Fetch performance metrics from Google PageSpeed Insights for
                  the pages in your latest audit.
                  {!latest?.id && " Run a site audit first."}
                </p>
              </div>
              {latest?.id && (
                <div className="flex flex-col items-center gap-2">
                  <button
                    onClick={runCwvAnalysis}
                    disabled={cwvAnalyzing}
                    className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {cwvAnalyzing
                      ? "Analyzing performance…"
                      : "Analyze Performance"}
                  </button>
                  {cwvAnalyzing && (
                    <p className="text-xs text-muted-foreground">
                      Fetching metrics from PageSpeed Insights (may take 30–60
                      s)…
                    </p>
                  )}
                  {cwvError && (
                    <p className="text-xs text-destructive">{cwvError}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Analyzes up to 5 pages · Uses Google PSI free tier · Results
                    cached 24 h
                  </p>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── History ──────────────────────────────────────────── */}
        <TabsContent value="history" className="mt-6 space-y-6">
          <AuditTrends siteUrl={latest?.siteUrl} />
          <ScheduledAudits />
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
                {!selectedId && (
                  <p className="text-xs text-muted-foreground">
                    Select an audit from the dropdown above to export.
                  </p>
                )}
                <ExportDialog snapshotId={selectedId} />
              </>
            ) : (
              <EmptyState message="No audits available yet. Run an audit first to enable export." />
            )}
          </div>
        </TabsContent>

        {/* ── Schema Generator (#879) ─────────────────────────── */}
        <TabsContent value="schema" className="mt-6">
          <div className="rounded-xl border bg-card p-6">
            <h3 className="text-sm font-semibold mb-4">
              Schema Markup Generator
            </h3>
            <p className="text-xs text-muted-foreground mb-4">
              Generate JSON-LD structured data for your pages. Choose a
              Schema.org type, fill in the fields, and copy the output.
            </p>
            <SchemaGeneratorPanel />
          </div>
        </TabsContent>

        {/* ── Meta Generator (#878) ───────────────────────────── */}
        <TabsContent value="meta-gen" className="mt-6">
          <div className="rounded-xl border bg-card p-6">
            <h3 className="text-sm font-semibold mb-4">
              AI Meta Tag Generator
            </h3>
            <p className="text-xs text-muted-foreground mb-4">
              Generate SEO-optimized title and meta description variants using
              AI. Produces 3 options each with character counts and SERP
              previews.
            </p>
            <MetaGeneratorPanel />
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}

// ── Helper Components ────────────────────────────────────────────────────

function CwvAggregateSummary({ results }: { results: CwvEntry[] }) {
  if (results.length === 0) return null;

  let good = 0;
  let needsImprovement = 0;
  let poor = 0;
  let totalScore = 0;
  let failedCount = 0;
  const lcpVals: number[] = [];
  const clsVals: number[] = [];
  const tbtVals: number[] = [];

  for (const r of results) {
    if (r.error || (r.metrics ?? []).length === 0) {
      failedCount++;
      continue;
    }
    totalScore += r.performanceScore;
    if (r.performanceScore >= 90) good++;
    else if (r.performanceScore >= 50) needsImprovement++;
    else poor++;
    for (const m of r.metrics ?? []) {
      if (m.name === "LCP") lcpVals.push(m.value);
      if (m.name === "CLS") clsVals.push(m.value);
      if (m.name === "TBT") tbtVals.push(m.value);
    }
  }

  const scored = results.length - failedCount;
  const avgScore = scored > 0 ? Math.round(totalScore / scored) : 0;
  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const avgLcp = avg(lcpVals);
  const avgCls = avg(clsVals);
  const avgTbt = avg(tbtVals);

  return (
    <div className="space-y-3 mb-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <div className="rounded-lg border bg-card p-3 text-center">
          <p className="text-xs text-muted-foreground">Avg Score</p>
          <p
            className={`text-2xl font-bold mt-1 ${avgScore >= 90 ? "text-green-600" : avgScore >= 50 ? "text-yellow-600" : "text-red-600"}`}
          >
            {scored > 0 ? avgScore : "—"}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-3 text-center">
          <p className="text-xs text-muted-foreground">Good (≥90)</p>
          <p className="text-2xl font-bold mt-1 text-green-600">{good}</p>
        </div>
        <div className="rounded-lg border bg-card p-3 text-center">
          <p className="text-xs text-muted-foreground">Needs Work (50–89)</p>
          <p className="text-2xl font-bold mt-1 text-yellow-600">
            {needsImprovement}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-3 text-center">
          <p className="text-xs text-muted-foreground">Poor (&lt;50)</p>
          <p className="text-2xl font-bold mt-1 text-red-600">{poor}</p>
        </div>
      </div>

      {/* Avg metric stats row */}
      {(avgLcp !== null || avgCls !== null || avgTbt !== null) && (
        <div className="grid gap-3 grid-cols-3 text-center">
          {avgLcp !== null && (
            <div className="rounded-lg border bg-card p-2.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Avg LCP
              </p>
              <p
                className={`text-base font-bold mt-0.5 ${avgLcp <= 2500 ? "text-green-600" : avgLcp <= 4000 ? "text-yellow-600" : "text-red-600"}`}
              >
                {(avgLcp / 1000).toFixed(1)} s
              </p>
            </div>
          )}
          {avgCls !== null && (
            <div className="rounded-lg border bg-card p-2.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Avg CLS
              </p>
              <p
                className={`text-base font-bold mt-0.5 ${avgCls <= 0.1 ? "text-green-600" : avgCls <= 0.25 ? "text-yellow-600" : "text-red-600"}`}
              >
                {avgCls.toFixed(3)}
              </p>
            </div>
          )}
          {avgTbt !== null && (
            <div className="rounded-lg border bg-card p-2.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Avg TBT
              </p>
              <p
                className={`text-base font-bold mt-0.5 ${avgTbt <= 200 ? "text-green-600" : avgTbt <= 600 ? "text-yellow-600" : "text-red-600"}`}
              >
                {Math.round(avgTbt)} ms
              </p>
            </div>
          )}
        </div>
      )}

      {failedCount > 0 && (
        <div className="rounded bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {failedCount} of {results.length} pages failed to fetch from PageSpeed
          Insights. This is usually caused by anonymous API rate-limits. Set{" "}
          <code className="font-mono">GOOGLE_PSI_API_KEY</code> in your config
          for higher quota.
        </div>
      )}
    </div>
  );
}

function PerfScoreBadge({ score }: { score: number }) {
  const color =
    score >= 90
      ? "text-green-600 bg-green-50"
      : score >= 50
        ? "text-yellow-600 bg-yellow-50"
        : "text-red-600 bg-red-50";
  return (
    <span className={`ml-3 px-2 py-0.5 rounded text-lg font-bold ${color}`}>
      {score}
    </span>
  );
}

function LinkDepthTable({
  depths,
}: {
  depths: Array<{ url: string; depth: number }>;
}) {
  // Group by depth
  const depthGroups = new Map<number, string[]>();
  for (const d of depths) {
    const key = d.depth === Infinity ? 999 : d.depth;
    if (!depthGroups.has(key)) depthGroups.set(key, []);
    depthGroups.get(key)!.push(d.url);
  }

  const sortedKeys = [...depthGroups.keys()].sort((a, b) => a - b);

  return (
    <div className="space-y-2">
      {/* Depth summary bar */}
      <div className="flex gap-2 flex-wrap">
        {sortedKeys.map((d) => {
          const count = depthGroups.get(d)!.length;
          const label = d === 999 ? "Unreachable" : `Depth ${d}`;
          const isDeep = d > 4 && d !== 999;
          return (
            <span
              key={d}
              className={`text-xs rounded-full px-2 py-0.5 font-medium ${
                d === 999
                  ? "bg-red-100 text-red-700"
                  : isDeep
                    ? "bg-orange-100 text-orange-700"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {label}: {count} page{count !== 1 ? "s" : ""}
            </span>
          );
        })}
      </div>

      {/* Deep pages warning */}
      {depths.some((d) => d.depth > 4 && d.depth !== Infinity) && (
        <div className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 p-2">
          <AlertTriangle className="h-4 w-4 text-orange-600 mt-0.5 shrink-0" />
          <p className="text-xs text-orange-700 dark:text-orange-400">
            Pages at depth &gt; 4 may be difficult for search engines to
            discover. Consider restructuring your site navigation.
          </p>
        </div>
      )}

      {/* Per-depth URL list (collapsed for depth ≤ 2) */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left font-medium">URL</th>
              <th className="px-3 py-2 text-left font-medium w-24">Depth</th>
            </tr>
          </thead>
          <tbody>
            {depths
              .filter((d) => d.depth > 2 || d.depth === Infinity)
              .slice(0, 50)
              .map((d, idx) => (
                <tr key={idx} className="border-t">
                  <td className="px-3 py-2 truncate max-w-[350px]">{d.url}</td>
                  <td
                    className={`px-3 py-2 font-medium ${d.depth > 4 ? "text-orange-500" : d.depth === Infinity ? "text-red-500" : ""}`}
                  >
                    {d.depth === Infinity ? "∞" : d.depth}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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

// ── Scheduled Audits ─────────────────────────────────────────────────────

interface ScheduledJob {
  id: string;
  name: string;
  cronExpression: string;
  enabled: boolean;
  actionPayload?: Record<string, unknown>;
}

function ScheduledAudits() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [formError, setFormError] = useState<string | null>(null);

  const cronMap: Record<string, string> = {
    daily: "0 6 * * *",
    weekly: "0 6 * * 1",
    monthly: "0 6 1 * *",
  };

  const { data, isLoading } = useQuery<{ jobs: ScheduledJob[] }>({
    queryKey: ["seo-scheduled-jobs"],
    queryFn: () => fetchJson<{ jobs: ScheduledJob[] }>("/api/admin/jobs"),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    select: (data) => ({
      jobs: data.jobs.filter(
        (j) =>
          j.name.toLowerCase().includes("seo") ||
          j.name.toLowerCase().includes("audit") ||
          (j.actionPayload?.promptName as string | undefined)
            ?.toLowerCase()
            .includes("seo"),
      ),
    }),
  });

  const createJob = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson<ScheduledJob>("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["seo-scheduled-jobs"] });
      setShowForm(false);
      setFormUrl("");
      setFormError(null);
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const toggleJob = useMutation({
    mutationFn: (id: string) =>
      fetchJson<ScheduledJob>(`/api/admin/jobs/${id}/toggle`, {
        method: "POST",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["seo-scheduled-jobs"] }),
  });

  const deleteJob = useMutation({
    mutationFn: (id: string) =>
      fetchJson<void>(`/api/admin/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["seo-scheduled-jobs"] }),
  });

  const handleCreate = () => {
    if (!formUrl.trim()) {
      setFormError("URL is required");
      return;
    }
    try {
      new URL(formUrl.trim());
    } catch {
      setFormError("Please enter a valid URL");
      return;
    }
    setFormError(null);
    createJob.mutate({
      name: `SEO Audit — ${new URL(formUrl.trim()).hostname}`,
      cronExpression: cronMap[frequency],
      actionType: "prompt",
      actionPayload: {
        promptName: "seo-site-audit",
        variables: { url: formUrl.trim() },
      },
      allowedTools: ["seo-site-audit", "firecrawl-crawl", "firecrawl-scrape"],
      enabled: true,
    });
  };

  const jobs = data?.jobs ?? [];

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <Calendar className="h-4 w-4" /> Scheduled Audits
        </h4>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent transition-colors"
        >
          <Plus className="h-3 w-3" /> Schedule Audit
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
          <div>
            <label className="text-xs font-medium">Site URL</label>
            <input
              type="url"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://example.com"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium">Frequency</label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="daily">Daily (6:00 AM)</option>
              <option value="weekly">Weekly (Monday 6:00 AM)</option>
              <option value="monthly">Monthly (1st, 6:00 AM)</option>
            </select>
          </div>
          {formError && <p className="text-xs text-red-500">{formError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setFormError(null);
              }}
              className="rounded-md border px-3 py-1 text-xs hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={createJob.isPending}
              className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {createJob.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No scheduled audits yet. Click &quot;Schedule Audit&quot; to set up
          recurring site audits.
        </p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center gap-3 rounded-lg border bg-background p-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{job.name}</p>
                <p className="text-xs text-muted-foreground">
                  {job.cronExpression}
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggleJob.mutate(job.id)}
                title={job.enabled ? "Disable" : "Enable"}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  job.enabled
                    ? "text-green-600 hover:bg-green-50"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Power className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => deleteJob.mutate(job.id)}
                title="Delete"
                className="rounded-md p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
