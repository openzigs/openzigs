/**
 * Pitch — Markdown outline export (Phase 6 / sub-issue #973).
 *
 * Pure function. Takes a validated `Deck` and emits a Markdown outline:
 *   - One slide per `---` section
 *   - Per-template renderers for all 14 templates
 *   - Speaker notes appended as a `> ` block when present
 *
 * Markdown is a safe-by-default format — we do NOT need DOMPurify here.
 * Backticks inside user content are double-escaped so untrusted code
 * blocks can't terminate a fenced block early.
 */
import type { Deck, Slide } from "./pitch-schema.js";
import { safeFilename } from "./pitch-export-utils.js";

export interface ExportMarkdownResult {
  buffer: Buffer;
  filename: string;
  contentType: "text/markdown; charset=utf-8";
}

export function exportDeckToMarkdown(deck: Deck): ExportMarkdownResult {
  const text = buildMarkdown(deck);
  return {
    buffer: Buffer.from(text, "utf8"),
    filename: safeFilename(deck.title, deck.id, ".md"),
    contentType: "text/markdown; charset=utf-8",
  };
}

function buildMarkdown(deck: Deck): string {
  const header = [`# ${deck.title}`, ""];
  const meta: string[] = [];
  if (deck.metadata.audience) meta.push(`Audience: ${deck.metadata.audience}`);
  if (deck.metadata.tone) meta.push(`Tone: ${deck.metadata.tone}`);
  if (meta.length) header.push(`> ${meta.join(" · ")}`, "");

  const body = deck.slides.map((slide, i) => renderSlideMd(slide, i + 1));
  return [...header, ...body].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderSlideMd(slide: Slide, slideNumber: number): string {
  const sections: string[] = [`## Slide ${slideNumber}`, ""];

  switch (slide.template) {
    case "title": {
      sections.push(`# ${slide.content.title}`);
      if (slide.content.subtitle) sections.push("", `_${slide.content.subtitle}_`);
      if (slide.content.eyebrow) sections.push("", slide.content.eyebrow);
      break;
    }
    case "section_divider": {
      sections.push(`# Section ${slide.content.section_number}: ${slide.content.title}`);
      break;
    }
    case "bullet_list": {
      sections.push(`### ${slide.content.heading}`, "");
      for (const b of slide.content.bullets) sections.push(`- ${b}`);
      break;
    }
    case "two_column": {
      sections.push(`### ${slide.content.heading}`, "");
      if (slide.content.left) sections.push("**Left:**", "", slide.content.left);
      if (slide.content.right) sections.push("", "**Right:**", "", slide.content.right);
      break;
    }
    case "image_caption": {
      if (slide.content.heading) sections.push(`### ${slide.content.heading}`, "");
      const url = slide.content.image.url ?? "";
      const alt = slide.content.image.alt;
      sections.push(`![${alt}](${url})`);
      if (slide.content.caption) sections.push("", `_${slide.content.caption}_`);
      break;
    }
    case "quote": {
      sections.push(`> ${slide.content.quote}`, "", `— ${slide.content.attribution}`);
      if (slide.content.source) sections.push("", `Source: ${slide.content.source}`);
      break;
    }
    case "stats_kpi": {
      sections.push(`### ${slide.content.heading}`, "");
      for (const k of slide.content.kpis) {
        const delta = k.delta ? ` (${k.delta})` : "";
        sections.push(`- **${k.value}** — ${k.label}${delta}`);
      }
      break;
    }
    case "comparison_table": {
      sections.push(`### ${slide.content.heading}`, "");
      const head = ["", ...slide.content.columns.map(escapeMdCell)];
      sections.push(`| ${head.join(" | ")} |`);
      sections.push(`| ${head.map(() => "---").join(" | ")} |`);
      for (const row of slide.content.rows) {
        const cells = [escapeMdCell(row.label), ...row.cells.map(escapeMdCell)];
        sections.push(`| ${cells.join(" | ")} |`);
      }
      break;
    }
    case "timeline": {
      sections.push(`### ${slide.content.heading}`, "");
      for (const ev of slide.content.events) {
        sections.push(`- **${ev.when}** — ${ev.what}`);
      }
      break;
    }
    case "full_bleed": {
      const url = slide.content.image.url ?? "";
      sections.push(`![${slide.content.image.alt}](${url})`);
      if (slide.content.overlay_text) sections.push("", slide.content.overlay_text);
      break;
    }
    case "code": {
      if (slide.content.heading) sections.push(`### ${slide.content.heading}`, "");
      const fence = "```";
      // Escape any embedded triple-backtick by replacing with a unicode
      // look-alike — keeps the markdown well-formed without losing intent.
      const safe = slide.content.code.replace(/```/g, "\u200B`\u200B`\u200B`");
      sections.push(`${fence}${slide.content.language}`, safe, fence);
      break;
    }
    case "qa": {
      sections.push(`### ${slide.content.heading || "Questions?"}`);
      if (slide.content.contact) sections.push("", slide.content.contact);
      break;
    }
    case "chart": {
      sections.push(`### ${slide.content.heading}`, "");
      sections.push(`_Chart: ${slide.content.chart_type}_`, "");
      for (const series of slide.content.series) {
        sections.push(`**${series.name}**`, "");
        sections.push("| x | y |", "| --- | --- |");
        for (const pt of series.data) sections.push(`| ${pt.x} | ${pt.y} |`);
        sections.push("");
      }
      break;
    }
    case "mermaid": {
      if (slide.content.heading) sections.push(`### ${slide.content.heading}`, "");
      sections.push("```mermaid", slide.content.source, "```");
      break;
    }
  }

  if (slide.speaker_notes && slide.speaker_notes.trim().length > 0) {
    sections.push("", `> _Speaker notes:_ ${slide.speaker_notes}`);
  }

  sections.push("", "---", "");
  return sections.join("\n");
}

/**
 * Escape a cell value for inclusion in a Markdown pipe-table. The pipe
 * character terminates a cell, so it must be backslash-escaped; embedded
 * newlines (literal `\n` or `\r`) break the row apart and must be replaced
 * with a `<br>` tag (rendered by every common Markdown engine). Backslashes
 * are escaped first so we don't double-escape the escape character.
 *
 * Sub-issue #977 — Phase 6 review left this as a follow-up: untrusted
 * `comparison_table` cells could otherwise inject extra columns or rows.
 */
export function escapeMdCell(value: string): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}
