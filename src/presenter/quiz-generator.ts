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
        const timestamp = this.pickQuizTimestamp(chapter);
        const row = this.repo.insertQuiz({
          presentation_id: presentationId,
          chapter_index: i,
          timestamp_seconds: timestamp,
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
      '{ "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 2, "explanation": "..." }',
      "IMPORTANT: correctIndex must be the index of the correct answer in the options array. It should NOT always be 0.",
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

      const options = parsed.options.map(String);
      const correctIndex = parsed.correctIndex;

      // Shuffle options so the correct answer isn't always in the same position
      const shuffled = options
        .map((opt, i) => ({ opt, i }))
        .sort(() => Math.random() - 0.5);
      const shuffledOptions = shuffled.map(({ opt }) => opt);
      const newCorrectIndex = shuffled.findIndex(({ i }) => i === correctIndex);

      return {
        question: parsed.question,
        options: shuffledOptions,
        correctIndex: newCorrectIndex,
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
        startTime?: number;
        endTime?: number;
        startSeconds?: number;
        endSeconds?: number;
      }>;
      const normalized = scripts
        .map((segment) => ({
          text: segment.text,
          start: typeof segment.startTime === "number"
            ? segment.startTime
            : (typeof segment.startSeconds === "number" ? segment.startSeconds : NaN),
          end: typeof segment.endTime === "number"
            ? segment.endTime
            : (typeof segment.endSeconds === "number" ? segment.endSeconds : NaN),
        }))
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end));

      const relevant = scripts.filter(
        (s) => {
          const start = typeof s.startTime === "number"
            ? s.startTime
            : (typeof s.startSeconds === "number" ? s.startSeconds : NaN);
          const end = typeof s.endTime === "number"
            ? s.endTime
            : (typeof s.endSeconds === "number" ? s.endSeconds : NaN);
          if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
          return start < chapter.endSeconds && end > chapter.startSeconds;
        },
      );

      if (relevant.length === 0 && normalized.length === 0) return null;

      const chosen = relevant.length > 0
        ? relevant.map((segment) => segment.text)
        : normalized.map((segment) => segment.text);

      const text = chosen.join(" ");
      return text.length > 3000 ? text.slice(0, 3000) + "…" : text;
    } catch {
      return null;
    }
  }

  private pickQuizTimestamp(chapter: Chapter): number {
    const start = chapter.startSeconds;
    const end = chapter.endSeconds;
    const duration = Math.max(0, end - start);

    if (duration <= 8) {
      return start + duration * 0.5;
    }

    const target = start + duration * 0.65;
    const minTime = start + 2;
    const maxTime = end - 5;
    return Math.max(minTime, Math.min(target, maxTime));
  }
}
