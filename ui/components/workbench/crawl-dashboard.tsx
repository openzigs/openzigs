"use client";

import { useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import { InlineModelPicker } from "@/components/model-picker-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Globe,
  Loader2,
  AlertCircle,
  Info,
  Search,
  Database,
  BarChart3,
  FileJson,
  Users,
  DollarSign,
  HardDrive,
  History,
} from "lucide-react";
import { ExtractionHistory } from "./extraction-history";

// ── Types ────────────────────────────────────────────────────────────────

type CrawlDashboardDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
};

type CrawlAction =
  | "site-audit"
  | "ingest-website"
  | "competitive-monitor"
  | "web-extract"
  | "lead-extract"
  | "price-monitor"
  | "site-to-dataset";

// ── Component ────────────────────────────────────────────────────────────

export function CrawlDashboardDialog({
  open,
  onOpenChange,
  onSubmitted,
}: CrawlDashboardDialogProps) {
  const { socket, connected } = useSocket();

  const [action, setAction] = useState<CrawlAction>("site-audit");
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ingest-specific
  const [category, setCategory] = useState("document");
  const [visibility, setVisibility] = useState("internal");

  // Competitive monitor
  const [monitorAction, setMonitorAction] = useState<
    "add" | "snapshot" | "report" | "list"
  >("add");
  const [competitorName, setCompetitorName] = useState("");

  // Web extract
  const [extractSchema, setExtractSchema] = useState("");
  const [extractPrompt, setExtractPrompt] = useState("");
  const [extractTemplate, setExtractTemplate] = useState<string>("custom");
  const [scrollForContent, setScrollForContent] = useState(false);
  const [waitForDynamic, setWaitForDynamic] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Price monitor
  const [priceAction, setPriceAction] = useState<
    "snapshot" | "compare" | "history" | "list"
  >("snapshot");
  const [scrollToLoad, setScrollToLoad] = useState(false);
  const [priceLabel, setPriceLabel] = useState("");

  // Site-to-dataset
  const [datasetFormat, setDatasetFormat] = useState<
    "markdown" | "jsonl" | "csv"
  >("markdown");
  const [includePaths, setIncludePaths] = useState("");
  const [excludePaths, setExcludePaths] = useState("");

  // Model selection for LLM-powered analysis
  const [model, setModel] = useState("");

  // Firecrawl status
  const [firecrawlEnabled, setFirecrawlEnabled] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchJson<{ enabled: boolean }>("/api/admin/firecrawl/status")
      .then((data) => {
        if (!cancelled) setFirecrawlEnabled(data.enabled);
      })
      .catch(() => {
        if (!cancelled) setFirecrawlEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSubmit = useCallback(() => {
    const needsUrl =
      action !== "competitive-monitor" && action !== "price-monitor";
    const monitorNeedsUrl =
      action === "competitive-monitor" && monitorAction !== "list";
    const priceNeedsUrl = action === "price-monitor" && priceAction !== "list";
    if (needsUrl && !url.trim()) {
      setError("URL is required");
      return;
    }
    if ((monitorNeedsUrl || priceNeedsUrl) && !url.trim()) {
      setError("URL is required for this action");
      return;
    }
    if (!socket || !connected) {
      setError("Not connected to server");
      return;
    }

    setLoading(true);
    setError(null);

    let prompt = "";

    switch (action) {
      case "site-audit":
        prompt = buildSiteAuditPrompt(url, maxPages, maxDepth);
        break;
      case "ingest-website":
        prompt = buildIngestPrompt(
          url,
          maxPages,
          maxDepth,
          category,
          visibility,
        );
        break;
      case "competitive-monitor":
        prompt = buildMonitorPrompt(
          monitorAction,
          url,
          competitorName,
          maxPages,
        );
        break;
      case "web-extract":
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
      case "lead-extract":
        prompt = buildLeadPrompt(url, maxPages);
        break;
      case "price-monitor":
        prompt = buildPricePrompt(priceAction, url, priceLabel, scrollToLoad);
        break;
      case "site-to-dataset":
        prompt = buildDatasetPrompt(
          url,
          maxPages,
          maxDepth,
          datasetFormat,
          includePaths,
          excludePaths,
        );
        break;
    }

    socket.emit("chat:message", {
      content: prompt,
      model: model || undefined,
      tools: [
        "seo-site-audit",
        "ingest-website",
        "competitive-monitor",
        "web-extract",
        "web-map",
        "lead-extract",
        "price-monitor",
        "site-to-dataset",
        "read-file",
        "write-file",
        "list-directory",
      ],
    });
    setLoading(false);
    onOpenChange(false);
    onSubmitted?.();
  }, [
    action,
    url,
    maxPages,
    maxDepth,
    category,
    visibility,
    monitorAction,
    competitorName,
    extractSchema,
    extractPrompt,
    extractTemplate,
    scrollForContent,
    waitForDynamic,
    priceAction,
    scrollToLoad,
    priceLabel,
    datasetFormat,
    includePaths,
    excludePaths,
    model,
    socket,
    connected,
    onOpenChange,
    onSubmitted,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Firecrawl Dashboard
          </DialogTitle>
          <DialogDescription>
            Crawl websites for SEO audits, data extraction, price monitoring,
            and more.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Firecrawl disabled banner */}
          {firecrawlEnabled === false && (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Firecrawl is not configured</p>
                <p className="mt-1 text-xs">
                  Run{" "}
                  <code className="rounded bg-blue-100 px-1 dark:bg-blue-900">
                    docker compose -f docker-compose.firecrawl.yml up -d
                  </code>{" "}
                  to start the Firecrawl sidecar, then enable it in Admin →
                  Settings.
                </p>
              </div>
            </div>
          )}

          {/* Action selector */}
          <div className="grid grid-cols-4 gap-2">
            <ActionButton
              icon={<Search className="h-4 w-4" />}
              label="Site Audit"
              active={action === "site-audit"}
              onClick={() => setAction("site-audit")}
            />
            <ActionButton
              icon={<Database className="h-4 w-4" />}
              label="Ingest"
              active={action === "ingest-website"}
              onClick={() => setAction("ingest-website")}
            />
            <ActionButton
              icon={<BarChart3 className="h-4 w-4" />}
              label="Monitor"
              active={action === "competitive-monitor"}
              onClick={() => setAction("competitive-monitor")}
            />
            <ActionButton
              icon={<FileJson className="h-4 w-4" />}
              label="Extract"
              active={action === "web-extract"}
              onClick={() => setAction("web-extract")}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <ActionButton
              icon={<Users className="h-4 w-4" />}
              label="Leads"
              active={action === "lead-extract"}
              onClick={() => setAction("lead-extract")}
            />
            <ActionButton
              icon={<DollarSign className="h-4 w-4" />}
              label="Prices"
              active={action === "price-monitor"}
              onClick={() => setAction("price-monitor")}
            />
            <ActionButton
              icon={<HardDrive className="h-4 w-4" />}
              label="Dataset"
              active={action === "site-to-dataset"}
              onClick={() => setAction("site-to-dataset")}
            />
          </div>

          {/* URL input */}
          {!(action === "competitive-monitor" && monitorAction === "list") &&
            !(action === "price-monitor" && priceAction === "list") && (
              <div>
                <label
                  htmlFor="crawl-url"
                  className="mb-1 block text-sm font-medium"
                >
                  Website URL
                </label>
                <input
                  id="crawl-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            )}

          {/* Max pages & depth */}
          {(action === "site-audit" ||
            action === "ingest-website" ||
            action === "lead-extract" ||
            action === "site-to-dataset") && (
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
                  max={action === "site-audit" ? 500 : 200}
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

          {/* Ingest-specific fields */}
          {action === "ingest-website" && (
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

          {/* Competitive monitor fields */}
          {action === "competitive-monitor" && (
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

          {/* Web extract fields */}
          {action === "web-extract" && !showHistory && (
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
                  placeholder="Describe what data to extract, e.g. 'all product names and prices'"
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
            </div>
          )}
          {action === "web-extract" && showHistory && (
            <div className="max-h-64 overflow-y-auto">
              <ExtractionHistory />
            </div>
          )}
          {action === "web-extract" && (
            <button
              type="button"
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <History className="h-3 w-3" />
              {showHistory ? "Back to extract" : "View extraction history"}
            </button>
          )}

          {/* Price monitor fields */}
          {action === "price-monitor" && (
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

          {/* Site-to-dataset fields */}
          {action === "site-to-dataset" && (
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

          {/* Model selector */}
          <div>
            <label className="mb-1 block text-sm font-medium">Model</label>
            <InlineModelPicker value={model} onChange={setModel} />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || firecrawlEnabled === false}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Globe className="h-4 w-4" />
            )}
            {getButtonLabel(action)}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

function ActionButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-accent",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Prompt Builders ──────────────────────────────────────────────────────

function buildSiteAuditPrompt(
  url: string,
  maxPages: number,
  maxDepth: number,
): string {
  return [
    `Run a comprehensive SEO site audit using the seo-site-audit tool.`,
    ``,
    `Call the seo-site-audit tool with:`,
    `\`\`\`json`,
    JSON.stringify({ url, maxPages, maxDepth }, null, 2),
    `\`\`\``,
    ``,
    `After the audit completes, summarize the key findings:`,
    `- Total issues by severity`,
    `- Top 5 most critical issues`,
    `- Site-wide patterns (duplicate titles, missing schema, etc.)`,
    `- Actionable recommendations prioritized by impact`,
  ].join("\n");
}

function buildIngestPrompt(
  url: string,
  maxPages: number,
  maxDepth: number,
  category: string,
  visibility: string,
): string {
  return [
    `Ingest a website into the knowledge base using the ingest-website tool.`,
    ``,
    `Call the ingest-website tool with:`,
    `\`\`\`json`,
    JSON.stringify({ url, maxPages, maxDepth, category, visibility }, null, 2),
    `\`\`\``,
    ``,
    `Report the ingestion results: pages successfully ingested, any failures, and recommendations.`,
  ].join("\n");
}

function buildMonitorPrompt(
  monitorAction: string,
  url: string,
  name: string,
  maxPages: number,
): string {
  const args: Record<string, unknown> = { action: monitorAction };
  if (url) args.url = url;
  if (name && monitorAction === "add") args.name = name;
  if (monitorAction === "snapshot") args.maxPages = maxPages;

  return [
    `Use the competitive-monitor tool to ${monitorAction} a competitor.`,
    ``,
    `Call the competitive-monitor tool with:`,
    `\`\`\`json`,
    JSON.stringify(args, null, 2),
    `\`\`\``,
    ``,
    monitorAction === "report"
      ? `Analyze the competitive intelligence report and highlight key changes and strategic implications.`
      : `Report the result.`,
  ].join("\n");
}

function buildExtractPrompt(
  url: string,
  schema: string,
  prompt: string,
  maxPages: number,
  template: string,
  scrollForContent: boolean,
  waitForDynamic: boolean,
): string {
  const args: Record<string, unknown> = { url };
  if (template !== "custom") {
    args.template = template;
  } else if (schema.trim()) {
    try {
      args.schema = JSON.parse(schema);
    } catch {
      args.prompt = `Extract data with this schema: ${schema}`;
    }
  }
  if (prompt.trim()) args.prompt = prompt;
  if (maxPages > 1) args.maxPages = maxPages;

  const hints: string[] = [];
  if (scrollForContent)
    hints.push("Scroll the page to load all lazy content before extraction.");
  if (waitForDynamic)
    hints.push("Wait for dynamic/JavaScript-rendered content to fully load.");

  return [
    `Use the web-extract tool to scrape and extract structured data.`,
    ``,
    `Call the web-extract tool with:`,
    "```json",
    JSON.stringify(args, null, 2),
    "```",
    ...(hints.length ? [``, ...hints] : []),
    ``,
    `After extraction, present the structured results clearly.`,
  ].join("\n");
}

function buildLeadPrompt(url: string, maxPages: number): string {
  return [
    `Use the lead-extract tool to find contacts and company info.`,
    ``,
    `Call the lead-extract tool with:`,
    "```json",
    JSON.stringify({ url, maxPages }, null, 2),
    "```",
    ``,
    `Present the extracted contacts in a clean table format.`,
  ].join("\n");
}

function buildPricePrompt(
  action: string,
  url: string,
  label: string,
  scrollToLoad: boolean,
): string {
  const args: Record<string, unknown> = { action };
  if (url) args.url = url;
  if (label && action === "snapshot") args.label = label;
  if (scrollToLoad && action === "snapshot") args.scrollToLoad = true;

  return [
    `Use the price-monitor tool to ${action} pricing data.`,
    ``,
    `Call the price-monitor tool with:`,
    "```json",
    JSON.stringify(args, null, 2),
    "```",
    ``,
    action === "compare"
      ? `Analyze the price differences and highlight important changes.`
      : `Present the results clearly.`,
  ].join("\n");
}

function buildDatasetPrompt(
  url: string,
  maxPages: number,
  maxDepth: number,
  format: string,
  includePaths: string,
  excludePaths: string,
): string {
  const args: Record<string, unknown> = { url, maxPages, maxDepth, format };
  if (includePaths.trim())
    args.includePaths = includePaths
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (excludePaths.trim())
    args.excludePaths = excludePaths
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return [
    `Use the site-to-dataset tool to crawl and build a structured dataset.`,
    ``,
    `Call the site-to-dataset tool with:`,
    "```json",
    JSON.stringify(args, null, 2),
    "```",
    ``,
    `Report the dataset creation results and suggest next steps for processing.`,
  ].join("\n");
}

function getButtonLabel(action: CrawlAction): string {
  switch (action) {
    case "site-audit":
      return "Run Audit";
    case "ingest-website":
      return "Start Ingestion";
    case "web-extract":
      return "Extract Data";
    case "lead-extract":
      return "Find Leads";
    case "price-monitor":
      return "Monitor Prices";
    case "site-to-dataset":
      return "Build Dataset";
    default:
      return "Execute";
  }
}
