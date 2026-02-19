/**
 * Presenter Mode — Teacher Agent
 * Issue #279 (SI-4): RAG Q&A powered by CopilotWrapper.
 *
 * Streams answers back through an AsyncGenerator so the socket handler
 * can emit token-by-token to the client.
 */

import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { PresentationRepository, PresentationRow } from "./presentation-repository.js";

export interface TeacherAgentDeps {
  copilotWrapper: CopilotWrapper;
  presentationRepo: PresentationRepository;
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

  constructor({ copilotWrapper, presentationRepo }: TeacherAgentDeps) {
    this.copilot = copilotWrapper;
    this.repo = presentationRepo;
  }

  /**
   * Answer a student's question using presentation context (RAG-style).
   * Returns an AsyncGenerator that yields tokens for streaming to the client.
   */
  async *ask(payload: AskPayload): AsyncGenerator<string> {
    const presentation = this.repo.findById(payload.presentationId);
    if (!presentation) {
      yield "I couldn't find this presentation. It may have been deleted.";
      return;
    }

    const context = this.buildContext(presentation, payload.chapterIndex);
    const systemPrompt = [
      "You are a knowledgeable and encouraging teacher explaining concepts from a video presentation.",
      "Use the provided transcript/script context to ground your answer.",
      "If the question is outside the presentation scope, say so politely.",
      "Use Mermaid diagrams (```mermaid) when a visual would help explain the concept.",
      "Keep answers concise but thorough.",
    ].join("\n");

    const userMsg = [
      `## Presentation: ${presentation.title}`,
      "",
      `## Chapter Context (Chapter ${payload.chapterIndex + 1})`,
      context,
      "",
      `## Student Question (at ${Math.round(payload.timestamp)}s)`,
      payload.question,
    ].join("\n");

    yield* this.copilot.chat(userMsg, {
      systemMessage: { mode: "replace", content: systemPrompt },
      tools: [], // No tool use for Q&A — pure text generation
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
        startTime: number;
        endTime: number;
      }>;

      const chapter = chapters[chapterIndex];
      if (!chapter) return this.truncateScript(scripts);

      // Get script segments within this chapter's time range
      const relevant = scripts.filter(
        (s) => s.startTime >= chapter.startSeconds && s.endTime <= chapter.endSeconds,
      );

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
