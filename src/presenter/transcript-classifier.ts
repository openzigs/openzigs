/**
 * Presenter Mode — Transcript Classifier
 * Given user-defined chapter definitions (title + description), uses the LLM
 * to classify each transcript segment into the best-matching chapter, then
 * computes the time range (start/end seconds) for each chapter.
 */

import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { PresentationRow } from "./presentation-repository.js";

export interface ChapterDefinition {
  title: string;
  description: string;
}

export interface ClassifiedChapter {
  title: string;
  description: string;
  startSeconds: number;
  endSeconds: number;
  /** Fraction of segments that matched this chapter (0–1), for confidence display */
  coverage: number;
}

interface ScriptSegment {
  text: string;
  start: number;
  end: number;
}

export class TranscriptClassifier {
  private copilot: CopilotWrapper;

  constructor(copilotWrapper: CopilotWrapper) {
    this.copilot = copilotWrapper;
  }

  /**
   * Classify transcript segments into user-defined chapters.
   * Returns the chapters enriched with computed start/end seconds derived
   * from the segments the LLM assigns to each chapter.
   */
  async classify(
    presentation: PresentationRow,
    chapters: ChapterDefinition[],
  ): Promise<ClassifiedChapter[]> {
    if (chapters.length === 0) return [];

    const segments = this.parseSegments(presentation);
    if (segments.length === 0) {
      // No timing data — distribute chapters evenly across the video
      const duration = presentation.duration_seconds;
      const sliceSize = duration / chapters.length;
      return chapters.map((ch, i) => ({
        ...ch,
        startSeconds: i * sliceSize,
        endSeconds: Math.min((i + 1) * sliceSize, duration),
        coverage: 0,
      }));
    }

    // Build a condensed script for the LLM (capped to avoid context overflow)
    const scriptLines = segments.map((seg, i) => `[${i}] ${seg.text}`).join("\n");
    const capped =
      scriptLines.length > 6000
        ? scriptLines.slice(0, 6000) + "\n…(truncated)"
        : scriptLines;

    const chaptersJson = chapters
      .map((ch, i) => `${i}: "${ch.title}" — ${ch.description || "(no description)"}`)
      .join("\n");

    const prompt = [
      "You are classifying a transcript into chapters.",
      "Each transcript segment is numbered [N].",
      "",
      "Chapters (index: title — description):",
      chaptersJson,
      "",
      "Transcript segments:",
      capped,
      "",
      "For EACH segment index, output the best-matching chapter index (0-based).",
      "Return ONLY a JSON array where each element is the chapter index for that segment, in order.",
      "Example for 5 segments across 3 chapters: [0, 0, 1, 2, 2]",
      "Return ONLY the JSON array, no prose, no code fences.",
    ].join("\n");

    let raw = "";
    for await (const token of this.copilot.chat(prompt, {
      tools: [],
      systemMessage: {
        mode: "replace",
        content: "You are a transcript classifier. Return ONLY a JSON array of integers.",
      },
    })) {
      raw += token;
    }

    const assignments = this.parseAssignments(raw, segments.length, chapters.length);
    return this.buildChapters(chapters, segments, assignments, presentation.duration_seconds);
  }

  private parseSegments(presentation: PresentationRow): ScriptSegment[] {
    try {
      const raw = JSON.parse(presentation.script_json) as Array<{
        text?: string;
        startTime?: number;
        endTime?: number;
        startSeconds?: number;
        endSeconds?: number;
      }>;

      return raw
        .map((s) => ({
          text: s.text ?? "",
          start:
            typeof s.startTime === "number"
              ? s.startTime
              : typeof s.startSeconds === "number"
                ? s.startSeconds
                : NaN,
          end:
            typeof s.endTime === "number"
              ? s.endTime
              : typeof s.endSeconds === "number"
                ? s.endSeconds
                : NaN,
        }))
        .filter((s) => s.text.trim().length > 0 && Number.isFinite(s.start) && Number.isFinite(s.end));
    } catch {
      return [];
    }
  }

  private parseAssignments(
    raw: string,
    segmentCount: number,
    chapterCount: number,
  ): number[] {
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\n?/m, "")
        .replace(/\n?```$/m, "")
        .trim();
      const parsed = JSON.parse(cleaned) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Not an array");

      // Clamp values to valid chapter indices; pad/truncate to segmentCount
      const result: number[] = [];
      for (let i = 0; i < segmentCount; i++) {
        const val = typeof parsed[i] === "number" ? parsed[i] : 0;
        result.push(Math.max(0, Math.min(chapterCount - 1, Math.round(val))));
      }
      return result;
    } catch {
      // Fallback: distribute segments evenly across chapters
      return Array.from({ length: segmentCount }, (_, i) =>
        Math.min(chapterCount - 1, Math.floor((i / segmentCount) * chapterCount)),
      );
    }
  }

  private buildChapters(
    defs: ChapterDefinition[],
    segments: ScriptSegment[],
    assignments: number[],
    totalDuration: number,
  ): ClassifiedChapter[] {
    // Collect segments for each chapter
    const buckets: ScriptSegment[][] = defs.map(() => []);
    for (let i = 0; i < segments.length; i++) {
      const chIdx = assignments[i] ?? 0;
      buckets[chIdx].push(segments[i]);
    }

    const results: ClassifiedChapter[] = defs.map((def, i) => {
      const segs = buckets[i];
      if (segs.length === 0) {
        // Chapter got no segments — will be fixed in the gap-fill pass below
        return {
          ...def,
          startSeconds: 0,
          endSeconds: 0,
          coverage: 0,
        };
      }
      const startSeconds = Math.min(...segs.map((s) => s.start));
      const endSeconds = Math.max(...segs.map((s) => s.end));
      return {
        ...def,
        startSeconds,
        endSeconds,
        coverage: segs.length / segments.length,
      };
    });

    // Gap-fill: chapters with 0 segments get time ranges between neighbours
    // Sort neighbour chapters first to establish anchors
    for (let i = 0; i < results.length; i++) {
      if (results[i].coverage === 0) {
        const prev = i > 0 ? results[i - 1] : null;
        const next = results.slice(i + 1).find((r) => r.coverage > 0);
        const start = prev ? prev.endSeconds : 0;
        const end = next ? next.startSeconds : totalDuration;
        results[i].startSeconds = start;
        results[i].endSeconds = end;
      }
    }

    // Ensure chapters are ordered and don't overlap: snap each chapter's
    // startSeconds to its predecessor's endSeconds
    for (let i = 1; i < results.length; i++) {
      if (results[i].startSeconds < results[i - 1].endSeconds) {
        results[i].startSeconds = results[i - 1].endSeconds;
      }
    }

    // Last chapter extends to the end of the video
    if (results.length > 0) {
      results[results.length - 1].endSeconds = Math.max(
        results[results.length - 1].endSeconds,
        totalDuration,
      );
    }

    return results;
  }
}
