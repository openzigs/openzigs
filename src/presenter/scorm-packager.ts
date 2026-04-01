/**
 * SCORM 1.2 Packager — bundles presentation content into a SCORM-compliant .zip.
 * Issue #703: Creates a valid SCORM 1.2 package for LMS upload.
 */

import archiver from "archiver";
import { PassThrough } from "node:stream";
import { generateManifest } from "./scorm-manifest.js";
import { renderScormHtml } from "./scorm-html-renderer.js";
import type { Chapter, QuizCacheRow } from "./presentation-repository.js";
import type { Archiver } from "archiver";

export interface ScormPackageInput {
  /** Presentation ID (used as SCORM identifier). */
  id: string;
  /** Presentation title. */
  title: string;
  /** Chapter definitions. */
  chapters: Chapter[];
  /** Quiz questions from quiz_cache. */
  quizQuestions: QuizCacheRow[];
  /** Script segments (transcript text). */
  scriptSegments: Array<{ text: string; startTime: number; endTime: number }>;
}

export interface ScormPackageResult {
  /** The generated zip buffer. */
  buffer: Buffer;
  /** File name for the download. */
  filename: string;
}

const LAUNCH_PAGE = "index.html";

/**
 * Build a SCORM 1.2 package as an in-memory zip buffer.
 *
 * Package structure:
 *   imsmanifest.xml   — SCORM manifest
 *   index.html         — Self-contained HTML SCO with SCORM API adapter
 */
export async function buildScormPackage(input: ScormPackageInput): Promise<ScormPackageResult> {
  const { id, title, chapters, quizQuestions, scriptSegments } = input;

  // Generate the HTML SCO
  const htmlContent = renderScormHtml({
    title,
    chapters,
    quizQuestions,
    scriptSegments,
  });

  // Generate the manifest
  const manifestContent = generateManifest({
    identifier: `pres-${id}`,
    title,
    launchPage: LAUNCH_PAGE,
    resourceFiles: [],
  });

  // Build the zip archive
  return new Promise<ScormPackageResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();

    passthrough.on("data", (chunk: Buffer) => chunks.push(chunk));
    passthrough.on("end", () => {
      resolve({
        buffer: Buffer.concat(chunks),
        filename: `${sanitizeFilename(title)}-scorm.zip`,
      });
    });
    passthrough.on("error", reject);

    const archive: Archiver = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", reject);
    archive.pipe(passthrough);

    archive.append(manifestContent, { name: "imsmanifest.xml" });
    archive.append(htmlContent, { name: LAUNCH_PAGE });

    void archive.finalize();
  });
}

/**
 * Sanitize a string for use as a filename.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\- ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80) || "presentation";
}
