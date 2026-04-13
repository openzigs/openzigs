/**
 * Shared prompt-building functions used by the SEO Suite page and
 * (legacy) Workbench dialog components.
 *
 * Every function returns a deterministic prompt string that will be
 * emitted via Socket.IO `chat:message` to invoke the appropriate MCP tool.
 */

// ── Firecrawl-based prompts (originally in crawl-dashboard.tsx) ──────────

export function buildSiteAuditPrompt(
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

export function buildIngestPrompt(
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

export function buildMonitorPrompt(
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

export function buildExtractPrompt(
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

export function buildLeadPrompt(
  url: string,
  maxPages: number,
  outputTo?: {
    type: "airtable";
    baseId: string;
    tableIdOrName: string;
  } | {
    type: "sheets";
    spreadsheetId: string;
    range: string;
  },
): string {
  const args: Record<string, unknown> = { url, maxPages };
  if (outputTo) args.outputTo = outputTo;
  return [
    `Use the lead-extract tool to find contacts and company info.`,
    ``,
    `Call the lead-extract tool with:`,
    "```json",
    JSON.stringify(args, null, 2),
    "```",
    ``,
    `Present the extracted contacts in a clean table format.`,
  ].join("\n");
}

export function buildPricePrompt(
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

export function buildDatasetPrompt(
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

// ── SEO Gap Analysis prompt (originally in seo-analysis-dialog.tsx) ──────

export type OrchestrationMode = "standard" | "session" | "task";

export interface SeoGapAnalysisParams {
  targetUrl: string;
  targetKeyword: string;
  searchProvider: string;
  exportPdf: boolean;
  orchestrationMode: OrchestrationMode;
}

export function buildSeoGapAnalysisPrompt(
  params: SeoGapAnalysisParams,
): string {
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

/** Tool lists per mode, for the `tools` field of `chat:message`. */
export function getSeoGapAnalysisTools(mode: OrchestrationMode): string[] {
  return [
    "seo-gap-analysis",
    "seo-extract-content",
    "export-pdf",
    "web-search",
    "browser-navigate",
    "read-file",
    "write-file",
    "list-directory",
    ...(mode === "task" ? ["orchestrate-agents", "spawn-agent"] : []),
    ...(mode === "session" ? ["orchestrate-agents"] : []),
  ];
}

/** Tool list for Firecrawl-based modes. */
export const FIRECRAWL_TOOLS = [
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
];
