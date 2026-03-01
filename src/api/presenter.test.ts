import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createPresenterRouter } from "./presenter.js";
import type { PresenterRouterDeps } from "./presenter.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../presenter/transcript-classifier.js", () => ({
  TranscriptClassifier: vi.fn().mockImplementation(() => ({
    classify: vi.fn(),
  })),
}));

function createMockPresentationRepo() {
  const presentations = new Map<string, Record<string, unknown>>();
  presentations.set("p1", {
    id: "p1",
    title: "Intro to AI",
    chapters: "[]",
    script_json: "[]",
    quiz_config: null,
    quiz_enabled: 0,
    thumbnail_path: null,
    duration_seconds: 600,
    voice_id: null,
  });

  return {
    listAll: vi.fn(() => Array.from(presentations.values())),
    findById: vi.fn((id: string) => presentations.get(id) ?? null),
    delete: vi.fn((id: string) => presentations.has(id)),
    update: vi.fn(),
    getQuizzes: vi.fn(() => []),
    getUserChapters: vi.fn(() => []),
    replaceUserChapters: vi.fn((_, chapters: unknown[]) => chapters),
    getNotes: vi.fn(() => []),
    deleteNotes: vi.fn(() => 0),
  };
}

function buildApp(overrides: Partial<PresenterRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  const deps: PresenterRouterDeps = {
    presentationRepo: createMockPresentationRepo() as unknown as PresenterRouterDeps["presentationRepo"],
    ...overrides,
  };
  app.use("/presentations", createPresenterRouter(deps));
  return { app, deps };
}

describe("Presenter API router", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /", () => {
    it("lists all presentations", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations");
      expect(res.status).toBe(200);
      expect(res.body.presentations).toHaveLength(1);
    });
  });

  describe("GET /:id", () => {
    it("returns a presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/p1");
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Intro to AI");
    });

    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id", () => {
    it("deletes a presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/presentations/p1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/presentations/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /:id", () => {
    it("updates title", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/presentations/p1").send({ title: "New Title" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/presentations/missing").send({ title: "X" });
      expect(res.status).toBe(404);
    });

    it("rejects non-string title", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/presentations/p1").send({ title: 123 });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /:id/quiz", () => {
    it("returns empty quiz for presentation without quizzes", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/p1/quiz");
      expect(res.status).toBe(200);
      expect(res.body.questions).toEqual([]);
    });

    it("returns 404 for missing", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/missing/quiz");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/thumbnail", () => {
    it("returns 404 when no thumbnail", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/p1/thumbnail");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/ask", () => {
    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/missing/ask").send({ question: "What is AI?" });
      expect(res.status).toBe(404);
    });

    it("rejects missing question", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/p1/ask").send({});
      expect(res.status).toBe(400);
    });

    it("returns fallback when no teacher agent", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/p1/ask").send({ question: "What is AI?" });
      expect(res.status).toBe(200);
      expect(res.body.answer).toContain("not yet connected");
    });
  });

  describe("POST /:id/generate-quiz", () => {
    it("returns 404 for missing", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/missing/generate-quiz");
      expect(res.status).toBe(404);
    });

    it("returns 503 when quiz generator unavailable", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/p1/generate-quiz");
      expect(res.status).toBe(503);
    });
  });

  describe("GET /:id/user-chapters", () => {
    it("returns user chapters", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/p1/user-chapters");
      expect(res.status).toBe(200);
      expect(res.body.chapters).toEqual([]);
    });
  });

  describe("PUT /:id/user-chapters", () => {
    it("saves user chapters", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/presentations/p1/user-chapters").send({
        chapters: [{ title: "Ch1", start_seconds: 0, end_seconds: 300 }],
      });
      expect(res.status).toBe(200);
    });

    it("rejects non-array chapters", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/presentations/p1/user-chapters").send({ chapters: "bad" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /:id/notes", () => {
    it("returns notes", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/p1/notes");
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /:id/notes", () => {
    it("clears notes", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/presentations/p1/notes");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /tts-prompt", () => {
    it("returns 503 when voice service unavailable", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/tts-prompt").send({ text: "hello" });
      expect(res.status).toBe(503);
    });
  });

  // ── Additional coverage ─────────────────────────────────────

  describe("requireAdmin middleware", () => {
    it("blocks requests with guest_token cookie", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .delete("/presentations/p1")
        .set("Cookie", "guest_token=abc123");
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Guests");
    });
  });

  describe("PATCH /:id quiz_config validation", () => {
    it("rejects quiz_config with non-array timestamps", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/presentations/p1")
        .send({ quiz_config: { timestamps: "bad", difficulty: "easy" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("timestamps");
    });

    it("rejects quiz_config with non-string difficulty", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/presentations/p1")
        .send({ quiz_config: { timestamps: [10, 20], difficulty: 123 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("difficulty");
    });
  });

  describe("GET /:id/quiz with existing quizzes", () => {
    it("returns parsed quiz questions", async () => {
      const repo = createMockPresentationRepo();
      repo.getQuizzes.mockReturnValue([
        { id: "q1", question: "What?", options: '["a","b","c","d"]', correct_answer: 0, chapter_index: 0 },
      ]);
      const { app } = buildApp({ presentationRepo: repo as never });
      const res = await request(app).get("/presentations/p1/quiz");
      expect(res.status).toBe(200);
      expect(res.body.questions).toHaveLength(1);
      expect(res.body.questions[0].options).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("POST /:id/ask with teacher agent", () => {
    it("streams answer from teacher agent", async () => {
      const mockTeacher = {
        ask: vi.fn().mockImplementation(async function* () {
          yield "Hello";
          yield " world";
        }),
      };
      const { app } = buildApp({ teacherAgent: mockTeacher as never });
      const res = await request(app)
        .post("/presentations/p1/ask")
        .send({ question: "What is AI?" });
      expect(res.status).toBe(200);
      expect(res.body.answer).toBe("Hello world");
    });

    it("returns 500 when teacher agent throws", async () => {
      const mockTeacher = {
        ask: vi.fn().mockImplementation(async function* () {
          throw new Error("LLM timeout");
        }),
      };
      const { app } = buildApp({ teacherAgent: mockTeacher as never });
      const res = await request(app)
        .post("/presentations/p1/ask")
        .send({ question: "What is AI?" });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("LLM timeout");
    });
  });

  describe("POST /:id/generate-quiz with generator", () => {
    it("generates and returns quiz questions", async () => {
      const mockQuiz = {
        generate: vi.fn().mockResolvedValue([
          { id: "q1", question: "What?", options: '["a","b"]', correct_answer: 0, chapter_index: 0 },
        ]),
      };
      const { app } = buildApp({ quizGenerator: mockQuiz as never });
      const res = await request(app).post("/presentations/p1/generate-quiz");
      expect(res.status).toBe(200);
      expect(res.body.questions).toHaveLength(1);
    });

    it("returns 500 when generator throws", async () => {
      const mockQuiz = {
        generate: vi.fn().mockRejectedValue(new Error("Generation failed")),
      };
      const { app } = buildApp({ quizGenerator: mockQuiz as never });
      const res = await request(app).post("/presentations/p1/generate-quiz");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /:id/user-chapters/classify", () => {
    it("returns 503 when transcript classifier unavailable", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/p1/user-chapters/classify");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /:id/invite", () => {
    it("generates invite link with secret", async () => {
      const { app } = buildApp({ inviteSecret: "test-secret-key-for-presenter-invite-12345" });
      const res = await request(app).post("/presentations/p1/invite").send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("token");
      expect(res.body).toHaveProperty("inviteUrl");
      expect(res.body).toHaveProperty("expiresAt");
    });

    it("returns 503 when no invite secret configured", async () => {
      const { app } = buildApp({ inviteSecret: "" });
      const res = await request(app).post("/presentations/p1/invite").send({});
      expect(res.status).toBe(503);
    });

    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp({ inviteSecret: "secret-key-12345678901234567890" });
      const res = await request(app).post("/presentations/missing/invite").send({});
      expect(res.status).toBe(404);
    });

    it("rejects non-number ttlHours", async () => {
      const { app } = buildApp({ inviteSecret: "secret-key-12345678901234567890" });
      const res = await request(app)
        .post("/presentations/p1/invite")
        .send({ ttlHours: "abc" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("ttlHours");
    });

    it("clamps ttlHours to [1, 168]", async () => {
      const { app } = buildApp({ inviteSecret: "secret-key-12345678901234567890" });
      const res = await request(app)
        .post("/presentations/p1/invite")
        .send({ ttlHours: 500 });
      expect(res.status).toBe(200);
      // expiresAt should be at most 168h from now
      const expiresAt = new Date(res.body.expiresAt);
      const maxExpiry = new Date(Date.now() + 169 * 60 * 60 * 1000);
      expect(expiresAt.getTime()).toBeLessThan(maxExpiry.getTime());
    });

    it("blocks guests from creating invites", async () => {
      const { app } = buildApp({ inviteSecret: "secret-key-12345678901234567890" });
      const res = await request(app)
        .post("/presentations/p1/invite")
        .set("Cookie", "guest_token=abc123")
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:id with knowledgeService", () => {
    it("calls knowledgeService.deleteDocument on delete", async () => {
      const mockKnowledge = { deleteDocument: vi.fn().mockResolvedValue(undefined) };
      const { app } = buildApp({ knowledgeService: mockKnowledge as never });
      const res = await request(app).delete("/presentations/p1");
      expect(res.status).toBe(200);
      expect(mockKnowledge.deleteDocument).toHaveBeenCalledWith("p1");
    });

    it("succeeds even when knowledgeService.deleteDocument rejects", async () => {
      const mockKnowledge = { deleteDocument: vi.fn().mockRejectedValue(new Error("fail")) };
      const { app } = buildApp({ knowledgeService: mockKnowledge as never });
      const res = await request(app).delete("/presentations/p1");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /tts-prompt with voice service", () => {
    it("synthesizes via voiceService when provider is not local", async () => {
      const mockVoice = {
        isReady: vi.fn().mockReturnValue(true),
        getProvider: vi.fn().mockReturnValue("cloud"),
        synthesize: vi.fn().mockResolvedValue({
          audio: Buffer.from("audio-data"),
          contentType: "audio/mpeg",
        }),
      };
      const { app } = buildApp({ voiceService: mockVoice as never });
      const res = await request(app)
        .post("/presentations/tts-prompt")
        .send({ text: "Hello" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("audio");
    });

    it("uses default text when none provided", async () => {
      const mockVoice = {
        isReady: vi.fn().mockReturnValue(true),
        getProvider: vi.fn().mockReturnValue("cloud"),
        synthesize: vi.fn().mockResolvedValue({
          audio: Buffer.from("audio-data"),
        }),
      };
      const { app } = buildApp({ voiceService: mockVoice as never });
      const res = await request(app)
        .post("/presentations/tts-prompt")
        .send({});
      expect(res.status).toBe(200);
      expect(mockVoice.synthesize).toHaveBeenCalledWith("Please ask your question out loud.");
    });

    it("returns 502 when synthesize throws", async () => {
      const mockVoice = {
        isReady: vi.fn().mockReturnValue(true),
        getProvider: vi.fn().mockReturnValue("cloud"),
        synthesize: vi.fn().mockRejectedValue(new Error("TTS boom")),
      };
      const { app } = buildApp({ voiceService: mockVoice as never });
      const res = await request(app)
        .post("/presentations/tts-prompt")
        .send({ text: "fail" });
      expect(res.status).toBe(502);
      expect(res.body.error).toContain("TTS boom");
    });
  });

  describe("GET /:id/quiz auto-generation", () => {
    it("auto-generates quizzes when quiz_enabled and generator present", async () => {
      const repo = createMockPresentationRepo();
      repo.findById.mockImplementation((id: string) => {
        if (id === "p1") return { ...repo.findById.mock.results[0]?.value, id: "p1", quiz_enabled: 1 };
        return null;
      });
      repo.getQuizzes.mockReturnValue([]);
      const mockQuiz = {
        generate: vi.fn().mockResolvedValue([
          { id: "q1", question: "Q?", options: '["a","b"]', correct_answer: 0, chapter_index: 0 },
        ]),
      };
      // Need to re-set the repository to return quiz_enabled=1
      const presentations = new Map<string, Record<string, unknown>>();
      presentations.set("p1", {
        id: "p1", title: "T", chapters: "[]", script_json: "[]",
        quiz_config: null, quiz_enabled: 1, thumbnail_path: null,
        duration_seconds: 600, voice_id: null,
      });
      const customRepo = {
        listAll: vi.fn(() => Array.from(presentations.values())),
        findById: vi.fn((id: string) => presentations.get(id) ?? null),
        delete: vi.fn(() => true),
        update: vi.fn(),
        getQuizzes: vi.fn(() => []),
        getUserChapters: vi.fn(() => []),
        replaceUserChapters: vi.fn(),
        getNotes: vi.fn(() => []),
        deleteNotes: vi.fn(() => 0),
      };
      const { app } = buildApp({
        presentationRepo: customRepo as never,
        quizGenerator: mockQuiz as never,
      });
      const res = await request(app).get("/presentations/p1/quiz");
      expect(res.status).toBe(200);
      expect(mockQuiz.generate).toHaveBeenCalledWith("p1");
    });

    it("returns 500 when quiz generation throws", async () => {
      const presentations = new Map<string, Record<string, unknown>>();
      presentations.set("p1", {
        id: "p1", title: "T", chapters: "[]", script_json: "[]",
        quiz_config: null, quiz_enabled: 1, thumbnail_path: null,
        duration_seconds: 600, voice_id: null,
      });
      const customRepo = {
        listAll: vi.fn(() => Array.from(presentations.values())),
        findById: vi.fn((id: string) => presentations.get(id) ?? null),
        delete: vi.fn(() => true),
        update: vi.fn(),
        getQuizzes: vi.fn(() => []),
        getUserChapters: vi.fn(() => []),
        replaceUserChapters: vi.fn(),
        getNotes: vi.fn(() => []),
        deleteNotes: vi.fn(() => 0),
      };
      const mockQuiz = {
        generate: vi.fn().mockRejectedValue(new Error("gen fail")),
      };
      const { app } = buildApp({
        presentationRepo: customRepo as never,
        quizGenerator: mockQuiz as never,
      });
      const res = await request(app).get("/presentations/p1/quiz");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /:id/user-chapters", () => {
    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/missing/user-chapters");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:id/user-chapters", () => {
    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/presentations/missing/user-chapters").send({ chapters: [] });
      expect(res.status).toBe(404);
    });

    it("uses default values for missing chapter fields", async () => {
      const repo = createMockPresentationRepo();
      const { app } = buildApp({ presentationRepo: repo as never });
      const res = await request(app)
        .put("/presentations/p1/user-chapters")
        .send({ chapters: [{}] });
      expect(res.status).toBe(200);
      expect(repo.replaceUserChapters).toHaveBeenCalled();
    });
  });

  describe("GET /:id/notes", () => {
    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/presentations/missing/notes");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id/notes", () => {
    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/presentations/missing/notes");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/user-chapters/classify", () => {
    it("returns 404 for missing presentation", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/presentations/missing/user-chapters/classify");
      expect(res.status).toBe(404);
    });

    it("returns 400 when no user chapters exist", async () => {
      const mockCopilot = { someMethod: vi.fn() };
      const { app } = buildApp({ copilotWrapper: mockCopilot as never });
      const res = await request(app).post("/presentations/p1/user-chapters/classify");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No user-defined chapters");
    });
  });
});
