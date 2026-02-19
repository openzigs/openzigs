/**
 * Presenter Mode — Quiz Generator
 * Issue #279 (SI-4): Generates multiple-choice quiz questions per chapter
 * using CopilotWrapper. Results are cached in quiz_cache table.
 */

import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type {
  PresentationRepository,
  PresentationRow,
  QuizCacheRow,
} from "./presentation-repository.js";

export interface QuizGeneratorDeps {
  copilotWrapper: CopilotWrapper;
  presentationRepo: PresentationRepository;
}

interface Chapter {
  title: string;
  startSeconds: number;
  endSeconds: number;
}

export class QuizGenerator {
  private copilot: CopilotWrapper;
  private repo: PresentationRepository;

  constructor({ copilotWrapper, presentationRepo }: QuizGeneratorDeps) {
    this.copilot = copilotWrapper;
    this.repo = presentationRepo;
  }

  /**
   * Generate quiz questions for a presentation.
   * Returns cached questions if they exist, otherwise generates fresh ones.
   */
  async generate(presentationId: string): Promise<QuizCacheRow[]> {
    const existing = this.repo.getQuizzes(presentationId);
    if (existing.length > 0) return existing;

    const presentation = this.repo.findById(presentationId);
    if (!presentation) throw new Error("Presentation not found");

    let chapters: Chapter[];
    try {
      chapters = JSON.parse(presentation.chapters) as Chapter[];
    } catch {
      return [];
    }

    if (chapters.length === 0) return [];

    const results: QuizCacheRow[] = [];
    // Generate one question per chapter (sequentially to avoid rate limits)
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const context = this.getChapterContext(presentation, chapter);
      if (!context) continue;

      const question = await this.generateForChapter(
        presentation.title,
        chapter,
        context,
        i,
      );

      if (question) {
        const row = this.repo.insertQuiz({
          presentation_id: presentationId,
          chapter_index: i,
          timestamp_seconds: chapter.endSeconds - 2,
          question: question.question,
          options: question.options,
          correct_index: question.correctIndex,
          explanation: question.explanation,
        });
        results.push(row);
      }
    }

    return results;
  }

  private async generateForChapter(
    title: string,
    chapter: Chapter,
    context: string,
    _chapterIndex: number,
  ): Promise<{
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  } | null> {
    const prompt = [
      "Generate exactly ONE multiple-choice quiz question based on this presentation chapter.",
      "Return ONLY valid JSON with this exact schema (no markdown, no code fences):",
      '{ "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0, "explanation": "..." }',
      "",
      `Presentation: "${title}"`,
      `Chapter: "${chapter.title}"`,
      "",
      "Content:",
      context,
    ].join("\n");

    let fullResponse = "";
    for await (const token of this.copilot.chat(prompt, {
      tools: [],
      systemMessage: {
        mode: "replace",
        content:
          "You are a quiz question generator. Return ONLY valid JSON, no explanation or markdown.",
      },
    })) {
      fullResponse += token;
    }

    return this.parseQuizResponse(fullResponse);
  }

  private parseQuizResponse(response: string): {
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  } | null {
    try {
      // Strip potential markdown code fences
      const cleaned = response
        .replace(/^```(?:json)?\n?/m, "")
        .replace(/\n?```$/m, "")
        .trim();

      const parsed = JSON.parse(cleaned) as {
        question?: string;
        options?: string[];
        correctIndex?: number;
        explanation?: string;
      };

      if (
        typeof parsed.question !== "string" ||
        !Array.isArray(parsed.options) ||
        parsed.options.length < 2 ||
        typeof parsed.correctIndex !== "number" ||
        parsed.correctIndex < 0 ||
        parsed.correctIndex >= parsed.options.length
      ) {
        return null;
      }

      return {
        question: parsed.question,
        options: parsed.options.map(String),
        correctIndex: parsed.correctIndex,
        explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
      };
    } catch {
      return null;
    }
  }

  private getChapterContext(
    presentation: PresentationRow,
    chapter: Chapter,
  ): string | null {
    try {
      const scripts = JSON.parse(presentation.script_json) as Array<{
        text: string;
        startTime: number;
        endTime: number;
      }>;
      const relevant = scripts.filter(
        (s) => s.startTime >= chapter.startSeconds && s.endTime <= chapter.endSeconds,
      );
      if (relevant.length === 0) return null;
      const text = relevant.map((s) => s.text).join(" ");
      return text.length > 3000 ? text.slice(0, 3000) + "…" : text;
    } catch {
      return null;
    }
  }
}
