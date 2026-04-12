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
import {
  ModelPickerSelect,
  useModelsQuery,
} from "@/components/model-picker-select";
import { Search, Loader2, AlertCircle } from "lucide-react";

type SeoAnalysisDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
};

type OrchestrationMode = "standard" | "session" | "task";

function buildSeoPrompt(params: {
  targetUrl: string;
  targetKeyword: string;
  searchProvider: string;
  exportPdf: boolean;
  orchestrationMode: OrchestrationMode;
}): string {
  const toolArgs: Record<string, string> = { targetUrl: params.targetUrl };
  if (params.targetKeyword) toolArgs.targetKeyword = params.targetKeyword;
  if (params.searchProvider !== "auto")
    toolArgs.searchProvider = params.searchProvider;

  const steps: string[] = [];
  steps.push(`[Using SEO Analyst skill]`);
  steps.push(
    `You MUST call the seo-gap-analysis tool. Do NOT skip the tool call or fabricate results.`,
  );
  steps.push(``);
  steps.push(
    `STEP 1 (MANDATORY): Call the seo-gap-analysis tool with these exact parameters:`,
  );
  steps.push(`\`\`\`json`);
  steps.push(JSON.stringify(toolArgs, null, 2));
  steps.push(`\`\`\``);
  steps.push(``);
  steps.push(
    `STEP 2: The tool returns JSON with reportPath, analysisPrompt, and targetMetrics.`,
  );
  steps.push(
    `Read the saved report using read-file with the exact reportPath.`,
  );
  steps.push(``);

  let nextStep = 3;

  if (params.orchestrationMode === "task") {
    // Fan-out: parallel sub-agents via orchestrate-agents in task mode (fastest, uses ~5 API calls)
    steps.push(
      `STEP ${nextStep}: Use orchestrate-agents with mode "task" to run parallel deep analysis with these sub-tasks:`,
    );
    steps.push(
      `  Agent 1 — "Content Depth Analyst": Analyze topical coverage gaps. What subtopics do competitors cover that the target misses? What entities and concepts are underrepresented? Rate content depth 0-100.`,
    );
    steps.push(
      `  Agent 2 — "Technical SEO Auditor": Review meta tags, schema markup, image optimization, internal linking quality, and mobile-readiness. Provide specific fix recommendations.`,
    );
    steps.push(
      `  Agent 3 — "SERP Strategy Analyst": Analyze the People Also Ask questions and related searches. Identify which SERP features the target could capture. Recommend content additions for featured snippets.`,
    );
    steps.push(``);
    nextStep++;
    steps.push(
      `STEP ${nextStep}: Synthesize all agent results into a unified enhanced analysis with:`,
    );
  } else if (params.orchestrationMode === "session") {
    // SDK subagent delegation: orchestrate-agents in session mode (~2 API calls)
    steps.push(
      `STEP ${nextStep}: Use orchestrate-agents with mode "session" to delegate deep analysis to SDK subagents. The tool will compose the following specialist goals into a single session with subagent delegation:`,
    );
    steps.push(
      `  — Content Depth Analysis: topical coverage gaps, missing subtopics, entity coverage, depth score 0-100.`,
    );
    steps.push(
      `  — Technical SEO Audit: meta tags, schema markup, image optimization, internal linking, mobile-readiness.`,
    );
    steps.push(
      `  — SERP Strategy Analysis: People Also Ask, SERP features, competitor positioning, featured snippet opportunities.`,
    );
    steps.push(``);
    nextStep++;
    steps.push(
      `STEP ${nextStep}: Synthesize the orchestration results into a unified enhanced analysis with:`,
    );
  } else {
    // Sequential: single-session analysis (uses 1 API call)
    steps.push(
      `STEP ${nextStep}: Perform the following deep analysis yourself, sequentially. Do NOT use orchestrate-agents or spawn-agent — complete everything in this single session.`,
    );
    steps.push(``);
    steps.push(
      `Part A — Content Depth Analysis: Analyze topical coverage gaps. What subtopics do competitors cover that the target misses? What entities and concepts are underrepresented? Rate content depth 0-100.`,
    );
    steps.push(``);
    steps.push(
      `Part B — Technical SEO Audit: Review meta tags, schema markup, image optimization, internal linking quality, and mobile-readiness. Provide specific fix recommendations.`,
    );
    steps.push(``);
    steps.push(
      `Part C — SERP Strategy Analysis: Analyze the People Also Ask questions and related searches. Identify which SERP features the target could capture. Recommend content additions for featured snippets.`,
    );
    steps.push(``);
    nextStep++;
    steps.push(
      `STEP ${nextStep}: Synthesize your analysis from Parts A, B, and C into a unified enhanced analysis with:`,
    );
  }
  steps.push(`  - Executive summary with overall SEO health score (0-100)`);
  steps.push(
    `  - Top 5 prioritized recommendations with Impact and Effort ratings`,
  );
  steps.push(`  - Content brief outline for updates`);
  steps.push(``);

  nextStep++;
  steps.push(
    `STEP ${nextStep}: APPEND your enhanced analysis to the EXISTING report file using write-file with the EXACT reportPath from Step 2.`,
  );
  steps.push(
    `IMPORTANT: First read the existing report content, then write back the FULL content: the original metrics report followed by a separator line "---" and then your enhanced analysis. Do NOT overwrite or remove the original metrics, tables, and charts. The final file must contain BOTH sections.`,
  );
  steps.push(
    `Reports are saved under ~/.openzigs/seo-reports/<domain>/ — the write-file tool has access to this directory and all subdirectories.`,
  );
  steps.push(``);
  if (params.exportPdf) {
    nextStep++;
    steps.push(
      `STEP ${nextStep}: Call the export-pdf tool with the reportPath to regenerate the PDF with the enhanced content.`,
    );
    steps.push(``);
  }
  nextStep++;
  steps.push(
    `STEP ${nextStep}: Respond with a summary of key findings and the report paths (markdown and PDF).`,
  );
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
  const [orchestrationMode, setOrchestrationMode] =
    useState<OrchestrationMode>("standard");
  const [exportPdf, setExportPdf] = useState(true);
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
      exportPdf,
      orchestrationMode,
    });

    try {
      socket.emit("chat:message", {
        content: prompt,
        model: model || "claude-sonnet-4.6",
        tools: [
          "seo-gap-analysis",
          "seo-extract-content",
          "export-pdf",
          "web-search",
          "browser-navigate",
          "read-file",
          "write-file",
          "list-directory",
          ...(orchestrationMode === "task"
            ? ["orchestrate-agents", "spawn-agent"]
            : []),
          ...(orchestrationMode === "session" ? ["orchestrate-agents"] : []),
        ],
      });
      onSubmitted?.();
      setSubmitting(false);
      onOpenChange(false);
      setTargetUrl("");
      setTargetKeyword("");
      setSearchProvider("auto");
      setModel("claude-sonnet-4.6");
      setOrchestrationMode("standard");
      setExportPdf(true);
    } catch {
      setError("Failed to send analysis request. Check connection.");
      setSubmitting(false);
    }
  }, [
    isValid,
    socket,
    connected,
    targetUrl,
    targetKeyword,
    searchProvider,
    model,
    orchestrationMode,
    exportPdf,
    onOpenChange,
    onSubmitted,
  ]);

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
            <label
              htmlFor="seo-url"
              className="mb-1 block text-xs font-medium text-foreground"
            >
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
            <label
              htmlFor="seo-keyword"
              className="mb-1 block text-xs font-medium text-foreground"
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
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Leave blank to auto-detect from page content
            </p>
          </div>

          {/* Search Provider */}
          <div>
            <label
              htmlFor="seo-provider"
              className="mb-1 block text-xs font-medium text-foreground"
            >
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
            <label
              htmlFor="seo-model"
              className="mb-1 block text-xs font-medium text-foreground"
            >
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

          {/* Analysis Mode */}
          <div>
            <label
              htmlFor="seo-mode"
              className="mb-1 block text-xs font-medium text-foreground"
            >
              Analysis Mode
            </label>
            <select
              id="seo-mode"
              value={orchestrationMode}
              onChange={(e) =>
                setOrchestrationMode(e.target.value as OrchestrationMode)
              }
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
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
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {orchestrationMode === "standard"
                ? "Runs all analysis sequentially in one session. Uses minimal API calls."
                : orchestrationMode === "session"
                  ? "Delegates to SDK subagents in a single session. Balanced speed and cost."
                  : "Dispatches 3 specialist agents in parallel. Fastest results but uses more API calls."}
            </p>
          </div>

          {/* PDF Export */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={exportPdf}
              onChange={(e) => setExportPdf(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary/50"
            />
            <span className="text-xs font-medium text-foreground">
              Also export as PDF
            </span>
          </label>
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
