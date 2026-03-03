import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { PresentationRepository } from "./presentation-repository.js";
import type { CreatePresentationInput } from "./presentation-repository.js";

vi.mock("nanoid", () => {
  let counter = 0;
  return { nanoid: (_size?: number) => `test-id-${++counter}` };
});

function makeInput(overrides: Partial<CreatePresentationInput> = {}): CreatePresentationInput {
  return {
    title: "Test Presentation",
    video_path: "/tmp/test.mp4",
    duration_seconds: 120,
    script_json: JSON.stringify([{ text: "Hello", startTime: 0, endTime: 5 }]),
    chapters: JSON.stringify([{ title: "Intro", startSeconds: 0, endSeconds: 60 }]),
    mode: "presentation",
    ...overrides,
  };
}

describe("PresentationRepository", () => {
  let db: Database.Database;
  let repo: PresentationRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    repo = new PresentationRepository(db);
    repo.migrate();
  });

  // ── Migration ──────────────────────────────────────────────

  it("migrate is idempotent", () => {
    expect(() => repo.migrate()).not.toThrow();
    expect(() => repo.migrate()).not.toThrow();
  });

  // ── Insert & FindById ──────────────────────────────────────

  it("inserts and retrieves a presentation", () => {
    const row = repo.insert(makeInput({ title: "My Talk" }));
    expect(row.title).toBe("My Talk");
    expect(row.video_path).toBe("/tmp/test.mp4");
    expect(row.duration_seconds).toBe(120);
    expect(row.fps).toBe(30);
    expect(row.quiz_enabled).toBe(0);
    expect(row.mode).toBe("presentation");
    expect(row.id).toBeTruthy();
  });

  it("stores quiz_enabled as 1 when true", () => {
    const row = repo.insert(makeInput({ quiz_enabled: true }));
    expect(row.quiz_enabled).toBe(1);
  });

  it("stores quiz_config as JSON string", () => {
    const cfg = { timestamps: [10, 30], difficulty: "hard" as const };
    const row = repo.insert(makeInput({ quiz_config: cfg }));
    expect(JSON.parse(row.quiz_config!)).toEqual(cfg);
  });

  it("findById returns undefined for missing id", () => {
    expect(repo.findById("nonexistent")).toBeUndefined();
  });

  // ── ListAll ────────────────────────────────────────────────

  it("lists all presentations with boolean quiz_enabled", () => {
    repo.insert(makeInput({ title: "A", quiz_enabled: true }));
    repo.insert(makeInput({ title: "B", quiz_enabled: false }));
    const list = repo.listAll();
    expect(list).toHaveLength(2);
    // Ordered by created_at DESC — both have the same timestamp, so order may vary
    const titles = list.map((r) => r.title);
    expect(titles).toContain("A");
    expect(titles).toContain("B");
    const quizA = list.find((r) => r.title === "A");
    expect(quizA!.quiz_enabled).toBe(true);
    const quizB = list.find((r) => r.title === "B");
    expect(quizB!.quiz_enabled).toBe(false);
  });

  // ── Delete ─────────────────────────────────────────────────

  it("deletes a presentation", () => {
    const row = repo.insert(makeInput());
    expect(repo.delete(row.id)).toBe(true);
    expect(repo.findById(row.id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent id", () => {
    expect(repo.delete("nope")).toBe(false);
  });

  // ── Update ─────────────────────────────────────────────────

  it("updates title", () => {
    const row = repo.insert(makeInput({ title: "Old" }));
    expect(repo.update(row.id, { title: "New" })).toBe(true);
    expect(repo.findById(row.id)!.title).toBe("New");
  });

  it("updates quiz_enabled", () => {
    const row = repo.insert(makeInput({ quiz_enabled: false }));
    repo.update(row.id, { quiz_enabled: true });
    expect(repo.findById(row.id)!.quiz_enabled).toBe(1);
  });

  it("updates quiz_config to null", () => {
    const cfg = { timestamps: [5], difficulty: "easy" as const };
    const row = repo.insert(makeInput({ quiz_config: cfg }));
    repo.update(row.id, { quiz_config: null });
    expect(repo.findById(row.id)!.quiz_config).toBeNull();
  });

  it("returns false when no fields provided", () => {
    const row = repo.insert(makeInput());
    expect(repo.update(row.id, {})).toBe(false);
  });

  // ── Quiz Cache ─────────────────────────────────────────────

  it("inserts and retrieves quizzes", () => {
    const pres = repo.insert(makeInput());
    const quiz = repo.insertQuiz({
      presentation_id: pres.id,
      chapter_index: 0,
      timestamp_seconds: 15,
      question: "What is 2+2?",
      options: ["3", "4", "5"],
      correct_index: 1,
      explanation: "Basic math",
    });
    expect(quiz.question).toBe("What is 2+2?");
    expect(JSON.parse(quiz.options)).toEqual(["3", "4", "5"]);

    const quizzes = repo.getQuizzes(pres.id);
    expect(quizzes).toHaveLength(1);
    expect(quizzes[0].question).toBe("What is 2+2?");
  });

  it("returns quizzes ordered by timestamp_seconds", () => {
    const pres = repo.insert(makeInput());
    repo.insertQuiz({ presentation_id: pres.id, chapter_index: 0, timestamp_seconds: 30, question: "Q2", options: ["a"], correct_index: 0, explanation: "" });
    repo.insertQuiz({ presentation_id: pres.id, chapter_index: 0, timestamp_seconds: 10, question: "Q1", options: ["b"], correct_index: 0, explanation: "" });
    const quizzes = repo.getQuizzes(pres.id);
    expect(quizzes[0].question).toBe("Q1");
    expect(quizzes[1].question).toBe("Q2");
  });

  it("deletes all quizzes for a presentation", () => {
    const pres = repo.insert(makeInput());
    repo.insertQuiz({ presentation_id: pres.id, chapter_index: 0, timestamp_seconds: 5, question: "Q", options: ["a"], correct_index: 0, explanation: "" });
    repo.insertQuiz({ presentation_id: pres.id, chapter_index: 1, timestamp_seconds: 10, question: "Q2", options: ["b"], correct_index: 0, explanation: "" });
    const count = repo.deleteQuizzes(pres.id);
    expect(count).toBe(2);
    expect(repo.getQuizzes(pres.id)).toHaveLength(0);
  });

  // ── Notes ──────────────────────────────────────────────────

  it("inserts and retrieves notes", () => {
    const pres = repo.insert(makeInput());
    const note = repo.insertNote({
      presentation_id: pres.id,
      question: "Why?",
      answer: "Because",
      chapter_index: 0,
      timestamp_seconds: 5,
    });
    expect(note.question).toBe("Why?");
    const notes = repo.getNotes(pres.id);
    expect(notes).toHaveLength(1);
  });

  it("returns notes ordered by timestamp_seconds", () => {
    const pres = repo.insert(makeInput());
    repo.insertNote({ presentation_id: pres.id, question: "Late", answer: "A", chapter_index: 0, timestamp_seconds: 30 });
    repo.insertNote({ presentation_id: pres.id, question: "Early", answer: "B", chapter_index: 0, timestamp_seconds: 5 });
    const notes = repo.getNotes(pres.id);
    expect(notes[0].question).toBe("Early");
    expect(notes[1].question).toBe("Late");
  });

  it("deletes notes for a presentation", () => {
    const pres = repo.insert(makeInput());
    repo.insertNote({ presentation_id: pres.id, question: "Q", answer: "A", chapter_index: 0, timestamp_seconds: 5 });
    expect(repo.deleteNotes(pres.id)).toBe(1);
    expect(repo.getNotes(pres.id)).toHaveLength(0);
  });

  // ── User Chapters ─────────────────────────────────────────

  it("replaces user chapters in a transaction", () => {
    const pres = repo.insert(makeInput());
    const chapters = [
      { title: "Ch1", description: "First", start_seconds: 0, end_seconds: 30, order_index: 0 },
      { title: "Ch2", description: "Second", start_seconds: 30, end_seconds: 60, order_index: 1 },
    ];
    const result = repo.replaceUserChapters(pres.id, chapters);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Ch1");
    expect(result[1].title).toBe("Ch2");
    expect(result[0].order_index).toBe(0);
  });

  it("getUserChapters returns ordered by order_index", () => {
    const pres = repo.insert(makeInput());
    repo.replaceUserChapters(pres.id, [
      { title: "B", description: "", start_seconds: 30, end_seconds: 60, order_index: 1 },
      { title: "A", description: "", start_seconds: 0, end_seconds: 30, order_index: 0 },
    ]);
    const chapters = repo.getUserChapters(pres.id);
    expect(chapters[0].title).toBe("A");
    expect(chapters[1].title).toBe("B");
  });

  it("replaceUserChapters clears old chapters", () => {
    const pres = repo.insert(makeInput());
    repo.replaceUserChapters(pres.id, [
      { title: "Old", description: "", start_seconds: 0, end_seconds: 10, order_index: 0 },
    ]);
    repo.replaceUserChapters(pres.id, [
      { title: "New", description: "", start_seconds: 0, end_seconds: 20, order_index: 0 },
    ]);
    const chapters = repo.getUserChapters(pres.id);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("New");
  });

  it("replaceUserChapters with empty array clears all", () => {
    const pres = repo.insert(makeInput());
    repo.replaceUserChapters(pres.id, [
      { title: "X", description: "", start_seconds: 0, end_seconds: 10, order_index: 0 },
    ]);
    repo.replaceUserChapters(pres.id, []);
    expect(repo.getUserChapters(pres.id)).toHaveLength(0);
  });

  // ── Cascade Delete ─────────────────────────────────────────

  it("cascade deletes quizzes and notes when presentation is deleted", () => {
    const pres = repo.insert(makeInput());
    repo.insertQuiz({ presentation_id: pres.id, chapter_index: 0, timestamp_seconds: 5, question: "Q", options: ["a"], correct_index: 0, explanation: "" });
    repo.insertNote({ presentation_id: pres.id, question: "Q", answer: "A", chapter_index: 0, timestamp_seconds: 5 });
    repo.replaceUserChapters(pres.id, [{ title: "C", description: "", start_seconds: 0, end_seconds: 10, order_index: 0 }]);

    repo.delete(pres.id);

    expect(repo.getQuizzes(pres.id)).toHaveLength(0);
    expect(repo.getNotes(pres.id)).toHaveLength(0);
    expect(repo.getUserChapters(pres.id)).toHaveLength(0);
  });
});
