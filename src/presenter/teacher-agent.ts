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

    const currentChapterContext = this.buildContext(presentation, payload.chapterIndex);
    const fullTranscript = this.getFullTranscript(presentation);

    // Search knowledge base for additional context (RAG)
    let ragContext = "";
    if (this.knowledge) {
      try {
        const results = await this.knowledge.search(payload.question, 8);
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
      "You are a knowledgeable, approachable teacher answering questions during a video presentation.",
      "",
      "You have these sources of information:",
      "1. The presentation transcript (current chapter + full transcript).",
      "2. Knowledge base references retrieved from the system.",
      "3. Your own general knowledge.",
      "",
      "ANSWERING STRATEGY (in priority order):",
      "1. First, check the presentation transcript and knowledge base. If they contain the answer, use them.",
      "2. If the question goes DEEPER into the presentation's subject matter — a follow-up, a related concept,",
      "   how it connects to other topics in the same domain — use your general knowledge to give a helpful answer.",
      "   A good teacher doesn't stop at the textbook. Students naturally want to explore beyond the slides.",
      "3. When using general knowledge, briefly note that you're going beyond the presentation material",
      "   so students understand the distinction.",
      "",
      "TOPIC GUARDRAILS:",
      "- The presentation's subject matter defines the domain. Questions that reasonably relate to that domain are fair game.",
      "- Politely decline questions that are clearly off-topic (unrelated to the presentation's domain),",
      "  inappropriate, or harmful. A brief redirect like \"That's outside the scope of today's topic\" is fine.",
      "- Do NOT answer questions about violence, hate speech, illegal activities, or other harmful content.",
      "",
      "FORMAT:",
      "- Use Mermaid diagrams (```mermaid\\n...\\n```) when a visual would help explain a concept.",
      "- When generating Mermaid diagrams, quote any node labels that contain parentheses or special characters, e.g. [\"Label (with parens)\"].",
      "- Keep answers concise but thorough. Aim for clarity over brevity.",
    ].join("\n");

    const sections = [
      `## Presentation Title: ${presentation.title}`,
      "",
      "## Current Chapter Context",
      `Chapter ${payload.chapterIndex + 1}:`,
      currentChapterContext,
    ];

    // Include full transcript if it differs from the chapter context
    if (fullTranscript && fullTranscript !== currentChapterContext) {
      sections.push(
        "",
        "## Full Presentation Transcript",
        fullTranscript,
      );
    }

    if (ragContext) {
      sections.push(
        "",
        "## Knowledge Base References",
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

  private getFullTranscript(presentation: PresentationRow): string {
    try {
      const scripts = JSON.parse(presentation.script_json) as Array<{ text: string }>;
      const full = scripts.map((s) => s.text).filter(Boolean).join(" ");
      // Cap at 8000 chars to stay within context limits
      return full.length > 8000 ? full.slice(0, 8000) + "…" : full;
    } catch {
      return "";
    }
  }
}
