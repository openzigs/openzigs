"use client";

import { useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
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
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────

type CrawlDashboardDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
};

type CrawlAction = "site-audit" | "ingest-website" | "competitive-monitor";

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
  const [monitorAction, setMonitorAction] = useState<"add" | "snapshot" | "report" | "list">("add");
  const [competitorName, setCompetitorName] = useState("");

  // Firecrawl status
  const [firecrawlEnabled, setFirecrawlEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchJson<{ enabled: boolean }>("/api/admin/firecrawl/status")
      .then((data) => { if (!cancelled) setFirecrawlEnabled(data.enabled); })
      .catch(() => { if (!cancelled) setFirecrawlEnabled(false); });
    return () => { cancelled = true; };
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (!url.trim() && action !== "competitive-monitor") {
      setError("URL is required");
      return;
    }
    if (action === "competitive-monitor" && monitorAction !== "list" && !url.trim()) {
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
        prompt = buildIngestPrompt(url, maxPages, maxDepth, category, visibility);
        break;
      case "competitive-monitor":
        prompt = buildMonitorPrompt(monitorAction, url, competitorName, maxPages);
        break;
    }

    socket.emit("chat:message", {
      content: prompt,
      tools: [
        "seo-site-audit", "ingest-website", "competitive-monitor",
        "read-file", "write-file", "list-directory",
      ],
    });
    setLoading(false);
    onOpenChange(false);
    onSubmitted?.();
  }, [action, url, maxPages, maxDepth, category, visibility, monitorAction, competitorName, socket, connected, onOpenChange, onSubmitted]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Firecrawl Dashboard
          </DialogTitle>
          <DialogDescription>
            Crawl websites for SEO audits, knowledge ingestion, or competitive monitoring.
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
                  to start the Firecrawl sidecar, then enable it in Admin → Settings.
                </p>
              </div>
            </div>
          )}

          {/* Action selector */}
          <div className="grid grid-cols-3 gap-2">
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
          </div>

          {/* URL input */}
          {(action !== "competitive-monitor" || monitorAction !== "list") && (
            <div>
              <label htmlFor="crawl-url" className="mb-1 block text-sm font-medium">
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
          {action !== "competitive-monitor" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="max-pages" className="mb-1 block text-sm font-medium">
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
                <label htmlFor="max-depth" className="mb-1 block text-sm font-medium">
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
                <label htmlFor="category" className="mb-1 block text-sm font-medium">
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
                <label htmlFor="visibility" className="mb-1 block text-sm font-medium">
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
                <label htmlFor="monitor-action" className="mb-1 block text-sm font-medium">
                  Action
                </label>
                <select
                  id="monitor-action"
                  value={monitorAction}
                  onChange={(e) => setMonitorAction(e.target.value as typeof monitorAction)}
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
                  <label htmlFor="competitor-name" className="mb-1 block text-sm font-medium">
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
            {action === "site-audit" ? "Run Audit" : action === "ingest-website" ? "Start Ingestion" : "Execute"}
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

function buildSiteAuditPrompt(url: string, maxPages: number, maxDepth: number): string {
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
