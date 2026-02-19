/**
 * Presenter Mode — Teacher Agent
 * Issue #279 (SI-4): RAG Q&A powered by CopilotWrapper.
 *
 * Streams answers back through an AsyncGenerator so the socket handler
 * can emit token-by-token to the client.
 *
 * Enhanced: searches the knowledge base (RAG) for additional context
 * beyond the presentation script, and combines both sources to give
 * comprehensive, pertinent answers.
 */

import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { PresentationRepository, PresentationRow } from "./presentation-repository.js";
import type { KnowledgeIngestionService } from "../knowledge/knowledge-service.js";
import { logger } from "../logging/logger.js";

export interface TeacherAgentDeps {
  copilotWrapper: CopilotWrapper;
  presentationRepo: PresentationRepository;
  knowledgeService?: KnowledgeIngestionService;
}

interface AskPayload {
  presentationId: string;
  question: string;
  chapterIndex: number;
  timestamp: number;
}

export class TeacherAgent {
  private copilot: CopilotWrapper;
  private repo: PresentationRepository;
  private knowledge?: KnowledgeIngestionService;

  constructor({ copilotWrapper, presentationRepo, knowledgeService }: TeacherAgentDeps) {
    this.copilot = copilotWrapper;
    this.repo = presentationRepo;
    this.knowledge = knowledgeService;
  }

  /**
   * Answer a student's question using presentation context + knowledge base RAG.
   * Returns an AsyncGenerator that yields tokens for streaming to the client.
   */
  async *ask(payload: AskPayload): AsyncGenerator<string> {
    const presentation = this.repo.findById(payload.presentationId);
    if (!presentation) {
      yield "I couldn't find this presentation. It may have been deleted.";
      return;
    }

    const chapterContext = this.buildContext(presentation, payload.chapterIndex);

    // Search knowledge base for additional context (RAG)
    let ragContext = "";
    if (this.knowledge) {
      try {
        const results = await this.knowledge.search(payload.question, 5);
        if (results.length > 0) {
          ragContext = results
            .map((r, i) => `[${i + 1}] ${r.text}`)
            .join("\n\n");
        }
      } catch (err) {
        logger.warn(`Knowledge search failed during Q&A: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const systemPrompt = [
      "You are a teacher explaining concepts from a specific video presentation.",
      "Your ONLY sources of information are:",
      "1. The presentation transcript/script provided below — this is your PRIMARY and authoritative source.",
      "2. Knowledge base references (if provided) — only use these if they are clearly relevant to the same topic as the presentation.",
      "",
      "STRICT GUIDELINES:",
      "- ONLY answer using the provided presentation content and knowledge base references.",
      "- Do NOT use your general training knowledge about topics not covered in the provided context.",
      "- If the question asks about something not in the provided context, say: \"That topic isn't covered in this presentation's content.\"",
      "- Never substitute unrelated content from the knowledge base if it doesn't match the presentation topic.",
      "- Use Mermaid diagrams (```mermaid\n...\n```) when a visual would help explain something FROM the presentation.",
      "- When generating Mermaid diagrams, quote any node labels that contain parentheses or special characters, e.g. [\"Label (with parens)\"].",
      "- Keep answers concise and grounded in the provided material.",
    ].join("\n");

    const sections = [
      `## Presentation Title: ${presentation.title}`,
      "",
      "## Presentation Script (PRIMARY SOURCE — answer ONLY from this content)",
      `Chapter ${payload.chapterIndex + 1} context:`,
      chapterContext,
    ];

    if (ragContext) {
      sections.push(
        "",
        "## Supplementary Knowledge Base References (only use if directly relevant to the presentation topic above)",
        ragContext,
      );
    }

    sections.push(
      "",
      `## Student Question (at ${Math.round(payload.timestamp)}s)`,
      payload.question,
    );

    yield* this.copilot.chat(sections.join("\n"), {
      systemMessage: { mode: "replace", content: systemPrompt },
      tools: [],
    });
  }

  private buildContext(
    presentation: PresentationRow,
    chapterIndex: number,
  ): string {
    try {
      const chapters = JSON.parse(presentation.chapters) as Array<{
        title: string;
        startSeconds: number;
        endSeconds: number;
      }>;
      const scripts = JSON.parse(presentation.script_json) as Array<{
        text: string;
        // Support both naming conventions used in different upload paths
        startTime?: number;
        endTime?: number;
        startSeconds?: number;
        endSeconds?: number;
      }>;

      const chapter = chapters[chapterIndex];
      if (!chapter) return this.truncateScript(scripts);

      // Get script segments within this chapter's time range.
      // Handle both startTime/endTime and startSeconds/endSeconds field names.
      const relevant = scripts.filter((s) => {
        const start = typeof s.startTime === "number" ? s.startTime : (s.startSeconds ?? NaN);
        const end = typeof s.endTime === "number" ? s.endTime : (s.endSeconds ?? NaN);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        return start < chapter.endSeconds && end > chapter.startSeconds;
      });

      if (relevant.length === 0) return this.truncateScript(scripts);

      return [
        `Chapter: "${chapter.title}" (${Math.round(chapter.startSeconds)}s – ${Math.round(chapter.endSeconds)}s)`,
        "",
        relevant.map((s) => s.text).join(" "),
      ].join("\n");
    } catch {
      return "(No script context available)";
    }
  }

  private truncateScript(
    scripts: Array<{ text: string }>,
  ): string {
    const full = scripts.map((s) => s.text).join(" ");
    return full.length > 4000 ? full.slice(0, 4000) + "…" : full;
  }
}
