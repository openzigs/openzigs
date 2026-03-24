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
import { spawn, type ChildProcess } from "node:child_process";
import { Router, raw } from "express";
import { nanoid } from "nanoid";
import Database from "better-sqlite3";
import { logger } from "../logging/logger.js";
import { PROJECT_ROOT } from "../project-root.js";

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
  sample_steps: number;
  engine_type: string;
  created_at: string;
  updated_at: string;
}

export interface F5TTSClipRow {
  id: string;
  profile_id: string;
  emotion: string;
  ref_audio_path: string;
  ref_text: string;
  sort_order: number;
  created_at: string;
}

export interface AudioRouterOptions {
  db: Database.Database;
  sidecarUrl: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:5006";
const SOVITS_REF_AUDIO_MIN_SECONDS = 3;
const SOVITS_REF_AUDIO_MAX_SECONDS = 8;

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = parseJsonIfPossible(trimmed);
    if (parsed !== value) {
      return extractErrorMessage(parsed);
    }
    return trimmed;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const keys = ["error", "detail", "message", "Exception", "exception"];
  for (const key of keys) {
    const nested = extractErrorMessage(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function formatSidecarErrorMessage(rawBody: string): string {
  const parsed = parseJsonIfPossible(rawBody);
  const extracted = extractErrorMessage(parsed);
  if (!extracted) {
    return rawBody.trim() || "Unknown sidecar error";
  }

  if (extracted.includes("3-10 second range")) {
    return "Reference audio was auto-trimmed but still rejected by GPT-SoVITS. Try a shorter clip.";
  }

  return extracted;
}

async function probeAudioDurationSeconds(filePath: string): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      logger.warn(`[Audio API] ffprobe unavailable for duration check: ${err.message}`);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        logger.warn(`[Audio API] ffprobe failed for ${filePath}: ${stderr.trim() || `exit code ${code}`}`);
        resolve(null);
        return;
      }
      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        resolve(null);
        return;
      }
      resolve(duration);
    });
  });
}

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
   * Body: { engine: "kokoro" | "sovits" | "f5tts" }
   */
  router.post("/engine/switch", async (req, res) => {
    const { engine } = req.body as { engine?: string };
    if (!engine || !["kokoro", "sovits", "f5tts"].includes(engine)) {
      res.status(400).json({ error: "engine must be 'kokoro', 'sovits', or 'f5tts'" });
      return;
    }
    try {
      const data = await sidecarFetch(baseUrl, "/switch_engine", {
        method: "POST",
        body: JSON.stringify({ engine }),
      });
      logger.info(`[Audio API] Engine switched to: ${engine}`);

      // When switching to f5tts, push the first profile's clips to the sidecar
      // so that /tts routing works immediately without a manual "Try Voice" first.
      if (engine === "f5tts") {
        try {
          const profiles = db
            .prepare(`SELECT * FROM voice_profiles WHERE engine_type = 'f5tts' ORDER BY created_at ASC LIMIT 1`)
            .all() as VoiceProfile[];
          if (profiles.length > 0) {
            const clips = db
              .prepare(`SELECT * FROM f5tts_clips WHERE profile_id = ? ORDER BY sort_order ASC`)
              .all(profiles[0].id) as F5TTSClipRow[];
            if (clips.length > 0) {
              const clipPayload = clips.map((c) => ({
                emotion: c.emotion,
                ref_audio_path: c.ref_audio_path,
                ref_text: c.ref_text,
              }));
              await sidecarFetch(baseUrl, "/f5tts/set-active-clips", {
                method: "POST",
                body: JSON.stringify({ clips: clipPayload }),
              });
              logger.info(`[Audio API] Pushed ${clips.length} f5tts clip(s) to sidecar`);
            }
          }
        } catch (clipErr) {
          const msg = clipErr instanceof Error ? clipErr.message : String(clipErr);
          logger.warn(`[Audio API] Failed to push f5tts clips on switch: ${msg}`);
        }
      }

      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Audio API] POST /engine/switch failed: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // ── GPT-SoVITS Install (push-button from UI) ─────────────────────────────

  /** Singleton guard — only one install process at a time. */
  let sovitsInstallProc: ChildProcess | null = null;

  /**
   * GET /engine/sovits-install-status — check whether GPT-SoVITS is installed.
   * Returns: { installed: boolean }
   */
  router.get("/engine/sovits-install-status", async (_req, res) => {
    const installDir = path.join(os.homedir(), ".openzigs", "sidecars", "gptsovits");
    try {
      const requiredPaths = [
        path.join(installDir, ".git"),
        path.join(
          installDir,
          "GPT_SoVITS",
          "pretrained_models",
          "gsv-v2final-pretrained",
          "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
        ),
        path.join(
          installDir,
          "GPT_SoVITS",
          "pretrained_models",
          "gsv-v2final-pretrained",
          "s2G2333k.pth",
        ),
      ];
      await Promise.all(requiredPaths.map((pathToCheck) => fs.access(pathToCheck)));
      res.json({ installed: true, installing: sovitsInstallProc !== null });
    } catch {
      res.json({ installed: false, installing: sovitsInstallProc !== null });
    }
  });

  /**
   * POST /engine/install-sovits — run the GPT-SoVITS setup script and stream
   * output via Server-Sent Events so the UI can show real-time progress.
   *
   * The response is `text/event-stream`. Each line of stdout/stderr is sent as
   * a `data:` event with JSON `{ line, stream }`. A final `event: done` carries
   * `{ code }` (0 = success).
   */
  router.post("/engine/install-sovits", (req, res) => {
    if (sovitsInstallProc) {
      res.status(409).json({ error: "Install already in progress." });
      return;
    }

    const scriptPath = path.resolve(PROJECT_ROOT, "scripts", "setup-gptsovits.sh");

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (obj: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    send({ line: "Starting GPT-SoVITS installer…", stream: "system" });

    sovitsInstallProc = spawn("bash", [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleLine = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n");
      for (const line of lines) {
        if (line.length > 0) send({ line, stream });
      }
    };

    sovitsInstallProc.stdout?.on("data", handleLine("stdout"));
    sovitsInstallProc.stderr?.on("data", handleLine("stderr"));

    sovitsInstallProc.on("close", (code) => {
      sovitsInstallProc = null;
      const success = code === 0;
      logger.info(`[Audio API] GPT-SoVITS install exited with code ${code}`);
      send({ line: success ? "Installation complete!" : `Install exited with code ${code}`, stream: "system" });
      res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
      res.end();
    });

    sovitsInstallProc.on("error", (err) => {
      sovitsInstallProc = null;
      logger.error(`[Audio API] GPT-SoVITS install spawn error: ${err.message}`);
      send({ line: `Spawn error: ${err.message}`, stream: "stderr" });
      res.write(`event: done\ndata: ${JSON.stringify({ code: 1 })}\n\n`);
      res.end();
    });

    // If the client disconnects, kill the install process
    req.on("close", () => {
      if (sovitsInstallProc) {
        sovitsInstallProc.kill("SIGTERM");
        sovitsInstallProc = null;
      }
    });
  });

  // ── GPT-SoVITS Server Lifecycle ───────────────────────────────────────────

  /** Singleton — managed GPT-SoVITS server process. */
  let sovitsServerProc: ChildProcess | null = null;

  /**
   * POST /engine/start-sovits — start the GPT-SoVITS API server as a managed
   * background process. Streams output via SSE until the server is reachable,
   * then sends `event: ready`.
   */
  router.post("/engine/start-sovits", async (_req, res) => {
    if (sovitsServerProc) {
      res.status(409).json({ error: "GPT-SoVITS server is already running." });
      return;
    }

    const startScript = path.join(os.homedir(), ".openzigs", "sidecars", "gptsovits", "start.sh");
    try {
      await fs.access(startScript);
    } catch {
      res.status(400).json({ error: "GPT-SoVITS is not installed. Run the installer first." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (obj: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    send({ line: "Starting GPT-SoVITS server…", stream: "system" });

    sovitsServerProc = spawn("bash", [startScript], {
      cwd: path.join(os.homedir(), ".openzigs", "sidecars", "gptsovits"),
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const handleLine = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n");
      for (const line of lines) {
        if (line.length > 0) send({ line, stream });
      }
    };

    sovitsServerProc.stdout?.on("data", handleLine("stdout"));
    sovitsServerProc.stderr?.on("data", handleLine("stderr"));

    // Poll for readiness for up to 120 s.
    // GPT-SoVITS api_v2.py does not expose /health; probe /docs instead.
    const sovitsUrl = "http://127.0.0.1:9880";
    let ready = false;
    const pollStart = Date.now();
    const pollInterval = setInterval(async () => {
      if (ready || Date.now() - pollStart > 120_000) {
        clearInterval(pollInterval);
        if (!ready) {
          send({ line: "Timed out waiting for GPT-SoVITS server to respond.", stream: "stderr" });
          res.write(`event: done\ndata: ${JSON.stringify({ code: 1 })}\n\n`);
          res.end();
        }
        return;
      }
      try {
        const r = await fetch(`${sovitsUrl}/docs`, { signal: AbortSignal.timeout(2000) });
        if (r.status < 500) {
          ready = true;
          clearInterval(pollInterval);
          send({ line: `GPT-SoVITS server is ready at ${sovitsUrl}`, stream: "system" });
          res.write(`event: ready\ndata: ${JSON.stringify({ url: sovitsUrl })}\n\n`);
          res.end();
        }
      } catch {
        /* not ready yet */
      }
    }, 3000);

    sovitsServerProc.on("close", (code) => {
      sovitsServerProc = null;
      clearInterval(pollInterval);
      if (!ready) {
        send({ line: `GPT-SoVITS server exited with code ${code}`, stream: "stderr" });
        res.write(`event: done\ndata: ${JSON.stringify({ code: code ?? 1 })}\n\n`);
        res.end();
      }
    });

    sovitsServerProc.on("error", (err) => {
      sovitsServerProc = null;
      clearInterval(pollInterval);
      send({ line: `Spawn error: ${err.message}`, stream: "stderr" });
      res.write(`event: done\ndata: ${JSON.stringify({ code: 1 })}\n\n`);
      res.end();
    });

    // Don't kill the GPT-SoVITS server when the SSE connection closes —
    // it should keep running. Just unref so Node can exit cleanly.
    sovitsServerProc.unref();
  });

  /**
   * POST /engine/stop-sovits — stop the managed GPT-SoVITS server.
   */
  router.post("/engine/stop-sovits", (_req, res) => {
    if (!sovitsServerProc) {
      res.json({ stopped: false, message: "No managed GPT-SoVITS process running." });
      return;
    }
    try {
      sovitsServerProc.kill("SIGTERM");
      sovitsServerProc = null;
      logger.info("[Audio API] GPT-SoVITS server stopped by user.");
      res.json({ stopped: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
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
    *          text_split_method?, speed_factor?, repetition_penalty?, top_k?, sample_steps? }
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
      sample_steps = 32,
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
      sample_steps?: number;
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
            repetition_penalty, top_k, sample_steps, created_at, updated_at)
         VALUES
           (@id, @name, @ref_audio_path, @ref_text, @language,
            @top_p, @temperature, @text_split_method, @speed_factor,
            @repetition_penalty, @top_k, @sample_steps, @created_at, @updated_at)`,
      ).run({
        id, name: name.trim(), ref_audio_path, ref_text, language,
        top_p, temperature, text_split_method, speed_factor,
        repetition_penalty, top_k, sample_steps,
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
            repetition_penalty=@repetition_penalty, top_k=@top_k,
            sample_steps=@sample_steps, updated_at=@updated_at
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

      // Duration validation removed — sidecar auto-trims long clips for GPT-SoVITS

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
        sample_steps: profile.sample_steps,
      };

      const url = `${baseUrl}/tts`;
      const audioRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!audioRes.ok) {
        const errBody = await audioRes.text();
        const sidecarMessage = formatSidecarErrorMessage(errBody);
        const mappedStatus = audioRes.status >= 400 && audioRes.status < 500 ? 400 : 502;
        res.status(mappedStatus).json({ error: sidecarMessage });
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

        const rawName = String(req.header("x-file-name") || "reference.wav");
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

        const durationSeconds = await probeAudioDurationSeconds(filePath);
        if (
          durationSeconds !== null
          && (durationSeconds < SOVITS_REF_AUDIO_MIN_SECONDS || durationSeconds > SOVITS_REF_AUDIO_MAX_SECONDS)
        ) {
          await fs.unlink(filePath).catch(() => undefined);
          const rounded = Math.round(durationSeconds * 10) / 10;
          res.status(400).json({
            error: `Reference audio is ${rounded}s. GPT-SoVITS requires ${SOVITS_REF_AUDIO_MIN_SECONDS}–${SOVITS_REF_AUDIO_MAX_SECONDS}s.`,
          });
          return;
        }

        logger.info(`[Audio API] Uploaded ref audio: ${filePath} (${body.length} bytes)`);
        res.json({
          success: true,
          filePath,
          fileName: uniqueName,
          size: body.length,
          duration_seconds: durationSeconds,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Audio API] POST /upload/ref-audio failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    },
  );

  // ── F5-TTS Voice Profiles (Engine C) ───────────────────────────────────────

  /**
   * GET /f5tts/profiles — list all F5-TTS voice profiles with their clips.
   */
  router.get("/f5tts/profiles", (_req, res) => {
    try {
      const rows = db
        .prepare(`SELECT * FROM voice_profiles WHERE engine_type = 'f5tts' ORDER BY created_at DESC`)
        .all() as VoiceProfile[];

      const profilesWithClips = rows.map((profile) => {
        const clips = db
          .prepare(`SELECT * FROM f5tts_clips WHERE profile_id = ? ORDER BY sort_order ASC`)
          .all(profile.id) as F5TTSClipRow[];
        return { ...profile, clips };
      });

      res.json({ profiles: profilesWithClips, total: profilesWithClips.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Audio API] GET /f5tts/profiles failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /f5tts/profiles — create a new F5-TTS voice profile.
   * Body: { name }
   */
  router.post("/f5tts/profiles", (req, res) => {
    const { name } = req.body as { name?: string };

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const now = new Date().toISOString();
    const id = nanoid();

    try {
      db.prepare(
        `INSERT INTO voice_profiles
           (id, name, engine_type, created_at, updated_at)
         VALUES
           (@id, @name, 'f5tts', @created_at, @updated_at)`,
      ).run({ id, name: name.trim(), created_at: now, updated_at: now });

      const profile = db
        .prepare(`SELECT * FROM voice_profiles WHERE id = ?`)
        .get(id) as VoiceProfile;

      logger.info(`[Audio API] Created F5-TTS profile: ${id} (${name})`);
      res.status(201).json({ ...profile, clips: [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        res.status(409).json({ error: `A profile named "${name}" already exists` });
        return;
      }
      logger.error(`[Audio API] POST /f5tts/profiles failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /f5tts/profiles/:id — get a single F5-TTS profile with clips.
   */
  router.get("/f5tts/profiles/:id", (req, res) => {
    try {
      const profile = db
        .prepare(`SELECT * FROM voice_profiles WHERE id = ? AND engine_type = 'f5tts'`)
        .get(req.params.id) as VoiceProfile | undefined;

      if (!profile) {
        res.status(404).json({ error: `F5-TTS profile not found: ${req.params.id}` });
        return;
      }

      const clips = db
        .prepare(`SELECT * FROM f5tts_clips WHERE profile_id = ? ORDER BY sort_order ASC`)
        .all(profile.id) as F5TTSClipRow[];

      res.json({ ...profile, clips });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /f5tts/profiles/:id — delete an F5-TTS profile and its clips.
   */
  router.delete("/f5tts/profiles/:id", (req, res) => {
    try {
      const existing = db
        .prepare(`SELECT id FROM voice_profiles WHERE id = ? AND engine_type = 'f5tts'`)
        .get(req.params.id);

      if (!existing) {
        res.status(404).json({ error: `F5-TTS profile not found: ${req.params.id}` });
        return;
      }

      // Clips are cascade-deleted via FK
      db.prepare(`DELETE FROM voice_profiles WHERE id = ?`).run(req.params.id);
      logger.info(`[Audio API] Deleted F5-TTS profile: ${req.params.id}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /f5tts/profiles/:id/clips — add a clip to an F5-TTS profile.
   * Body: { emotion, ref_audio_path, ref_text? }
   */
  router.post("/f5tts/profiles/:id/clips", (req, res) => {
    const { emotion, ref_audio_path, ref_text = "" } = req.body as {
      emotion?: string;
      ref_audio_path?: string;
      ref_text?: string;
    };

    if (!emotion || typeof emotion !== "string" || !emotion.trim()) {
      res.status(400).json({ error: "emotion label is required" });
      return;
    }
    if (!ref_audio_path || typeof ref_audio_path !== "string") {
      res.status(400).json({ error: "ref_audio_path is required" });
      return;
    }

    try {
      const profile = db
        .prepare(`SELECT id FROM voice_profiles WHERE id = ? AND engine_type = 'f5tts'`)
        .get(req.params.id);

      if (!profile) {
        res.status(404).json({ error: `F5-TTS profile not found: ${req.params.id}` });
        return;
      }

      // Check if this emotion already exists for this profile
      const existing = db
        .prepare(`SELECT id FROM f5tts_clips WHERE profile_id = ? AND emotion = ?`)
        .get(req.params.id, emotion.trim());

      if (existing) {
        res.status(409).json({ error: `A clip with emotion "${emotion}" already exists for this profile` });
        return;
      }

      const clipId = nanoid();
      const now = new Date().toISOString();
      const maxOrder = db
        .prepare(`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM f5tts_clips WHERE profile_id = ?`)
        .get(req.params.id) as { max_order: number };

      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES (@id, @profile_id, @emotion, @ref_audio_path, @ref_text, @sort_order, @created_at)`,
      ).run({
        id: clipId,
        profile_id: req.params.id,
        emotion: emotion.trim(),
        ref_audio_path,
        ref_text,
        sort_order: maxOrder.max_order + 1,
        created_at: now,
      });

      // Update profile timestamp
      db.prepare(`UPDATE voice_profiles SET updated_at = ? WHERE id = ?`)
        .run(now, req.params.id);

      const clip = db
        .prepare(`SELECT * FROM f5tts_clips WHERE id = ?`)
        .get(clipId) as F5TTSClipRow;

      logger.info(`[Audio API] Added F5-TTS clip: ${clipId} (${emotion}) to profile ${req.params.id}`);
      res.status(201).json(clip);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Audio API] POST /f5tts/profiles/:id/clips failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /f5tts/clips/:clipId — delete a single clip.
   */
  router.delete("/f5tts/clips/:clipId", (req, res) => {
    try {
      const clip = db
        .prepare(`SELECT * FROM f5tts_clips WHERE id = ?`)
        .get(req.params.clipId) as F5TTSClipRow | undefined;

      if (!clip) {
        res.status(404).json({ error: `Clip not found: ${req.params.clipId}` });
        return;
      }

      db.prepare(`DELETE FROM f5tts_clips WHERE id = ?`).run(req.params.clipId);
      logger.info(`[Audio API] Deleted F5-TTS clip: ${req.params.clipId}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /f5tts/clips/:clipId/audio — stream the reference audio file for playback.
   */
  router.get("/f5tts/clips/:clipId/audio", async (req, res) => {
    try {
      const clip = db
        .prepare(`SELECT * FROM f5tts_clips WHERE id = ?`)
        .get(req.params.clipId) as F5TTSClipRow | undefined;

      if (!clip) {
        res.status(404).json({ error: `Clip not found: ${req.params.clipId}` });
        return;
      }

      const filePath = clip.ref_audio_path;
      try {
        await fs.access(filePath);
      } catch {
        res.status(404).json({ error: "Reference audio file not found on disk." });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".m4a": "audio/mp4",
      };
      const contentType = mimeMap[ext] ?? "application/octet-stream";
      const data = await fs.readFile(filePath);
      res.set("Content-Type", contentType).send(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /f5tts/profiles/:id/test — synthesize a test phrase with F5-TTS.
   * Body: { text? }
   * Returns: audio/wav binary
   */
  router.post("/f5tts/profiles/:id/test", async (req, res) => {
    try {
      const profile = db
        .prepare(`SELECT * FROM voice_profiles WHERE id = ? AND engine_type = 'f5tts'`)
        .get(req.params.id) as VoiceProfile | undefined;

      if (!profile) {
        res.status(404).json({ error: `F5-TTS profile not found: ${req.params.id}` });
        return;
      }

      const clips = db
        .prepare(`SELECT * FROM f5tts_clips WHERE profile_id = ? ORDER BY sort_order ASC`)
        .all(req.params.id) as F5TTSClipRow[];

      if (clips.length === 0) {
        res.status(400).json({ error: "Profile has no clips. Add at least one 'Regular' clip." });
        return;
      }

      const hasRegular = clips.some((c) => c.emotion === "Regular");
      if (!hasRegular) {
        res.status(400).json({ error: "Profile must have a 'Regular' emotion clip." });
        return;
      }

      const testText: string = (req.body as { text?: string; speed?: number }).text?.trim()
        || "Hello, this is a voice cloning test with F5 TTS.";
      const testSpeed: number = Math.max(0.25, Math.min(2.0,
        Number((req.body as { speed?: number }).speed) || 1.0,
      ));

      const payload = {
        text: testText,
        clips: clips.map((c) => ({
          emotion: c.emotion,
          ref_audio_path: c.ref_audio_path,
          ref_text: c.ref_text,
        })),
        speed: testSpeed,
      };

      const url = `${baseUrl}/f5tts`;
      const audioRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000), // 3 min — F5-TTS can take ~60s on first run
      });

      if (!audioRes.ok) {
        const errBody = await audioRes.text();
        const sidecarMessage = formatSidecarErrorMessage(errBody);
        const mappedStatus = audioRes.status >= 400 && audioRes.status < 500 ? 400 : 502;
        res.status(mappedStatus).json({ error: sidecarMessage });
        return;
      }

      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
      res.set("Content-Type", "audio/wav").send(audioBuffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Audio API] POST /f5tts/profiles/:id/test failed: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  /**
   * POST /upload/f5tts-ref-audio — upload reference audio for F5-TTS (Engine C).
   *
   * F5-TTS has relaxed duration constraints (up to 15 seconds).
   * The sidecar handles conversion to 24kHz mono WAV.
   *
   * Headers:
   *   x-file-name: <filename.wav>
   * Body: raw binary audio bytes
   *
   * Returns: { filePath, fileName, size, duration_seconds }
   */
  router.post(
    "/upload/f5tts-ref-audio",
    raw({ type: "*/*", limit: "50mb" }),
    async (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "request body must contain audio bytes" });
          return;
        }

        const rawName = String(req.header("x-file-name") || "reference.wav");
        let decodedName: string;
        try {
          decodedName = decodeURIComponent(rawName);
        } catch {
          decodedName = rawName;
        }

        const safeName = path.basename(decodedName).replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileName = safeName || "reference.wav";
        const uniqueName = `${Date.now()}-${fileName}`;

        const f5ttsUploadDir = path.join(os.homedir(), ".openzigs", "director", "f5tts-ref-audio");
        await fs.mkdir(f5ttsUploadDir, { recursive: true });
        const filePath = path.join(f5ttsUploadDir, uniqueName);
        await fs.writeFile(filePath, body);

        const durationSeconds = await probeAudioDurationSeconds(filePath);

        // F5-TTS: max 15 seconds reference audio
        if (durationSeconds !== null && durationSeconds > 15) {
          await fs.unlink(filePath).catch(() => undefined);
          const rounded = Math.round(durationSeconds * 10) / 10;
          res.status(400).json({
            error: `Reference audio is ${rounded}s. F5-TTS clips must be 15s or shorter.`,
          });
          return;
        }

        logger.info(`[Audio API] Uploaded F5-TTS ref audio: ${filePath} (${body.length} bytes)`);
        res.json({
          success: true,
          filePath,
          fileName: uniqueName,
          size: body.length,
          duration_seconds: durationSeconds,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Audio API] POST /upload/f5tts-ref-audio failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    },
  );

  return router;
};
