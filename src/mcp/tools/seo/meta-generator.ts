/**
 * SEO Title & Meta Description AI Generator (#878)
 *
 * Uses the LLM (via copilot-wrapper) to generate optimized
 * title and meta description variants for a given URL/content.
 */

import * as z from "zod";
import type { ToolDefinition } from "../../tool-registry.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface MetaVariant {
  text: string;
  charCount: number;
  pixelWidthEstimate: number;
}

export interface MetaSuggestions {
  titles: MetaVariant[];
  descriptions: MetaVariant[];
  keyword: string;
  sourceUrl?: string;
}

// ── Pixel Width Estimation ───────────────────────────────────────────────

/**
 * Estimate pixel width of text in Google SERPs.
 * Google uses ~8.5px average character width for title links (Arial 18–20px).
 * Descriptions use ~6px avg (Arial 14px).
 */
export function estimateTitlePixelWidth(text: string): number {
  // Approximate: uppercase/wide chars ~10px, lowercase ~7px, spaces ~4px
  let width = 0;
  for (const char of text) {
    if (char === " ") width += 4;
    else if (/[A-Z@MW]/.test(char)) width += 10;
    else if (/[a-z]/.test(char)) width += 7;
    else if (/[0-9]/.test(char)) width += 8;
    else width += 7;
  }
  return Math.round(width);
}

export function estimateDescriptionPixelWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === " ") width += 3;
    else if (/[A-Z@MW]/.test(char)) width += 8;
    else if (/[a-z]/.test(char)) width += 6;
    else if (/[0-9]/.test(char)) width += 6;
    else width += 6;
  }
  return Math.round(width);
}

// ── LLM Prompt Builder ──────────────────────────────────────────────────

export function buildMetaGenerationPrompt(
  keyword: string,
  url?: string,
  content?: string,
): string {
  const parts = [
    "Generate SEO-optimized meta tags for a web page.",
    `Target keyword: "${keyword}"`,
  ];
  if (url) parts.push(`URL: ${url}`);
  if (content) {
    parts.push(
      `Page content excerpt (first 500 chars): ${content.slice(0, 500)}`,
    );
  }
  parts.push(
    "",
    "Generate exactly 3 title variants and 3 meta description variants.",
    "",
    "Title rules:",
    "- Under 60 characters each",
    "- Place the target keyword near the front",
    "- Use action verbs (e.g., Learn, Discover, Get, Master)",
    "- Make each variant distinct in style",
    "",
    "Description rules:",
    "- Under 160 characters each",
    "- Include the target keyword naturally",
    "- Include a call-to-action",
    "- Make each variant distinct in approach",
    "",
    "Return ONLY valid JSON in this exact format, no markdown or extra text:",
    '{"titles":["title1","title2","title3"],"descriptions":["desc1","desc2","desc3"]}',
  );
  return parts.join("\n");
}

// ── Parse LLM Response ──────────────────────────────────────────────────

export function parseLlmMetaResponse(
  raw: string,
  keyword: string,
  url?: string,
): MetaSuggestions {
  // Extract JSON from the response (handle markdown code blocks)
  const jsonMatch = raw.match(
    /\{[\s\S]*"titles"[\s\S]*"descriptions"[\s\S]*\}/,
  );
  if (!jsonMatch) {
    return {
      titles: [],
      descriptions: [],
      keyword,
      sourceUrl: url,
    };
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    titles?: string[];
    descriptions?: string[];
  };

  const titles: MetaVariant[] = (parsed.titles ?? [])
    .slice(0, 3)
    .map((text: string) => ({
      text,
      charCount: text.length,
      pixelWidthEstimate: estimateTitlePixelWidth(text),
    }));

  const descriptions: MetaVariant[] = (parsed.descriptions ?? [])
    .slice(0, 3)
    .map((text: string) => ({
      text,
      charCount: text.length,
      pixelWidthEstimate: estimateDescriptionPixelWidth(text),
    }));

  return { titles, descriptions, keyword, sourceUrl: url };
}

// ── Zod Schema ───────────────────────────────────────────────────────────

const metaGeneratorSchema = z.object({
  keyword: z.string().min(1).describe("Target keyword for the meta tags"),
  url: z.string().url().optional().describe("URL of the page (optional)"),
  content: z
    .string()
    .optional()
    .describe("Page content or excerpt (optional, helps generate better tags)"),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createMetaGeneratorTool(
  chatFn: (prompt: string) => Promise<string>,
): ToolDefinition {
  return {
    name: "seo-meta-generator",
    description:
      "Generate SEO-optimized title and meta description variants using AI. " +
      "Produces 3 title variants (<60 chars) and 3 description variants (<160 chars) " +
      "with the target keyword optimally placed.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Target keyword",
        },
        url: {
          type: "string",
          description: "Page URL (optional)",
        },
        content: {
          type: "string",
          description: "Page content or excerpt (optional)",
        },
      },
      required: ["keyword"],
    },
    zodSchema: metaGeneratorSchema,
    category: "search",
    riskLevel: "low",
    handler: async (args) => {
      const { keyword, url, content } = metaGeneratorSchema.parse(args);
      const prompt = buildMetaGenerationPrompt(keyword, url, content);

      try {
        const llmResponse = await chatFn(prompt);
        const suggestions = parseLlmMetaResponse(llmResponse, keyword, url);
        return { text: JSON.stringify(suggestions, null, 2) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: `Meta generation failed: ${msg}`, isError: true };
      }
    },
  };
}
