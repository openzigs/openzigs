"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useSocket } from "@/lib/socket-context";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ModelPickerSelect, useModelsQuery } from "@/components/model-picker-select";
import {
  Search,
  Loader2,
  AlertCircle,
} from "lucide-react";

type SeoAnalysisDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
};

function buildSeoPrompt(params: {
  targetUrl: string;
  targetKeyword: string;
  searchProvider: string;
}): string {
  const steps: string[] = [];
  steps.push(`[Using SEO Analyst skill]`);
  steps.push(`Run a full SEO content gap analysis.`);
  steps.push(`Target URL: ${params.targetUrl}`);
  if (params.targetKeyword) {
    steps.push(`Target Keyword: "${params.targetKeyword}"`);
  } else {
    steps.push(`Target Keyword: (auto-detect from page content)`);
  }
  if (params.searchProvider !== "auto") {
    steps.push(`Search Provider: ${params.searchProvider}`);
  }
  steps.push("");
  steps.push("STEP 1: Call seo-gap-analysis with the target URL and keyword. Wait for results.");
  steps.push("STEP 2: Read the generated report from the returned reportPath.");
  steps.push("STEP 3: Using the returned analysisPrompt, provide enhanced LLM analysis with:");
  steps.push("  - Executive summary with gap score");
  steps.push("  - Key content gaps and missing subtopics");
  steps.push("  - Top 5 prioritized recommendations");
  steps.push("  - Content brief outline for page updates");
  steps.push("STEP 4: Write the enhanced analysis to the same report file (append to existing content).");
  steps.push("STEP 5: Respond with a summary of key findings and the report file path.");
  return steps.join("\n");
}

export const SeoAnalysisDialog = ({
  open,
  onOpenChange,
  onSubmitted,
}: SeoAnalysisDialogProps) => {
  const { socket, connected } = useSocket();
  const modelsQuery = useModelsQuery(open);
  const [targetUrl, setTargetUrl] = useState("");
  const [targetKeyword, setTargetKeyword] = useState("");
  const [searchProvider, setSearchProvider] = useState("auto");
  const [model, setModel] = useState("claude-sonnet-4.6");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = targetUrl.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!isValid || !socket || !connected) return;

    // Basic URL validation
    try {
      new URL(targetUrl.trim());
    } catch {
      setError("Please enter a valid URL (e.g. https://example.com/page).");
      return;
    }

    setError(null);
    setSubmitting(true);

    const prompt = buildSeoPrompt({
      targetUrl: targetUrl.trim(),
      targetKeyword: targetKeyword.trim(),
      searchProvider,
    });

    try {
      socket.emit("chat:message", {
        content: prompt,
        model: model || "claude-sonnet-4.6",
        tools: [
          "seo-gap-analysis", "seo-extract-content",
          "web-search", "browser-navigate",
          "read-file", "write-file", "list-directory",
        ],
      });
      onSubmitted?.();
      setSubmitting(false);
      onOpenChange(false);
      setTargetUrl("");
      setTargetKeyword("");
      setSearchProvider("auto");
      setModel("claude-sonnet-4.6");
    } catch {
      setError("Failed to send analysis request. Check connection.");
      setSubmitting(false);
    }
  }, [isValid, socket, connected, targetUrl, targetKeyword, searchProvider, model, onOpenChange, onSubmitted]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setError(null);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            SEO Gap Analysis
          </DialogTitle>
          <DialogDescription>
            Analyze your page against top-ranking competitors. Extracts content
            metrics, compares keyword coverage, identifies gaps, and generates
            an actionable report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Target URL */}
          <div>
            <label htmlFor="seo-url" className="mb-1 block text-xs font-medium text-foreground">
              Target URL <span className="text-destructive">*</span>
            </label>
            <input
              id="seo-url"
              type="url"
              maxLength={500}
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://example.com/my-blog-post"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Target Keyword */}
          <div>
            <label htmlFor="seo-keyword" className="mb-1 block text-xs font-medium text-foreground">
              Target Keyword
            </label>
            <input
              id="seo-keyword"
              type="text"
              maxLength={200}
              value={targetKeyword}
              onChange={(e) => setTargetKeyword(e.target.value)}
              placeholder="e.g. best project management tools"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Leave blank to auto-detect from page content
            </p>
          </div>

          {/* Search Provider */}
          <div>
            <label htmlFor="seo-provider" className="mb-1 block text-xs font-medium text-foreground">
              Search Provider
            </label>
            <select
              id="seo-provider"
              value={searchProvider}
              onChange={(e) => setSearchProvider(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="auto">Auto (use available API key)</option>
              <option value="serper">Serper.dev (Google results)</option>
              <option value="brave">Brave Search</option>
            </select>
          </div>

          {/* LLM Model */}
          <div>
            <label htmlFor="seo-model" className="mb-1 block text-xs font-medium text-foreground">
              LLM Model
            </label>
            <ModelPickerSelect
              value={model}
              onChange={setModel}
              modelsData={modelsQuery.data}
              className="w-full"
              size="sm"
            />
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              claude-sonnet-4.6 recommended for thorough analysis
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <button
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || submitting || !connected}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              isValid && !submitting && connected
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "cursor-not-allowed bg-muted text-muted-foreground",
            )}
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Search className="h-3.5 w-3.5" />
                Analyze
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
