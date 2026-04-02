/**
 * SCORM Packager integration tests.
 * Issue #701: Validates SCORM 1.2 package structure and content.
 */

import { describe, it, expect } from "vitest";
import { buildScormPackage } from "./scorm-packager.js";
import { generateManifest } from "./scorm-manifest.js";
import { renderScormHtml } from "./scorm-html-renderer.js";
import type { QuizCacheRow } from "./presentation-repository.js";
import JSZip from "jszip";

const SAMPLE_CHAPTERS = [
  { title: "Introduction", startSeconds: 0, endSeconds: 30 },
  { title: "Main Content", startSeconds: 30, endSeconds: 90 },
  { title: "Conclusion", startSeconds: 90, endSeconds: 120 },
];

const SAMPLE_SCRIPT = [
  { text: "Welcome to this presentation.", startTime: 0, endTime: 10 },
  { text: "Let's dive into the main topic.", startTime: 30, endTime: 45 },
  { text: "Thank you for watching.", startTime: 90, endTime: 100 },
];

const SAMPLE_QUIZ: QuizCacheRow[] = [
  {
    id: "q1",
    presentation_id: "pres-1",
    chapter_index: 0,
    timestamp_seconds: 25,
    question: "What is this about?",
    options: JSON.stringify(["Option A", "Option B", "Option C", "Option D"]),
    correct_index: 1,
    explanation: "Option B is the correct answer.",
    generated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "q2",
    presentation_id: "pres-1",
    chapter_index: 1,
    timestamp_seconds: 60,
    question: "Which technique is best?",
    options: JSON.stringify(["Alpha", "Beta", "Gamma", "Delta"]),
    correct_index: 2,
    explanation: "Gamma is the standard approach.",
    generated_at: "2026-01-01T00:00:00Z",
  },
];

describe("generateManifest", () => {
  it("generates valid SCORM 1.2 manifest XML", () => {
    const xml = generateManifest({
      identifier: "test-pres",
      title: "Test Presentation",
      launchPage: "index.html",
      resourceFiles: [],
    });
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<manifest");
    expect(xml).toContain("ADL SCORM");
    expect(xml).toContain("<schemaversion>1.2</schemaversion>");
    expect(xml).toContain("Test Presentation");
    expect(xml).toContain('href="index.html"');
    expect(xml).toContain('adlcp:scormtype="sco"');
  });

  it("escapes XML special characters in title", () => {
    const xml = generateManifest({
      identifier: "test",
      title: 'Title with <special> & "chars"',
      launchPage: "index.html",
      resourceFiles: [],
    });
    expect(xml).toContain("&lt;special&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;chars&quot;");
  });

  it("includes resource files in manifest", () => {
    const xml = generateManifest({
      identifier: "test",
      title: "Test",
      launchPage: "index.html",
      resourceFiles: ["style.css", "script.js"],
    });
    expect(xml).toContain('href="style.css"');
    expect(xml).toContain('href="script.js"');
  });

  it("includes mastery score element", () => {
    const xml = generateManifest({
      identifier: "test",
      title: "Test",
      launchPage: "index.html",
      resourceFiles: [],
    });
    expect(xml).toContain("<adlcp:masteryscore>80</adlcp:masteryscore>");
  });
});

describe("renderScormHtml", () => {
  it("generates self-contained HTML with SCORM API adapter", () => {
    const html = renderScormHtml({
      title: "Test Presentation",
      chapters: SAMPLE_CHAPTERS,
      quizQuestions: [],
      scriptSegments: SAMPLE_SCRIPT,
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Test Presentation");
    expect(html).toContain("LMSInitialize");
    expect(html).toContain("LMSSetValue");
    expect(html).toContain("LMSFinish");
    expect(html).toContain("findAPI");
  });

  it("includes quiz data when quiz questions are provided", () => {
    const html = renderScormHtml({
      title: "Quiz Test",
      chapters: SAMPLE_CHAPTERS,
      quizQuestions: SAMPLE_QUIZ,
      scriptSegments: SAMPLE_SCRIPT,
    });
    expect(html).toContain("What is this about?");
    expect(html).toContain("Which technique is best?");
    expect(html).toContain("cmi.core.score.raw");
    expect(html).toContain("cmi.core.score.min");
    expect(html).toContain("cmi.core.score.max");
  });

  it("sets completed status for presentations without quizzes", () => {
    const html = renderScormHtml({
      title: "No Quiz",
      chapters: SAMPLE_CHAPTERS,
      quizQuestions: [],
      scriptSegments: SAMPLE_SCRIPT,
    });
    expect(html).toContain('"completed"');
  });

  it("maps quiz scores to SCORM cmi.core.score fields (#705)", () => {
    const html = renderScormHtml({
      title: "Score Mapping",
      chapters: SAMPLE_CHAPTERS,
      quizQuestions: SAMPLE_QUIZ,
      scriptSegments: SAMPLE_SCRIPT,
    });
    // Verify SCORM score API calls are present
    expect(html).toContain("scormSetScore(pct, 0, 100)");
    expect(html).toContain('scormSetStatus(passed ? "passed" : "failed")');
  });

  it("escapes HTML in title", () => {
    const html = renderScormHtml({
      title: '<script>alert("xss")</script>',
      chapters: [],
      quizQuestions: [],
      scriptSegments: [],
    });
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("buildScormPackage", () => {
  it("produces a valid zip file", async () => {
    const result = await buildScormPackage({
      id: "test-123",
      title: "My Presentation",
      chapters: SAMPLE_CHAPTERS,
      quizQuestions: SAMPLE_QUIZ,
      scriptSegments: SAMPLE_SCRIPT,
    });
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.filename).toBe("my-presentation-scorm.zip");
  });

  it("zip contains imsmanifest.xml and index.html", async () => {
    const result = await buildScormPackage({
      id: "test-456",
      title: "Package Test",
      chapters: SAMPLE_CHAPTERS,
      quizQuestions: [],
      scriptSegments: SAMPLE_SCRIPT,
    });
    const zip = await JSZip.loadAsync(result.buffer);
    const files = Object.keys(zip.files);
    expect(files).toContain("imsmanifest.xml");
    expect(files).toContain("index.html");
  });

  it("manifest references index.html as launch page", async () => {
    const result = await buildScormPackage({
      id: "test-789",
      title: "Launch Test",
      chapters: [],
      quizQuestions: [],
      scriptSegments: [],
    });
    const zip = await JSZip.loadAsync(result.buffer);
    const manifest = await zip.file("imsmanifest.xml")!.async("string");
    expect(manifest).toContain('href="index.html"');
    expect(manifest).toContain("<schemaversion>1.2</schemaversion>");
  });

  it("HTML SCO contains SCORM API adapter code", async () => {
    const result = await buildScormPackage({
      id: "test-api",
      title: "API Test",
      chapters: SAMPLE_CHAPTERS,
      quizQuestions: SAMPLE_QUIZ,
      scriptSegments: SAMPLE_SCRIPT,
    });
    const zip = await JSZip.loadAsync(result.buffer);
    const html = await zip.file("index.html")!.async("string");
    expect(html).toContain("LMSInitialize");
    expect(html).toContain("LMSSetValue");
    expect(html).toContain("LMSCommit");
    expect(html).toContain("LMSFinish");
  });

  it("sanitizes filename for special characters", async () => {
    const result = await buildScormPackage({
      id: "test-special",
      title: "My <Awesome> Presentation!!! @#$%",
      chapters: [],
      quizQuestions: [],
      scriptSegments: [],
    });
    expect(result.filename).toBe("my-awesome-presentation-scorm.zip");
  });

  it("handles empty chapters and quiz gracefully", async () => {
    const result = await buildScormPackage({
      id: "test-empty",
      title: "Empty Presentation",
      chapters: [],
      quizQuestions: [],
      scriptSegments: [],
    });
    expect(result.buffer.length).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files).length).toBe(2);
  });
});
