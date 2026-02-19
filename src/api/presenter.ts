/**
 * Presenter Mode — REST API Router
 * Issue #276 (SI-1): Express router mounted at /api/presentations.
 */

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { PresentationRepository } from "../presenter/presentation-repository.js";
import type { TeacherAgent } from "../presenter/teacher-agent.js";
import type { QuizGenerator } from "../presenter/quiz-generator.js";

export interface PresenterRouterDeps {
  presentationRepo: PresentationRepository;
  teacherAgent?: TeacherAgent;
  quizGenerator?: QuizGenerator;
}

export function createPresenterRouter({ presentationRepo, teacherAgent, quizGenerator }: PresenterRouterDeps): Router {
  const router = Router();

  // GET /api/presentations — List all presentations (catalog)
  router.get("/", (_req, res) => {
    const presentations = presentationRepo.listAll();
    res.json({ presentations });
  });

  // GET /api/presentations/:id — Full presentation metadata
  router.get("/:id", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    // Parse JSON fields for the response
    let chapters = [];
    try { chapters = JSON.parse(presentation.chapters); } catch { /* empty */ }
    let scriptJson = [];
    try { scriptJson = JSON.parse(presentation.script_json); } catch { /* empty */ }
    let quizConfig = null;
    try { quizConfig = presentation.quiz_config ? JSON.parse(presentation.quiz_config) : null; } catch { /* empty */ }

    res.json({
      ...presentation,
      chapters,
      script_json: scriptJson,
      quiz_config: quizConfig,
      quiz_enabled: presentation.quiz_enabled === 1,
    });
  });

  // DELETE /api/presentations/:id — Remove from catalog (doesn't delete video file)
  router.delete("/:id", (req, res) => {
    const deleted = presentationRepo.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }
    res.json({ success: true });
  });

  // PATCH /api/presentations/:id — Update quiz_enabled, quiz_config, or title
  router.patch("/:id", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    const { title, quiz_enabled, quiz_config } = req.body as {
      title?: string;
      quiz_enabled?: boolean;
      quiz_config?: { timestamps: number[]; difficulty: string } | null;
    };

    presentationRepo.update(req.params.id, {
      title,
      quiz_enabled,
      quiz_config: quiz_config as Parameters<typeof presentationRepo.update>[1]["quiz_config"],
    });

    res.json({ success: true, presentation: presentationRepo.findById(req.params.id) });
  });

  // GET /api/presentations/:id/quiz — Get cached quiz questions
  router.get("/:id/quiz", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    const quizzes = presentationRepo.getQuizzes(req.params.id);
    // Parse options JSON for each quiz
    const parsed = quizzes.map((q) => ({
      ...q,
      options: JSON.parse(q.options) as string[],
    }));

    res.json({ questions: parsed });
  });

  // GET /api/presentations/:id/thumbnail — Serve thumbnail image
  router.get("/:id/thumbnail", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation || !presentation.thumbnail_path) {
      res.status(404).json({ error: "Thumbnail not found" });
      return;
    }

    const thumbPath = presentation.thumbnail_path;
    if (!fs.existsSync(thumbPath)) {
      res.status(404).json({ error: "Thumbnail file not found on disk" });
      return;
    }

    res.sendFile(path.resolve(thumbPath));
  });

  // POST /api/presentations/:id/ask — HTTP fallback for Q&A (non-streaming)
  router.post("/:id/ask", async (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    const { question, chapterIndex, timestamp } = req.body as {
      question?: string;
      chapterIndex?: number;
      timestamp?: number;
    };

    if (!question || typeof question !== "string") {
      res.status(400).json({ error: "Missing 'question' field" });
      return;
    }

    if (!teacherAgent) {
      res.json({
        answer: "Teacher Agent is not yet connected.",
        presentationId: req.params.id,
        question,
      });
      return;
    }

    try {
      let answer = "";
      for await (const token of teacherAgent.ask({
        presentationId: req.params.id,
        question,
        chapterIndex: chapterIndex ?? 0,
        timestamp: timestamp ?? 0,
      })) {
        answer += token;
      }
      res.json({ answer, presentationId: req.params.id, question });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/presentations/:id/generate-quiz — Generate quiz questions for all chapters
  router.post("/:id/generate-quiz", async (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    if (!quizGenerator) {
      res.status(503).json({ error: "Quiz Generator is not available" });
      return;
    }

    try {
      const questions = await quizGenerator.generate(req.params.id);
      const parsed = questions.map((q) => ({
        ...q,
        options: JSON.parse(q.options) as string[],
      }));
      res.json({ questions: parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
