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
  lines.push(`- **Meta Title**: "${targetContent.metaTitle}" (${targetContent.metaTitle.length} chars)`);
  lines.push(`- **Meta Description**: "${targetContent.metaDescription.slice(0, 80)}${targetContent.metaDescription.length > 80 ? "…" : ""}" (${targetContent.metaDescription.length} chars)`);
  lines.push(`- **Schema Types**: ${targetContent.schemaMarkup.map((s) => s.type).join(", ") || "None"}`);
  lines.push(`- **Images**: ${targetContent.images.length} total, ${targetContent.imagesWithoutAlt} missing alt text`);
  lines.push(`- **Internal Links**: ${targetContent.internalLinkCount}`);
  lines.push(`- **External Links**: ${targetContent.externalLinkCount}`);
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
    lines.push(`- **Schema Types**: ${comp.schemaMarkup.map((s) => s.type).join(", ") || "None"}`);
    lines.push(`- **Images**: ${comp.images.length} total, ${comp.imagesWithoutAlt} missing alt`);
    lines.push(`- **Internal Links**: ${comp.internalLinkCount}, **External Links**: ${comp.externalLinkCount}`);
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
  lines.push("Generate a comprehensive SEO gap analysis. Focus on these areas IN ORDER OF IMPORTANCE:");
  lines.push("");
  lines.push("1. **Content Depth & Topical Coverage** — What subtopics do competitors cover that the target misses? What entities/concepts are underrepresented? This is the #1 ranking factor for blog content.");
  lines.push("");
  lines.push("2. **Search Intent Alignment** — Does the target page match the dominant search intent for this keyword? Is the content format right (how-to, listicle, comparison, guide)?");
  lines.push("");
  lines.push("3. **Semantic Gap Analysis** — Beyond keyword matching, what CONCEPTS and ENTITIES are competitors covering that the target lacks? Use the TF-IDF keyword data to identify semantic gaps.");
  lines.push("");
  lines.push("4. **E-E-A-T Signals** — Does the target demonstrate Experience, Expertise, Authority, Trust? Author bio? Original data/images? Credible external references?");
  lines.push("");
  lines.push("5. **Internal Linking Opportunities** — How does the target's internal linking compare? Are there topic cluster opportunities?");
  lines.push("");
  lines.push("6. **SERP Feature Targeting** — Based on PAA questions and featured snippets, what content additions would capture SERP features?");
  lines.push("");
  lines.push("7. **Technical SEO Gaps** — Schema markup, meta tag optimization, image alt text, Core Web Vitals implications.");
  lines.push("");
  lines.push("8. **Actionable Content Brief** — Prioritized recommendations with Impact (High/Medium/Low) and Effort (High/Medium/Low) ratings.");
  lines.push("");
  lines.push("DO NOT spend more than one short section on header structure. Headers are a minor signal — topical depth, semantic coverage, and intent alignment matter far more.");
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

  // ── Competitor Articles ────────────────────────────────────────────────
  if (competitors.length > 0) {
    lines.push("## Competitor Articles Analyzed");
    lines.push("");
    for (let i = 0; i < competitors.length; i++) {
      const comp = competitors[i];
      const hostname = new URL(comp.url).hostname;
      lines.push(`${i + 1}. [${comp.title || hostname}](${comp.url}) — ${comp.wordCount} words, ${comp.headingCount} headings`);
    }
    lines.push("");
  }

  // ── Target Page SEO Audit ──────────────────────────────────────────────
  lines.push("## Target Page SEO Audit");
  lines.push("");
  lines.push("### Content Quality");
  const wordCountIcon = targetContent.wordCount >= 1500 ? "✅" : targetContent.wordCount >= 800 ? "⚠️" : "❌";
  const readingLevel = targetContent.readabilityScore >= 60 ? "Good for general audience" : targetContent.readabilityScore >= 30 ? "Moderate difficulty" : "Advanced reading level";
  lines.push(`- **Word Count**: ${targetContent.wordCount} ${wordCountIcon} (Recommended: 1500–2500 for competitive blog posts)`);
  lines.push(`- **Readability Score**: ${targetContent.readabilityScore} (${readingLevel})`);
  lines.push(`- **Reading Time**: ${targetContent.readingTime} min`);
  lines.push(`- **Unique Keywords (TF-IDF)**: ${targetContent.keywords.length}`);
  lines.push("");
  lines.push("### Meta Tags");
  const titleLen = targetContent.metaTitle.length;
  const titleIcon = titleLen >= 50 && titleLen <= 60 ? "✅" : titleLen < 30 || titleLen > 70 ? "❌" : "⚠️";
  lines.push(`- **Title**: "${targetContent.metaTitle}" (${titleLen} chars) — ${titleIcon} ${titleLen >= 50 && titleLen <= 60 ? "Optimal" : titleLen < 30 ? "Too short. Recommended: 50–60 chars" : titleLen > 70 ? "Too long. Recommended: 50–60 chars" : "Slightly off. Recommended: 50–60 chars"}`);
  const descLen = targetContent.metaDescription.length;
  const descIcon = descLen >= 120 && descLen <= 160 ? "✅" : descLen === 0 ? "❌" : "⚠️";
  lines.push(`- **Description**: "${targetContent.metaDescription.slice(0, 80)}${descLen > 80 ? "…" : ""}" (${descLen} chars) — ${descIcon} ${descLen >= 120 && descLen <= 160 ? "Within range" : descLen === 0 ? "Missing! Add a meta description" : "Recommended: 120–160 chars"}`);
  lines.push("");
  lines.push("### Technical SEO");
  const schemaTypes = targetContent.schemaMarkup.map((s) => s.type);
  lines.push(`- **Schema Markup**: ${schemaTypes.length > 0 ? schemaTypes.join(", ") + " ✅" : "None ⚠️ — Consider adding Article, FAQPage, or HowTo schema"}`);
  const altIcon = targetContent.imagesWithoutAlt > 0 ? "⚠️" : "✅";
  lines.push(`- **Images**: ${targetContent.images.length} total, ${targetContent.imagesWithoutAlt} missing alt text ${altIcon}`);
  lines.push(`- **Internal Links**: ${targetContent.internalLinkCount}${targetContent.internalLinkCount < 5 ? " ⚠️ Could be improved" : " ✅"}`);
  lines.push(`- **External Links**: ${targetContent.externalLinkCount}`);
  lines.push("");
  lines.push("### Top Keywords (TF-IDF)");
  for (let i = 0; i < Math.min(10, targetContent.keywords.length); i++) {
    const k = targetContent.keywords[i];
    lines.push(`${i + 1}. ${k.term} (${k.tfidf})`);
  }
  lines.push("");

  // ── Topic Landscape ────────────────────────────────────────────────────
  if (serpFeatures.paa.length > 0 || serpFeatures.relatedSearches.length > 0 || serpFeatures.featuredSnippet) {
    lines.push("## Topic Landscape");
    lines.push("");
    lines.push("### Search Intent Analysis");
    lines.push(`Based on SERP analysis for "${targetKeyword}", the dominant content types suggest the search intent is **informational/how-to**.`);
    lines.push("");

    if (serpFeatures.paa.length > 0) {
      lines.push("### People Also Ask (Opportunities)");
      lines.push("These questions appear in the SERP and represent content gap opportunities:");
      for (const q of serpFeatures.paa) {
        lines.push(`- ${q}`);
      }
      lines.push("");
    }

    if (serpFeatures.relatedSearches.length > 0) {
      lines.push("### Related Searches");
      for (const q of serpFeatures.relatedSearches) {
        lines.push(`- ${q}`);
      }
      lines.push("");
    }

    if (serpFeatures.featuredSnippet) {
      lines.push("### Featured Snippet Status");
      lines.push(`> ${serpFeatures.featuredSnippet}`);
      lines.push("");
    } else {
      lines.push("### Featured Snippet Status");
      lines.push("No featured snippet detected — **opportunity to capture** by adding structured answers.");
      lines.push("");
    }
  }

  // ── Content Gap Score ──────────────────────────────────────────────────
  if (competitors.length > 0) {
    lines.push("## Content Gap Score");
    lines.push("");
    const avgCompWords = Math.round(competitors.reduce((s, c) => s + c.wordCount, 0) / competitors.length);
    const gapScore = avgCompWords > 0 ? Math.round(((avgCompWords - targetContent.wordCount) / avgCompWords) * 100) : 0;
    const gapLabel = gapScore > 30 ? "❌ Significant gap" : gapScore > 10 ? "⚠️ Moderate gap" : gapScore > 0 ? "✅ Competitive" : "✅ Above average";
    lines.push(`- **Competitor Avg Word Count**: ${avgCompWords}`);
    lines.push(`- **Target Word Count**: ${targetContent.wordCount}`);
    lines.push(`- **Content Gap**: ${gapScore > 0 ? gapScore : 0}% ${gapLabel}`);
    lines.push("");

    // Topical coverage gap — keywords present in competitors but missing from target
    const targetTerms = new Set(targetContent.keywords.map((k) => k.term));
    const missingTerms: { term: string; competitorCount: number }[] = [];
    const termCounts = new Map<string, number>();
    for (const comp of competitors) {
      for (const k of comp.keywords.slice(0, 15)) {
        if (!targetTerms.has(k.term)) {
          termCounts.set(k.term, (termCounts.get(k.term) ?? 0) + 1);
        }
      }
    }
    for (const [term, count] of termCounts) {
      if (count >= 2) missingTerms.push({ term, competitorCount: count });
    }
    missingTerms.sort((a, b) => b.competitorCount - a.competitorCount);

    if (missingTerms.length > 0) {
      lines.push("### Topical Coverage Gaps");
      lines.push("Keywords appearing in multiple competitors but missing from target:");
      lines.push("");
      lines.push("| Keyword | Competitors Using |");
      lines.push("|---------|:-----------------:|");
      for (const t of missingTerms.slice(0, 15)) {
        lines.push(`| ${t.term} | ${t.competitorCount}/${competitors.length} |`);
      }
      lines.push("");
    }
  }

  // Metrics comparison table
  lines.push("## Content Metrics Comparison");
  lines.push("");
  lines.push("| Page | Words | Headings | Reading Time | Readability |");
  lines.push("|------|------:|:--------:|:------------:|:-----------:|");
  lines.push(`| **Target** | ${targetContent.wordCount} | ${targetContent.headingCount} | ${targetContent.readingTime} min | ${targetContent.readabilityScore} |`);
  for (const comp of competitors) {
    const name = new URL(comp.url).hostname;
    lines.push(`| [${name}](${comp.url}) | ${comp.wordCount} | ${comp.headingCount} | ${comp.readingTime} min | ${comp.readabilityScore} |`);
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

  // Keyword density comparison (moved before headers — more important)
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

  // On-Page SEO Signals
  lines.push("");
  lines.push("## On-Page SEO Signals");
  lines.push("");
  lines.push("| Page | Meta Title (len) | Meta Description (len) | Schema Types | Images | Imgs No Alt | Internal Links | External Links |");
  lines.push("|------|:----------------:|:---------------------:|:------------:|:------:|:-----------:|:--------------:|:--------------:|");
  const targetSchemaTypes = targetContent.schemaMarkup.map((s) => s.type).join(", ") || "None";
  lines.push(`| **Target** | ${targetContent.metaTitle.length} | ${targetContent.metaDescription.length} | ${targetSchemaTypes} | ${targetContent.images.length} | ${targetContent.imagesWithoutAlt} | ${targetContent.internalLinkCount} | ${targetContent.externalLinkCount} |`);
  for (const comp of competitors) {
    const name = new URL(comp.url).hostname;
    const compSchemaTypes = comp.schemaMarkup.map((s) => s.type).join(", ") || "None";
    lines.push(`| [${name}](${comp.url}) | ${comp.metaTitle.length} | ${comp.metaDescription.length} | ${compSchemaTypes} | ${comp.images.length} | ${comp.imagesWithoutAlt} | ${comp.internalLinkCount} | ${comp.externalLinkCount} |`);
  }

  // Schema Markup Comparison
  const allSchemaPages = [
    { label: "Target", schemas: targetContent.schemaMarkup },
    ...competitors.map((c) => ({ label: new URL(c.url).hostname, schemas: c.schemaMarkup })),
  ];
  const hasAnySchema = allSchemaPages.some((p) => p.schemas.length > 0);
  if (hasAnySchema) {
    lines.push("");
    lines.push("## Schema Markup Comparison");
    lines.push("");
    for (const page of allSchemaPages) {
      if (page.schemas.length > 0) {
        lines.push(`### ${page.label}`);
        for (const s of page.schemas) {
          lines.push(`- **${s.type}**: ${s.properties.slice(0, 8).join(", ")}`);
        }
        lines.push("");
      }
    }
  }

  // Internal Linking Profile
  lines.push("");
  lines.push("## Internal Linking Profile");
  lines.push("");
  lines.push("| Page | Internal Links | External Links |");
  lines.push("|------|:--------------:|:--------------:|");
  lines.push(`| **Target** | ${targetContent.internalLinkCount} | ${targetContent.externalLinkCount} |`);
  for (const comp of competitors) {
    const name = new URL(comp.url).hostname;
    lines.push(`| [${name}](${comp.url}) | ${comp.internalLinkCount} | ${comp.externalLinkCount} |`);
  }

  // Header comparison (moved to near end — less important than topical depth)
  lines.push("");
  lines.push("<details>");
  lines.push("<summary><strong>Header Structure Comparison</strong></summary>");
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
  lines.push("");
  lines.push("</details>");

  // SERP features (kept for completeness, but Topic Landscape section above is primary)
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
 * Extract sanitized domain from a URL (for use as a subdirectory name).
 */
export function buildReportSubdir(targetUrl: string): string {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Build the file name for saving the report.
 * Format: `<domain>-<keyword-slug>-<YYYY-MM-DD>.md`
 */
export function buildReportFilename(targetUrl: string, keyword: string): string {
  const domain = buildReportSubdir(targetUrl);
  const slug = keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  const date = new Date().toISOString().split("T")[0];
  return `${domain}-${slug}-${date}.md`;
}
