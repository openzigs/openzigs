/**
 * Presenter Mode — Chapter Detector
 * Issue #276 (SI-1): Parses Director Manifest timeline → Chapter[].
 *
 * Chapter boundaries are defined by title_card entries in the timeline.
 * Consecutive non-title entries between title cards form chapter content.
 */

import type { DirectorManifest, TimelineEntry, TitleCardEntry } from "../video/manifest/manifest-types.js";
import type { Chapter, QuizConfig } from "./presentation-repository.js";

/**
 * Extract chapters from a Director Manifest's timeline.
 *
 * Algorithm:
 * 1. Find all title_card entries → mark as chapter boundaries.
 * 2. Group consecutive non-title entries between title cards as chapters.
 * 3. Compute timestamps from frame offsets and fps.
 */
export function detectChapters(manifest: DirectorManifest): Chapter[] {
  const { timeline, composition } = manifest;
  const fps = composition.fps || 30;
  const chapters: Chapter[] = [];

  // Find all title cards
  const titleCards = timeline.filter(
    (e): e is TitleCardEntry => e.type === "title_card",
  );

  if (titleCards.length === 0) {
    // No title cards — treat the entire video as a single chapter
    const totalFrames = getTimelineEndFrame(timeline);
    return [
      {
        title: manifest.projectTitle || "Full Presentation",
        startSeconds: 0,
        endSeconds: totalFrames / fps,
      },
    ];
  }

  for (let i = 0; i < titleCards.length; i++) {
    const titleCard = titleCards[i];
    const nextTitleCard = titleCards[i + 1];

    const startFrame = titleCard.startAtFrame;
    const endFrame = nextTitleCard
      ? nextTitleCard.startAtFrame
      : getTimelineEndFrame(timeline);

    chapters.push({
      title: titleCard.title || `Chapter ${i + 1}`,
      startSeconds: startFrame / fps,
      endSeconds: endFrame / fps,
    });
  }

  return chapters;
}

/**
 * Compute quiz timestamps: place at the end of each chapter
 * that is >= 15 seconds long.
 */
export function computeQuizTimestamps(
  chapters: Chapter[],
  difficulty: "easy" | "medium" | "hard" = "medium",
): QuizConfig {
  const timestamps: number[] = [];

  for (const chapter of chapters) {
    const duration = chapter.endSeconds - chapter.startSeconds;
    // Skip chapters shorter than 15 seconds
    if (duration >= 15) {
      // Place quiz 2 seconds before chapter end to avoid overlap with title card
      timestamps.push(Math.max(chapter.startSeconds, chapter.endSeconds - 2));
    }
  }

  return { timestamps, difficulty };
}

/**
 * Compute the total script text for a specific chapter index,
 * extracted from the script_json segments that fall within the chapter time range.
 */
export function getChapterScript(
  scriptSegments: Array<{ text: string; startSeconds?: number; endSeconds?: number }>,
  chapter: Chapter,
): string {
  return scriptSegments
    .filter((seg) => {
      const segStart = seg.startSeconds ?? 0;
      return segStart >= chapter.startSeconds && segStart < chapter.endSeconds;
    })
    .map((seg) => seg.text)
    .join(" ");
}

/** Get the last frame in the timeline. */
function getTimelineEndFrame(timeline: TimelineEntry[]): number {
  let maxFrame = 0;
  for (const entry of timeline) {
    const entryEnd = getEntryEndFrame(entry);
    if (entryEnd > maxFrame) maxFrame = entryEnd;
  }
  return maxFrame;
}

function getEntryEndFrame(entry: TimelineEntry): number {
  switch (entry.type) {
    case "video_clip":
      return entry.startAtFrame + entry.duration;
    case "title_card":
      return entry.startAtFrame + entry.duration;
    case "image_scene":
      return entry.startAtFrame + entry.duration;
    case "overlay":
      return entry.startAtFrame + (entry.duration ?? 0);
    case "transition":
      return entry.startAtFrame + entry.duration;
    default:
      return 0;
  }
}
