/**
 * Audio / Voice Lab — REST API Router (Issue #272)
 *
 * Bridges the Node.js app with the Python audio sidecar (sidecars/audio/server.py).
 * Provides voice-profile CRUD backed by SQLite and engine-switch proxy calls.
 *
 * Routes (all mounted at /api/admin/audio):
 *   GET    /engine/status     — proxy GET /health from the sidecar
 *   POST   /engine/switch     — proxy POST /switch_engine to the sidecar
 *   GET    /voices            — proxy GET /voices from the sidecar (Kokoro presets)
 *   GET    /profiles          — list saved voice profiles (Engine B)
 *   POST   /profiles          — create a new voice profile
 *   GET    /profiles/:id      — get a single voice profile
 *   PUT    /profiles/:id      — update an existing voice profile
 *   DELETE /profiles/:id      — delete a voice profile
 *   POST   /profiles/:id/test — synthesize a test phrase with the profile
 *   POST   /upload/ref-audio  — upload a reference audio file (Engine B)
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Router, raw } from "express";
import { nanoid } from "nanoid";
import Database from "better-sqlite3";
import { logger } from "../logging/logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface VoiceProfile {
  id: string;
  name: string;
  ref_audio_path: string;
  ref_text: string;
  language: string;
  top_p: number;
  temperature: number;
  text_split_method: string;
  speed_factor: number;
  repetition_penalty: number;
  top_k: number;
  created_at: string;
  updated_at: string;
}

export interface AudioRouterOptions {
  db: Database.Database;
  sidecarUrl: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:5006";

/**
 * Make a JSON request to the audio sidecar.
 * Throws on non-2xx responses with a parsed error message.
 */
async function sidecarFetch(
  sidecarUrl: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = `${sidecarUrl.replace(/\/$/, "")}${endpoint}`;
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...((options.headers as Record<string, string>) ?? {}) },
      ...options,
    });

    if (!res.ok) {
      let errBody = "";
      try {
        errBody = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`Sidecar ${endpoint} returned HTTP ${res.status}: ${errBody}`);
    }
    return res.json() as Promise<unknown>;
  } catch (err) {
    if (err instanceof TypeError && String(err).includes("fetch")) {
      throw new Error(
        `Cannot reach audio sidecar at ${url}. Is the sidecar running on port 5006?`,
      );
    }
    throw err;
  }
}

// ── Router Factory ──────────────────────────────────────────────────────────

export const createAudioRouter = ({ db, sidecarUrl }: AudioRouterOptions): Router => {
  const router = Router();

  // Resolve sidecar base URL (strip trailing slash)
  const baseUrl = (sidecarUrl ?? DEFAULT_SIDECAR_URL).replace(/\/$/, "");

  // Upload directory for reference audio files
  const uploadDir = path.join(os.homedir(), ".openzigs", "director", "ref-audio");

  // ── Engine Status & Switching ─────────────────────────────────────────────

  /**
   * GET /engine/status — return active engine state from the sidecar health endpoint.
   */
  router.get("/engine/status", async (_req, res) => {
    try {
      const data = await sidecarFetch(baseUrl, "/health");
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Audio API] GET /engine/status failed: ${msg}`);
      res.status(503).json({ error: msg });
    }
  });

  /**
   * POST /engine/switch — switch the active TTS engine.
   * Body: { engine: "kokoro" | "sovits" }
   */
  router.post("/engine/switch", async (req, res) => {
    const { engine } = req.body as { engine?: string };
    if (!engine || !["kokoro", "sovits"].includes(engine)) {
      res.status(400).json({ error: "engine must be 'kokoro' or 'sovits'" });
      return;
    }
    try {
      const data = await sidecarFetch(baseUrl, "/switch_engine", {
        method: "POST",
        body: JSON.stringify({ engine }),
      });
      logger.info(`[Audio API] Engine switched to: ${engine}`);
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Audio API] POST /engine/switch failed: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // ── Voice Presets (Engine A / Kokoro) ─────────────────────────────────────

  /**
   * GET /voices — proxy the Kokoro voice preset list from the sidecar.
   */
  router.get("/voices", async (_req, res) => {
    try {
      const data = await sidecarFetch(baseUrl, "/voices");
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Audio API] GET /voices failed: ${msg}`);
      res.status(503).json({ error: msg });
    }
  });

  // ── Voice Profiles (Engine B / GPT-SoVITS) ───────────────────────────────

  /**
   * GET /profiles — list all saved voice profiles.
   */
  router.get("/profiles", (_req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT * FROM voice_profiles ORDER BY created_at DESC`,
        )
        .all() as VoiceProfile[];
      res.json({ profiles: rows, total: rows.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Audio API] GET /profiles failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /profiles — create a new voice profile.
   * Body: { name, ref_audio_path, ref_text?, language?, top_p?, temperature?,
   *          text_split_method?, speed_factor?, repetition_penalty?, top_k? }
   */
  router.post("/profiles", (req, res) => {
    const {
      name,
      ref_audio_path,
      ref_text = "",
      language = "en",
      top_p = 0.8,
      temperature = 1.0,
      text_split_method = "cut5",
      speed_factor = 1.0,
      repetition_penalty = 1.35,
      top_k = 15,
    } = req.body as {
      name?: string;
      ref_audio_path?: string;
      ref_text?: string;
      language?: string;
      top_p?: number;
      temperature?: number;
      text_split_method?: string;
      speed_factor?: number;
      repetition_penalty?: number;
      top_k?: number;
    };

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!ref_audio_path || typeof ref_audio_path !== "string") {
      res.status(400).json({ error: "ref_audio_path is required" });
      return;
    }

    const now = new Date().toISOString();
    const id = nanoid();

    try {
      db.prepare(
        `INSERT INTO voice_profiles
           (id, name, ref_audio_path, ref_text, language,
            top_p, temperature, text_split_method, speed_factor,
            repetition_penalty, top_k, created_at, updated_at)
         VALUES
           (@id, @name, @ref_audio_path, @ref_text, @language,
            @top_p, @temperature, @text_split_method, @speed_factor,
            @repetition_penalty, @top_k, @created_at, @updated_at)`,
      ).run({
        id, name: name.trim(), ref_audio_path, ref_text, language,
        top_p, temperature, text_split_method, speed_factor,
        repetition_penalty, top_k,
        created_at: now, updated_at: now,
      });

      const profile = db
        .prepare(`SELECT * FROM voice_profiles WHERE id = ?`)
        .get(id) as VoiceProfile;

      logger.info(`[Audio API] Created voice profile: ${id} (${name})`);
      res.status(201).json(profile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        res.status(409).json({ error: `A profile named "${name}" already exists` });
        return;
      }
      logger.error(`[Audio API] POST /profiles failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /profiles/:id — get a single voice profile.
   */
  router.get("/profiles/:id", (req, res) => {
    try {
      const profile = db
        .prepare(`SELECT * FROM voice_profiles WHERE id = ?`)
        .get(req.params.id) as VoiceProfile | undefined;

      if (!profile) {
        res.status(404).json({ error: `Profile not found: ${req.params.id}` });
        return;
      }
      res.json(profile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * PUT /profiles/:id — update a voice profile.
   */
  router.put("/profiles/:id", (req, res) => {
    try {
      const existing = db
        .prepare(`SELECT * FROM voice_profiles WHERE id = ?`)
        .get(req.params.id) as VoiceProfile | undefined;

      if (!existing) {
        res.status(404).json({ error: `Profile not found: ${req.params.id}` });
        return;
      }

      const updates = req.body as Partial<Omit<VoiceProfile, "id" | "created_at" | "updated_at">>;
      const merged: VoiceProfile = {
        ...existing,
        ...updates,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };

      if (typeof merged.name !== "string" || !merged.name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }

      db.prepare(
        `UPDATE voice_profiles SET
           name=@name, ref_audio_path=@ref_audio_path, ref_text=@ref_text,
           language=@language, top_p=@top_p, temperature=@temperature,
           text_split_method=@text_split_method, speed_factor=@speed_factor,
           repetition_penalty=@repetition_penalty, top_k=@top_k, updated_at=@updated_at
         WHERE id=@id`,
      ).run(merged);

      logger.info(`[Audio API] Updated voice profile: ${merged.id}`);
      res.json(merged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /profiles/:id — delete a voice profile (does NOT delete the audio file).
   */
  router.delete("/profiles/:id", (req, res) => {
    try {
      const existing = db
        .prepare(`SELECT id FROM voice_profiles WHERE id = ?`)
        .get(req.params.id);

      if (!existing) {
        res.status(404).json({ error: `Profile not found: ${req.params.id}` });
        return;
      }

      db.prepare(`DELETE FROM voice_profiles WHERE id = ?`).run(req.params.id);
      logger.info(`[Audio API] Deleted voice profile: ${req.params.id}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /profiles/:id/test — synthesize a short test phrase with this profile.
   * Body: { text? }  (defaults to "Hello, this is a voice cloning test.")
   * Returns: audio/wav binary
   */
  router.post("/profiles/:id/test", async (req, res) => {
    try {
      const profile = db
        .prepare(`SELECT * FROM voice_profiles WHERE id = ?`)
        .get(req.params.id) as VoiceProfile | undefined;

      if (!profile) {
        res.status(404).json({ error: `Profile not found: ${req.params.id}` });
        return;
      }

      const testText: string = (req.body as { text?: string }).text?.trim()
        || "Hello, this is a voice cloning test.";

      const payload = {
        text: testText,
        ref_audio_path: profile.ref_audio_path,
        ref_text: profile.ref_text,
        ref_language: profile.language,
        top_p: profile.top_p,
        temperature: profile.temperature,
        text_split_method: profile.text_split_method,
        speed_factor: profile.speed_factor,
        repetition_penalty: profile.repetition_penalty,
        top_k: profile.top_k,
        sample_steps: 32,
      };

      const url = `${baseUrl}/tts`;
      const audioRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!audioRes.ok) {
        const errBody = await audioRes.text();
        res.status(502).json({ error: `Sidecar TTS returned HTTP ${audioRes.status}: ${errBody}` });
        return;
      }

      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
      res.set("Content-Type", "audio/wav").send(audioBuffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Audio API] POST /profiles/:id/test failed: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // ── Reference Audio Upload ────────────────────────────────────────────────

  /**
   * POST /upload/ref-audio — upload a reference audio WAV for Engine B voice cloning.
   *
   * Headers:
   *   x-file-name: <filename.wav>
   * Body: raw binary WAV bytes
   *
   * Returns: { filePath, fileName, size }
   */
  router.post(
    "/upload/ref-audio",
    raw({ type: "*/*", limit: "50mb" }),
    async (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "request body must contain audio bytes" });
          return;
        }

        const rawName = req.header("x-file-name") ?? "reference.wav";
        let decodedName: string;
        try {
          decodedName = decodeURIComponent(rawName);
        } catch {
          decodedName = rawName;
        }

        const safeName = path.basename(decodedName).replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileName = safeName || "reference.wav";
        const uniqueName = `${Date.now()}-${fileName}`;

        await fs.mkdir(uploadDir, { recursive: true });
        const filePath = path.join(uploadDir, uniqueName);
        await fs.writeFile(filePath, body);

        logger.info(`[Audio API] Uploaded ref audio: ${filePath} (${body.length} bytes)`);
        res.json({ success: true, filePath, fileName: uniqueName, size: body.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Audio API] POST /upload/ref-audio failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    },
  );

  return router;
};
