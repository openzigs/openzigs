import type { ExtractedContent } from "./html-extractor.js";
import type { CompetitorDiscoveryResult } from "./competitor-discovery.js";

export type AnalysisInput = {
  targetUrl: string;
  targetKeyword: string;
  targetContent: ExtractedContent;
  competitors: (ExtractedContent & { url: string })[];
  serpFeatures: CompetitorDiscoveryResult["serpFeatures"];
};

/**
 * Build the LLM analysis prompt for the SEO strategist.
 * Returns a comprehensive prompt with all extracted data embedded.
 */
export function buildAnalysisPrompt(input: AnalysisInput): string {
  const { targetUrl, targetKeyword, targetContent, competitors, serpFeatures } = input;

  const lines: string[] = [];
  lines.push("You are an expert SEO strategist and content analyst. Analyze the content gap between the target page and its top-ranking competitors.");
  lines.push("");
  lines.push(`## Target Page`);
  lines.push(`- **URL**: ${targetUrl}`);
  lines.push(`- **Keyword**: ${targetKeyword}`);
  lines.push(`- **Title**: ${targetContent.title}`);
  lines.push(`- **Word Count**: ${targetContent.wordCount}`);
  lines.push(`- **Headings**: ${targetContent.headingCount}`);
  lines.push(`- **Reading Time**: ${targetContent.readingTime} min`);
  lines.push(`- **Readability (Flesch-Kincaid)**: ${targetContent.readabilityScore}`);
  lines.push(`- **Top Keywords**: ${targetContent.keywords.slice(0, 10).map((k) => `${k.term} (${k.tfidf})`).join(", ")}`);
  lines.push("");
  lines.push("### Target Headings");
  for (const h of targetContent.headings) {
    lines.push(`${"  ".repeat(h.level - 1)}- H${h.level}: ${h.text}`);
  }

  lines.push("");
  lines.push("## Competitors");
  for (const comp of competitors) {
    lines.push("");
    lines.push(`### ${comp.url}`);
    lines.push(`- **Title**: ${comp.title}`);
    lines.push(`- **Word Count**: ${comp.wordCount}`);
    lines.push(`- **Headings**: ${comp.headingCount}`);
    lines.push(`- **Reading Time**: ${comp.readingTime} min`);
    lines.push(`- **Readability**: ${comp.readabilityScore}`);
    lines.push(`- **Top Keywords**: ${comp.keywords.slice(0, 10).map((k) => `${k.term} (${k.tfidf})`).join(", ")}`);
    lines.push("#### Competitor Headings");
    for (const h of comp.headings) {
      lines.push(`${"  ".repeat(h.level - 1)}- H${h.level}: ${h.text}`);
    }
  }

  if (serpFeatures.paa.length > 0) {
    lines.push("");
    lines.push("## SERP Features — People Also Ask");
    for (const q of serpFeatures.paa) {
      lines.push(`- ${q}`);
    }
  }

  if (serpFeatures.relatedSearches.length > 0) {
    lines.push("");
    lines.push("## Related Searches");
    for (const q of serpFeatures.relatedSearches) {
      lines.push(`- ${q}`);
    }
  }

  if (serpFeatures.featuredSnippet) {
    lines.push("");
    lines.push(`## Featured Snippet`);
    lines.push(serpFeatures.featuredSnippet);
  }

  lines.push("");
  lines.push("## Your Task");
  lines.push("Generate a comprehensive SEO gap analysis report in Markdown with these sections:");
  lines.push("1. **Executive Summary** — Overall gap score (0–100) and key findings");
  lines.push("2. **Content Metrics Comparison Table** — Side-by-side: URL, Word Count, Headings, Reading Time, Readability, Keywords");
  lines.push("3. **Radar Chart** — Mermaid radar chart comparing target vs avg competitor across: Word Count, Keywords, Headings, Readability, Depth");
  lines.push("4. **Semantic Gap Analysis** — Missing subtopics, underserved entities, keyword gaps");
  lines.push("5. **Header Structure Comparison** — Target H1/H2 vs Competitor H1/H2 trees");
  lines.push("6. **Keyword Density Comparison** — Table of top keywords with presence per page");
  lines.push("7. **SERP Feature Opportunities** — PAA questions to target, featured snippet optimization");
  lines.push("8. **Actionable Recommendations** — Prioritized by impact (high/medium/low)");
  lines.push("9. **Content Brief** — Outline for updating the target page");
  lines.push("");
  lines.push("Use tables, bullet lists, and Mermaid diagrams. Be specific with data from the analysis above.");

  return lines.join("\n");
}

/**
 * Generate a static metrics-only markdown report (no LLM needed).
 * Used as a fallback or quick summary.
 */
export function generateMetricsReport(input: AnalysisInput): string {
  const { targetUrl, targetKeyword, targetContent, competitors, serpFeatures } = input;
  const now = new Date().toISOString().split("T")[0];

  const lines: string[] = [];
  lines.push(`# SEO Gap Analysis: "${targetKeyword}"`);
  lines.push(`> Generated ${now} for ${targetUrl}`);
  lines.push("");

  // Metrics comparison table
  lines.push("## Content Metrics Comparison");
  lines.push("");
  lines.push("| Page | Words | Headings | Reading Time | Readability |");
  lines.push("|------|------:|:--------:|:------------:|:-----------:|");
  lines.push(`| **Target** | ${targetContent.wordCount} | ${targetContent.headingCount} | ${targetContent.readingTime} min | ${targetContent.readabilityScore} |`);
  for (const comp of competitors) {
    const name = new URL(comp.url).hostname;
    lines.push(`| ${name} | ${comp.wordCount} | ${comp.headingCount} | ${comp.readingTime} min | ${comp.readabilityScore} |`);
  }

  // Compute averages for radar
  const avgWords = competitors.length > 0
    ? Math.round(competitors.reduce((s, c) => s + c.wordCount, 0) / competitors.length)
    : 0;
  const avgHeadings = competitors.length > 0
    ? Math.round(competitors.reduce((s, c) => s + c.headingCount, 0) / competitors.length)
    : 0;
  const avgReadability = competitors.length > 0
    ? Math.round(competitors.reduce((s, c) => s + c.readabilityScore, 0) / competitors.length * 10) / 10
    : 0;
  const avgKeywords = competitors.length > 0
    ? Math.round(competitors.reduce((s, c) => s + c.keywords.length, 0) / competitors.length)
    : 0;

  // Mermaid radar chart (xychart is more widely supported than radar)
  lines.push("");
  lines.push("## Content Dimensions");
  lines.push("");
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push(`  title "Target vs Competitor Average"`);
  lines.push(`  x-axis ["Words (÷100)", "Headings", "Keywords", "Read Time", "Readability (÷10)"]`);
  lines.push(`  y-axis "Score" 0 --> ${Math.max(Math.round(avgWords / 100), Math.round(targetContent.wordCount / 100), 30) + 5}`);
  lines.push(`  bar [${Math.round(targetContent.wordCount / 100)}, ${targetContent.headingCount}, ${targetContent.keywords.length}, ${targetContent.readingTime}, ${Math.round(targetContent.readabilityScore / 10)}]`);
  lines.push(`  bar [${Math.round(avgWords / 100)}, ${avgHeadings}, ${avgKeywords}, ${competitors.length > 0 ? Math.round(competitors.reduce((s, c) => s + c.readingTime, 0) / competitors.length) : 0}, ${Math.round(avgReadability / 10)}]`);
  lines.push("```");

  // Header comparison
  lines.push("");
  lines.push("## Header Structure");
  lines.push("");
  lines.push("### Target");
  for (const h of targetContent.headings) {
    lines.push(`${"  ".repeat(h.level - 1)}- **H${h.level}**: ${h.text}`);
  }
  for (const comp of competitors) {
    lines.push("");
    lines.push(`### ${new URL(comp.url).hostname}`);
    for (const h of comp.headings.slice(0, 15)) {
      lines.push(`${"  ".repeat(h.level - 1)}- **H${h.level}**: ${h.text}`);
    }
  }

  // Keyword density comparison
  lines.push("");
  lines.push("## Keyword Coverage");
  lines.push("");
  const allTerms = new Map<string, Map<string, number>>();
  const addTerms = (label: string, keywords: { term: string; tfidf: number }[]) => {
    for (const k of keywords.slice(0, 10)) {
      if (!allTerms.has(k.term)) allTerms.set(k.term, new Map());
      allTerms.get(k.term)!.set(label, k.tfidf);
    }
  };
  addTerms("Target", targetContent.keywords);
  for (const comp of competitors) {
    addTerms(new URL(comp.url).hostname, comp.keywords);
  }

  const columnLabels = ["Target", ...competitors.map((c) => new URL(c.url).hostname)];
  lines.push(`| Keyword | ${columnLabels.join(" | ")} |`);
  lines.push(`|---------|${columnLabels.map(() => ":---:").join("|")}|`);
  for (const [term, scores] of allTerms) {
    const cells = columnLabels.map((l) => {
      const v = scores.get(l);
      return v !== undefined ? String(v) : "—";
    });
    lines.push(`| ${term} | ${cells.join(" | ")} |`);
  }

  // SERP features
  if (serpFeatures.paa.length > 0 || serpFeatures.relatedSearches.length > 0) {
    lines.push("");
    lines.push("## SERP Feature Opportunities");
    if (serpFeatures.paa.length > 0) {
      lines.push("");
      lines.push("### People Also Ask");
      for (const q of serpFeatures.paa) {
        lines.push(`- ${q}`);
      }
    }
    if (serpFeatures.relatedSearches.length > 0) {
      lines.push("");
      lines.push("### Related Searches");
      for (const q of serpFeatures.relatedSearches) {
        lines.push(`- ${q}`);
      }
    }
    if (serpFeatures.featuredSnippet) {
      lines.push("");
      lines.push("### Current Featured Snippet");
      lines.push(`> ${serpFeatures.featuredSnippet}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Build the file name for saving the report.
 * Format: `<domain>-<keyword-slug>-<YYYY-MM-DD>.md`
 */
export function buildReportFilename(targetUrl: string, keyword: string): string {
  let domain: string;
  try {
    domain = new URL(targetUrl).hostname.replace(/^www\./, "");
  } catch {
    domain = "unknown";
  }
  const slug = keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  const date = new Date().toISOString().split("T")[0];
  return `${domain}-${slug}-${date}.md`;
}
