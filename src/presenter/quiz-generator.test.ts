import { describe, it, expect, vi, beforeEach } from "vitest";
import { QuizGenerator } from "./quiz-generator.js";
import type { QuizCacheRow, PresentationRow } from "./presentation-repository.js";

function makeMockRepo() {
  return {
    getQuizzes: vi.fn().mockReturnValue([]),
    findById: vi.fn(),
    insertQuiz: vi.fn(),
  };
}

function makeMockCopilot() {
  return {
    chat: vi.fn(),
  };
}

function makePresentation(overrides: Partial<PresentationRow> = {}): PresentationRow {
  return {
    id: "pres-1",
    title: "Test Talk",
    video_path: "/tmp/test.mp4",
    thumbnail_path: null,
    duration_seconds: 120,
    fps: 30,
    script_json: JSON.stringify([
      { text: "Hello world, this is segment one", startTime: 0, endTime: 30 },
      { text: "Now we move to segment two", startTime: 30, endTime: 60 },
    ]),
    chapters: JSON.stringify([
      { title: "Intro", startSeconds: 0, endSeconds: 60 },
      { title: "Main", startSeconds: 60, endSeconds: 120 },
    ]),
    voice_id: null,
    quiz_enabled: 1,
    quiz_config: null,
    director_manifest_path: null,
    mode: "presentation",
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

async function* yieldTokens(text: string) {
  yield text;
}

describe("QuizGenerator", () => {
  let repo: ReturnType<typeof makeMockRepo>;
  let copilot: ReturnType<typeof makeMockCopilot>;
  let generator: QuizGenerator;

  beforeEach(() => {
    repo = makeMockRepo();
    copilot = makeMockCopilot();
    generator = new QuizGenerator({
      copilotWrapper: copilot as any,
      presentationRepo: repo as any,
    });
  });

  it("returns cached quizzes if they exist", async () => {
    const cached: QuizCacheRow[] = [{
      id: "q1", presentation_id: "pres-1", chapter_index: 0,
      timestamp_seconds: 15, question: "Cached?", options: '["A","B"]',
      correct_index: 0, explanation: "Yes", generated_at: "2025-01-01",
    }];
    repo.getQuizzes.mockReturnValue(cached);

    const result = await generator.generate("pres-1");
    expect(result).toEqual(cached);
    expect(copilot.chat).not.toHaveBeenCalled();
  });

  it("throws when presentation not found", async () => {
    repo.findById.mockReturnValue(undefined);
    await expect(generator.generate("missing")).rejects.toThrow("Presentation not found");
  });

  it("returns empty array when chapters fail to parse", async () => {
    repo.findById.mockReturnValue(makePresentation({ chapters: "not-json" }));
    const result = await generator.generate("pres-1");
    expect(result).toEqual([]);
  });

  it("returns empty array when chapters array is empty", async () => {
    repo.findById.mockReturnValue(makePresentation({ chapters: "[]" }));
    const result = await generator.generate("pres-1");
    expect(result).toEqual([]);
  });

  it("generates quiz for a chapter and inserts it", async () => {
    const pres = makePresentation();
    repo.findById.mockReturnValue(pres);

    // Mock Math.random for deterministic shuffle (identity shuffle)
    vi.spyOn(Math, "random").mockReturnValue(0.1);

    const quizJson = JSON.stringify({
      question: "What is the topic?",
      options: ["A", "B", "C", "D"],
      correctIndex: 1,
      explanation: "B is correct",
    });
    copilot.chat.mockReturnValue(yieldTokens(quizJson));

    const insertedRow: QuizCacheRow = {
      id: "q-new", presentation_id: "pres-1", chapter_index: 0,
      timestamp_seconds: 30, question: "What is the topic?",
      options: '["A","B","C","D"]', correct_index: 1,
      explanation: "B is correct", generated_at: "2025-01-01",
    };
    repo.insertQuiz.mockReturnValue(insertedRow);

    const result = await generator.generate("pres-1");
    // Should have generated for both chapters (both have overlapping segments)
    expect(repo.insertQuiz).toHaveBeenCalled();
    expect(result.length).toBeGreaterThanOrEqual(1);

    vi.spyOn(Math, "random").mockRestore();
  });

  it("skips chapter when no context available", async () => {
    // Segments don't overlap with the second chapter range and script_json has no normalized segments
    const pres = makePresentation({
      script_json: JSON.stringify([
        { text: "Only early content", startTime: 0, endTime: 10 },
      ]),
      chapters: JSON.stringify([
        { title: "Intro", startSeconds: 0, endSeconds: 10 },
        { title: "Later", startSeconds: 100, endSeconds: 200 },
      ]),
    });
    repo.findById.mockReturnValue(pres);

    const quizJson = JSON.stringify({
      question: "Q?",
      options: ["A", "B"],
      correctIndex: 0,
      explanation: "Exp",
    });
    copilot.chat.mockReturnValue(yieldTokens(quizJson));

    vi.spyOn(Math, "random").mockReturnValue(0.1);
    repo.insertQuiz.mockImplementation((input: any) => ({
      id: "q", ...input, options: JSON.stringify(input.options), generated_at: "now",
    }));

    const result = await generator.generate("pres-1");
    // Only the first chapter has matching segments
    expect(result).toHaveLength(1);

    vi.spyOn(Math, "random").mockRestore();
  });

  it("handles invalid JSON response from LLM gracefully", async () => {
    const pres = makePresentation({
      chapters: JSON.stringify([{ title: "Ch1", startSeconds: 0, endSeconds: 60 }]),
    });
    repo.findById.mockReturnValue(pres);
    copilot.chat.mockReturnValue(yieldTokens("This is not JSON at all"));

    const result = await generator.generate("pres-1");
    expect(result).toEqual([]);
    expect(repo.insertQuiz).not.toHaveBeenCalled();
  });

  it("handles response wrapped in markdown code fences", async () => {
    const pres = makePresentation({
      chapters: JSON.stringify([{ title: "Ch1", startSeconds: 0, endSeconds: 60 }]),
    });
    repo.findById.mockReturnValue(pres);

    vi.spyOn(Math, "random").mockReturnValue(0.1);

    const quizJson = '```json\n{"question":"Q?","options":["A","B"],"correctIndex":0,"explanation":"E"}\n```';
    copilot.chat.mockReturnValue(yieldTokens(quizJson));

    repo.insertQuiz.mockImplementation((input: any) => ({
      id: "q", ...input, options: JSON.stringify(input.options), generated_at: "now",
    }));

    const result = await generator.generate("pres-1");
    expect(result).toHaveLength(1);

    vi.spyOn(Math, "random").mockRestore();
  });

  it("rejects quiz with less than 2 options", async () => {
    const pres = makePresentation({
      chapters: JSON.stringify([{ title: "Ch1", startSeconds: 0, endSeconds: 60 }]),
    });
    repo.findById.mockReturnValue(pres);

    const quizJson = JSON.stringify({
      question: "Q?", options: ["Only one"], correctIndex: 0, explanation: "Nope",
    });
    copilot.chat.mockReturnValue(yieldTokens(quizJson));

    const result = await generator.generate("pres-1");
    expect(result).toEqual([]);
  });

  it("rejects quiz with correctIndex out of bounds", async () => {
    const pres = makePresentation({
      chapters: JSON.stringify([{ title: "Ch1", startSeconds: 0, endSeconds: 60 }]),
    });
    repo.findById.mockReturnValue(pres);

    const quizJson = JSON.stringify({
      question: "Q?", options: ["A", "B"], correctIndex: 5, explanation: "Bad",
    });
    copilot.chat.mockReturnValue(yieldTokens(quizJson));

    const result = await generator.generate("pres-1");
    expect(result).toEqual([]);
  });

  it("pickQuizTimestamp returns midpoint for short chapters", async () => {
    const pres = makePresentation({
      chapters: JSON.stringify([{ title: "Short", startSeconds: 10, endSeconds: 15 }]),
    });
    repo.findById.mockReturnValue(pres);

    vi.spyOn(Math, "random").mockReturnValue(0.1);

    const quizJson = JSON.stringify({
      question: "Q?", options: ["A", "B"], correctIndex: 0, explanation: "E",
    });
    copilot.chat.mockReturnValue(yieldTokens(quizJson));

    repo.insertQuiz.mockImplementation((input: any) => {
      // Short chapter (5s <= 8): midpoint = 10 + 5*0.5 = 12.5
      expect(input.timestamp_seconds).toBe(12.5);
      return { id: "q", ...input, options: JSON.stringify(input.options), generated_at: "now" };
    });

    await generator.generate("pres-1");
    expect(repo.insertQuiz).toHaveBeenCalled();

    vi.spyOn(Math, "random").mockRestore();
  });

  it("handles script_json with startSeconds variant", async () => {
    const pres = makePresentation({
      script_json: JSON.stringify([
        { text: "Alt format", startSeconds: 0, endSeconds: 30 },
      ]),
      chapters: JSON.stringify([{ title: "Ch1", startSeconds: 0, endSeconds: 60 }]),
    });
    repo.findById.mockReturnValue(pres);

    vi.spyOn(Math, "random").mockReturnValue(0.1);

    const quizJson = JSON.stringify({
      question: "Q?", options: ["A", "B"], correctIndex: 0, explanation: "E",
    });
    copilot.chat.mockReturnValue(yieldTokens(quizJson));

    repo.insertQuiz.mockImplementation((input: any) => ({
      id: "q", ...input, options: JSON.stringify(input.options), generated_at: "now",
    }));

    const result = await generator.generate("pres-1");
    expect(result).toHaveLength(1);

    vi.spyOn(Math, "random").mockRestore();
  });
});
