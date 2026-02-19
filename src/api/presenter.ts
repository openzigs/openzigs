/**
 * Presenter Mode — REST API Router
 * Issue #276 (SI-1): Express router mounted at /api/presentations.
 */

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { SignJWT } from "jose";
import type Database from "better-sqlite3";
import type { PresentationRepository } from "../presenter/presentation-repository.js";
import type { TeacherAgent } from "../presenter/teacher-agent.js";
import type { QuizGenerator } from "../presenter/quiz-generator.js";
import type { VoiceService } from "../voice/index.js";
import { TranscriptClassifier } from "../presenter/transcript-classifier.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { KnowledgeIngestionService } from "../knowledge/knowledge-service.js";
import { logger } from "../logging/logger.js";

export interface PresenterRouterDeps {
  presentationRepo: PresentationRepository;
  teacherAgent?: TeacherAgent;
  quizGenerator?: QuizGenerator;
  voiceService?: VoiceService;
  db?: Database.Database;
  copilotWrapper?: CopilotWrapper;
  knowledgeService?: KnowledgeIngestionService;
  inviteSecret?: string;
  baseUrl?: string;
}

type VoiceProfileRow = {
  id: string;
  ref_audio_path: string;
  ref_text: string;
  language: string;
  top_p: number;
  temperature: number;
  text_split_method: string;
  speed_factor: number;
  repetition_penalty: number;
  top_k: number;
  sample_steps: number;
};

export function createPresenterRouter({ presentationRepo, teacherAgent, quizGenerator, voiceService, db, copilotWrapper, knowledgeService, inviteSecret, baseUrl }: PresenterRouterDeps): Router {
  const transcriptClassifier = copilotWrapper ? new TranscriptClassifier(copilotWrapper) : null;
  const router = Router();

  // GET /api/presentations — List all presentations (catalog)
  router.get("/", (_req, res) => {
    const presentations = presentationRepo.listAll();
    res.json({ presentations });
  });

  // POST /api/presentations/tts-prompt — Get TTS audio for the "ask your question" prompt
  // Must be before /:id routes to avoid matching as a presentation ID
  router.post("/tts-prompt", async (req, res) => {
    const { text, presentationId } = req.body as { text?: string; presentationId?: string };
    const promptText = text ?? "Please ask your question out loud.";

    if (!voiceService || !voiceService.isReady()) {
      res.status(503).json({ error: "Voice service not available" });
      return;
    }

    try {
      const provider = voiceService.getProvider();
      if (provider === "local") {
        const sidecarUrl = voiceService.getSidecarUrl().replace(/\/$/, "");
        const healthResp = await fetch(`${sidecarUrl}/health`);
        if (healthResp.ok) {
          const health = (await healthResp.json()) as { active_engine?: "kokoro" | "sovits" };
          if (health.active_engine === "sovits") {
            if (!db) {
              res.status(503).json({ error: "Database unavailable for Engine B voice profile lookup" });
              return;
            }

            const presentationVoiceId = presentationId
              ? presentationRepo.findById(presentationId)?.voice_id
              : null;

            const profile = (presentationVoiceId
              ? db.prepare("SELECT * FROM voice_profiles WHERE id = ?").get(presentationVoiceId)
              : db.prepare("SELECT * FROM voice_profiles ORDER BY updated_at DESC LIMIT 1").get()) as VoiceProfileRow | undefined;

            if (!profile) {
              res.status(409).json({
                error: "Engine B is active, but no GPT-SoVITS voice profile is configured.",
              });
              return;
            }

            const payload = {
              text: promptText,
              ref_audio_path: profile.ref_audio_path,
              ref_text: profile.ref_text,
              ref_language: profile.language,
              top_p: profile.top_p,
              temperature: profile.temperature,
              text_split_method: profile.text_split_method,
              speed_factor: profile.speed_factor,
              repetition_penalty: profile.repetition_penalty,
              top_k: profile.top_k,
              sample_steps: profile.sample_steps,
            };

            const audioResp = await fetch(`${sidecarUrl}/tts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });

            if (!audioResp.ok) {
              const errorBody = await audioResp.text().catch(() => "");
              res.status(502).json({ error: errorBody || "Engine B synthesis failed" });
              return;
            }

            const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
            res.set({
              "Content-Type": audioResp.headers.get("content-type") ?? "audio/wav",
              "Content-Length": String(audioBuffer.length),
              "Cache-Control": "public, max-age=86400",
            });
            res.send(audioBuffer);
            return;
          }
        }
      }

      const result = await voiceService.synthesize(promptText);
      const contentType = result.contentType ?? "audio/mpeg";
      res.set({
        "Content-Type": contentType,
        "Content-Length": String(result.audio.length),
        "Cache-Control": "public, max-age=86400",
      });
      res.send(result.audio);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error(`TTS prompt synthesis failed: ${msg}`);
      res.status(502).json({ error: msg });
    }
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
    try { chapters = JSON.parse(presentation.chapters); } catch (e) { logger.warn(`[PresenterRouter] Failed to parse chapters for ${req.params.id}:`, e); }
    let scriptJson = [];
    try { scriptJson = JSON.parse(presentation.script_json); } catch (e) { logger.warn(`[PresenterRouter] Failed to parse script_json for ${req.params.id}:`, e); }
    let quizConfig = null;
    try { quizConfig = presentation.quiz_config ? JSON.parse(presentation.quiz_config) : null; } catch (e) { logger.warn(`[PresenterRouter] Failed to parse quiz_config for ${req.params.id}:`, e); }

    const userChapters = presentationRepo.getUserChapters(req.params.id);

    res.json({
      ...presentation,
      chapters,
      script_json: scriptJson,
      quiz_config: quizConfig,
      quiz_enabled: presentation.quiz_enabled === 1,
      user_chapters: userChapters,
    });
  });

  // DELETE /api/presentations/:id — Remove from catalog (doesn't delete video file)
  router.delete("/:id", (req, res) => {
    const deleted = presentationRepo.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }
    if (knowledgeService) {
      void knowledgeService.deleteDocument(req.params.id).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[PresenterRouter] Failed to remove knowledge doc for ${req.params.id}: ${msg}`);
      });
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

    if (title !== undefined && typeof title !== "string") {
      res.status(400).json({ error: "title must be a string" });
      return;
    }
    if (quiz_config != null) {
      if (!Array.isArray(quiz_config.timestamps) || quiz_config.timestamps.some((t) => typeof t !== "number")) {
        res.status(400).json({ error: "quiz_config.timestamps must be an array of numbers" });
        return;
      }
      if (typeof quiz_config.difficulty !== "string") {
        res.status(400).json({ error: "quiz_config.difficulty must be a string" });
        return;
      }
    }

    presentationRepo.update(req.params.id, {
      title,
      quiz_enabled,
      quiz_config: quiz_config as Parameters<typeof presentationRepo.update>[1]["quiz_config"],
    });

    res.json({ success: true, presentation: presentationRepo.findById(req.params.id) });
  });

  // GET /api/presentations/:id/quiz — Get cached quiz questions
  router.get("/:id/quiz", async (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    let quizzes = presentationRepo.getQuizzes(req.params.id);

    if (quizzes.length === 0 && presentation.quiz_enabled === 1 && quizGenerator) {
      try {
        quizzes = await quizGenerator.generate(req.params.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: msg });
        return;
      }
    }

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

  // GET /api/presentations/:id/user-chapters — List user-defined chapters
  router.get("/:id/user-chapters", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }
    const userChapters = presentationRepo.getUserChapters(req.params.id);
    res.json({ chapters: userChapters });
  });

  // PUT /api/presentations/:id/user-chapters — Save/replace user-defined chapters
  router.put("/:id/user-chapters", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    const body = req.body as {
      chapters?: Array<{
        title?: string;
        description?: string;
        start_seconds?: number;
        end_seconds?: number;
        order_index?: number;
      }>;
    };

    if (!Array.isArray(body.chapters)) {
      res.status(400).json({ error: "'chapters' must be an array" });
      return;
    }

    const inputs = body.chapters.map((ch, i) => ({
      title: String(ch.title ?? "").trim() || `Chapter ${i + 1}`,
      description: String(ch.description ?? "").trim(),
      start_seconds: typeof ch.start_seconds === "number" ? ch.start_seconds : 0,
      end_seconds: typeof ch.end_seconds === "number" ? ch.end_seconds : presentation.duration_seconds,
      order_index: typeof ch.order_index === "number" ? ch.order_index : i,
    }));

    const saved = presentationRepo.replaceUserChapters(req.params.id, inputs);
    res.json({ chapters: saved });
  });

  // POST /api/presentations/:id/user-chapters/classify
  // AI reads the transcript and assigns time ranges to each user-defined chapter.
  router.post("/:id/user-chapters/classify", async (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    if (!transcriptClassifier) {
      res.status(503).json({ error: "Transcript classifier not available" });
      return;
    }

    const userChapters = presentationRepo.getUserChapters(req.params.id);
    if (userChapters.length === 0) {
      res.status(400).json({ error: "No user-defined chapters to classify. Save chapters first." });
      return;
    }

    try {
      const classified = await transcriptClassifier.classify(
        presentation,
        userChapters.map((ch) => ({ title: ch.title, description: ch.description })),
      );

      // Write the AI-computed time ranges back to the user chapters
      const updated = presentationRepo.replaceUserChapters(
        req.params.id,
        classified.map((ch, i) => ({
          title: ch.title,
          description: ch.description,
          start_seconds: ch.startSeconds,
          end_seconds: ch.endSeconds,
          order_index: i,
        })),
      );

      res.json({ chapters: updated, classified });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error(`Transcript classification failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/presentations/:id/notes — Get saved Q&A notes
  router.get("/:id/notes", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }
    const notes = presentationRepo.getNotes(req.params.id);
    res.json({ notes });
  });

  // DELETE /api/presentations/:id/notes — Clear all notes
  router.delete("/:id/notes", (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }
    const count = presentationRepo.deleteNotes(req.params.id);
    res.json({ success: true, deleted: count });
  });

  // POST /api/presentations/:id/invite — Generate JWT invite link
  router.post("/:id/invite", async (req, res) => {
    const presentation = presentationRepo.findById(req.params.id);
    if (!presentation) {
      res.status(404).json({ error: "Presentation not found" });
      return;
    }

    const secret = inviteSecret || "";
    if (!secret) {
      res.status(503).json({ error: "Invite secret not configured. Set presenter.inviteSecret in config." });
      return;
    }

    const { ttlHours } = req.body as { ttlHours?: number };
    const ttl = Math.min(Math.max(ttlHours ?? 24, 1), 168);
    const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000);

    try {
      const secretKey = new TextEncoder().encode(secret);
      const token = await new SignJWT({
        sub: "guest",
        presentationId: req.params.id,
        role: "guest",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(secretKey);

      const origin = baseUrl || `${req.protocol}://${req.get("host")}`;
      const inviteUrl = `${origin}/invite/${token}`;

      res.json({ inviteUrl, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error(`Failed to generate invite token: ${msg}`);
      res.status(500).json({ error: "Failed to generate invite link" });
    }
  });

  return router;
}
