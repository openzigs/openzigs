import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createAudioRouter } from "./audio.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock spawn for ffprobe/install scripts — always return null duration
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    proc.unref = vi.fn();
    // Simulate instant close with non-zero (ffprobe not available)
    setTimeout(() => proc.emit("close", 1), 5);
    return proc;
  }),
}));

// ── Helpers ──────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      ref_audio_path TEXT NOT NULL DEFAULT '',
      ref_text TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      top_p REAL NOT NULL DEFAULT 0.8,
      temperature REAL NOT NULL DEFAULT 1.0,
      text_split_method TEXT NOT NULL DEFAULT 'cut5',
      speed_factor REAL NOT NULL DEFAULT 1.0,
      repetition_penalty REAL NOT NULL DEFAULT 1.35,
      top_k INTEGER NOT NULL DEFAULT 15,
      sample_steps INTEGER NOT NULL DEFAULT 32,
      engine_type TEXT NOT NULL DEFAULT 'sovits',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS f5tts_clips (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      emotion TEXT NOT NULL,
      ref_audio_path TEXT NOT NULL DEFAULT '',
      ref_text TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (profile_id) REFERENCES voice_profiles(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function buildApp(db?: Database.Database) {
  const app = express();
  app.use(express.json());
  const testDb = db ?? createTestDb();
  const router = createAudioRouter({ db: testDb, sidecarUrl: "http://127.0.0.1:59999" });
  app.use("/audio", router);
  return { app, db: testDb };
}

// ── Tests ────────────────────────────────────────────────────

describe("Audio API router", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Engine Status (proxy) ──────────────────────────────────

  describe("GET /engine/status", () => {
    it("returns 503 when sidecar is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const { app } = buildApp();
      const res = await request(app).get("/audio/engine/status");
      expect(res.status).toBe(503);
    });

    it("proxies sidecar health", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ engine: "kokoro", status: "ready" }),
      });
      const { app } = buildApp();
      const res = await request(app).get("/audio/engine/status");
      expect(res.status).toBe(200);
      expect(res.body.engine).toBe("kokoro");
    });
  });

  // ── Engine Switch ──────────────────────────────────────────

  describe("POST /engine/switch", () => {
    it("rejects invalid engine", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/switch").send({ engine: "bad" });
      expect(res.status).toBe(400);
    });

    it("rejects missing engine", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/switch").send({});
      expect(res.status).toBe(400);
    });

    it("switches to kokoro", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ engine: "kokoro" }),
      });
      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/switch").send({ engine: "kokoro" });
      expect(res.status).toBe(200);
    });

    it("returns 502 on sidecar failure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/switch").send({ engine: "sovits" });
      expect(res.status).toBe(502);
    });
  });

  // ── Voices (Kokoro presets) ────────────────────────────────

  describe("GET /voices", () => {
    it("proxies voice list from sidecar", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ voices: ["af_heart", "af_sky"] }),
      });
      const { app } = buildApp();
      const res = await request(app).get("/audio/voices");
      expect(res.status).toBe(200);
      expect(res.body.voices).toEqual(["af_heart", "af_sky"]);
    });
  });

  // ── SoVITS Profiles CRUD ───────────────────────────────────

  describe("GET /profiles", () => {
    it("returns empty list initially", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/audio/profiles");
      expect(res.status).toBe(200);
      expect(res.body.profiles).toEqual([]);
      expect(res.body.total).toBe(0);
    });
  });

  describe("POST /profiles", () => {
    it("creates a voice profile", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles").send({
        name: "Test Voice",
        ref_audio_path: "/tmp/test.wav",
        ref_text: "hello world",
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Test Voice");
      expect(res.body.ref_audio_path).toBe("/tmp/test.wav");
    });

    it("rejects missing name", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles").send({
        ref_audio_path: "/tmp/test.wav",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing ref_audio_path", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles").send({
        name: "Test",
      });
      expect(res.status).toBe(400);
    });

    it("rejects duplicate name", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at) 
         VALUES ('p1', 'Dupe', '/a.wav', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles").send({
        name: "Dupe",
        ref_audio_path: "/b.wav",
      });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /profiles/:id", () => {
    it("returns a profile", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at) 
         VALUES ('p1', 'Voice1', '/a.wav', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).get("/audio/profiles/p1");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Voice1");
    });

    it("returns 404 for missing profile", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/audio/profiles/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /profiles/:id", () => {
    it("updates a profile", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at) 
         VALUES ('p1', 'Voice1', '/a.wav', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).put("/audio/profiles/p1").send({ name: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated");
    });

    it("returns 404 for missing profile", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/audio/profiles/missing").send({ name: "X" });
      expect(res.status).toBe(404);
    });

    it("rejects empty name", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at) 
         VALUES ('p1', 'Voice1', '/a.wav', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).put("/audio/profiles/p1").send({ name: "" });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /profiles/:id", () => {
    it("deletes a profile", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at) 
         VALUES ('p1', 'Voice1', '/a.wav', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).delete("/audio/profiles/p1");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for missing profile", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/audio/profiles/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── F5-TTS Profiles ────────────────────────────────────────

  describe("GET /f5tts/profiles", () => {
    it("returns empty list", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/audio/f5tts/profiles");
      expect(res.status).toBe(200);
      expect(res.body.profiles).toEqual([]);
    });

    it("returns profiles with clips", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at) 
         VALUES ('fp1', 'F5 Voice', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, sort_order, created_at) 
         VALUES ('c1', 'fp1', 'Regular', '/ref.wav', 0, datetime('now'))`,
      ).run();
      const res = await request(app).get("/audio/f5tts/profiles");
      expect(res.status).toBe(200);
      expect(res.body.profiles).toHaveLength(1);
      expect(res.body.profiles[0].clips).toHaveLength(1);
    });
  });

  describe("POST /f5tts/profiles", () => {
    it("creates an F5-TTS profile", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/f5tts/profiles").send({ name: "F5 Voice" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("F5 Voice");
      expect(res.body.clips).toEqual([]);
    });

    it("rejects missing name", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/f5tts/profiles").send({});
      expect(res.status).toBe(400);
    });

    it("rejects duplicate name", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'Dupe', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles").send({ name: "Dupe" });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /f5tts/profiles/:id", () => {
    it("returns profile with clips", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at and) 
         VALUES ('fp1', 'F5 Voice', 'f5tts', datetime('now'), datetime('now'))`.replace(" and", ""),
      ).run();
      const res = await request(app).get("/audio/f5tts/profiles/fp1");
      expect(res.status).toBe(200);
      expect(res.body.clips).toEqual([]);
    });

    it("returns 404 for missing profile", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/audio/f5tts/profiles/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /f5tts/profiles/:id", () => {
    it("deletes profile", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at) 
         VALUES ('fp1', 'F5 Voice', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).delete("/audio/f5tts/profiles/fp1");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for missing F5 profile", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/audio/f5tts/profiles/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── F5-TTS Clips ──────────────────────────────────────────

  describe("POST /f5tts/profiles/:id/clips", () => {
    it("adds a clip to a profile", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "Regular",
        ref_audio_path: "/ref.wav",
        ref_text: "hello",
      });
      expect(res.status).toBe(201);
      expect(res.body.emotion).toBe("Regular");
    });

    it("rejects missing emotion", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        ref_audio_path: "/ref.wav",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing ref_audio_path", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "Regular",
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent profile", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/f5tts/profiles/none/clips").send({
        emotion: "Regular",
        ref_audio_path: "/ref.wav",
      });
      expect(res.status).toBe(404);
    });

    it("rejects duplicate emotion", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "Regular",
        ref_audio_path: "/r2.wav",
      });
      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /f5tts/clips/:clipId", () => {
    it("deletes a clip", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 0, datetime('now'))`,
      ).run();
      const res = await request(app).delete("/audio/f5tts/clips/c1");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for missing clip", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/audio/f5tts/clips/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Engine stop-sovits ─────────────────────────────────────

  describe("POST /engine/stop-sovits", () => {
    it("reports no process running", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/stop-sovits");
      expect(res.status).toBe(200);
      expect(res.body.stopped).toBe(false);
    });
  });

  // ── SoVITS Profile test (proxy) ────────────────────────────

  describe("POST /profiles/:id/test", () => {
    it("returns 404 for missing profile", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles/missing/test").send({});
      expect(res.status).toBe(404);
    });
  });

  // ── F5-TTS Profile test ───────────────────────────────────

  describe("POST /f5tts/profiles/:id/test", () => {
    it("returns 404 for missing profile", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/f5tts/profiles/missing/test").send({});
      expect(res.status).toBe(404);
    });

    it("returns 400 when profile has no clips", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("no clips");
    });

    it("returns 400 when no Regular clip", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Happy', '/r.wav', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Regular");
    });

    it("proxies to sidecar and returns audio on success", async () => {
      const wavBytes = Buffer.from("RIFF....WAVEfmt ", "ascii");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 'hello', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({ text: "Hi" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("audio/wav");
    });

    it("returns error when sidecar fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 'hello', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({});
      expect(res.status).toBe(502);
    });
  });

  // ── Engine switch network error ────────────────────────

  describe("POST /engine/switch (network error)", () => {
    it("returns 503 when sidecar is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/switch").send({ engine: "kokoro" });
      // The route catches fetch errors and returns 502 or 503
      expect([502, 503]).toContain(res.status);
    });
  });

  // ── GET /voices error path ─────────────────────────────

  describe("GET /voices (error path)", () => {
    it("returns 503 when sidecar is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const { app } = buildApp();
      const res = await request(app).get("/audio/voices");
      expect(res.status).toBe(503);
    });
  });

  // ── SoVITS Profile creation with all optional params ───

  describe("POST /profiles (extended)", () => {
    it("creates profile with optional params", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles").send({
        name: "Full Voice",
        ref_audio_path: "/tmp/test.wav",
        ref_text: "hello world",
        language: "zh",
        top_p: 0.9,
        temperature: 0.8,
        speed_factor: 1.2,
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Full Voice");
      expect(res.body.language).toBe("zh");
    });
  });

  // ── PUT /profiles/:id extended ─────────────────────────

  describe("PUT /profiles/:id (extended)", () => {
    it("updates multiple fields", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).put("/audio/profiles/p1").send({
        name: "Updated Voice",
        language: "ja",
        speed_factor: 1.5,
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated Voice");
    });
  });

  // ── POST /profiles/:id/test (sidecar proxy paths) ─────

  describe("POST /profiles/:id/test (proxy)", () => {
    it("proxies test to sidecar and returns audio", async () => {
      const wavBytes = Buffer.from("RIFF....WAVEfmt ", "ascii");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', 'hello', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles/p1/test").send({ text: "Test phrase" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("audio/wav");
    });

    it("returns error when sidecar rejects", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"detail":"Bad reference audio"}'),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', 'hello', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles/p1/test").send({});
      expect(res.status).toBe(400);
    });
  });

  // ── GET /f5tts/clips/:clipId/audio ─────────────────────

  describe("GET /f5tts/clips/:clipId/audio", () => {
    it("returns 404 for missing clip", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/audio/f5tts/clips/missing/audio");
      expect(res.status).toBe(404);
    });

    it("returns 404 when audio file does not exist on disk", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/nonexistent/path/audio.wav', 0, datetime('now'))`,
      ).run();
      const res = await request(app).get("/audio/f5tts/clips/c1/audio");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found on disk");
    });
  });

  // ── GET /engine/sovits-install-status ──────────────────

  describe("GET /engine/sovits-install-status", () => {
    it("returns install status with expected shape", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/audio/engine/sovits-install-status");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("installed");
      expect(res.body).toHaveProperty("installing");
      expect(typeof res.body.installed).toBe("boolean");
      expect(res.body.installing).toBe(false);
    });
  });

  // ── POST /engine/install-sovits (conflict) ────────────

  describe("POST /engine/install-sovits", () => {
    // The SSE route is hard to test fully, but we can verify the 409 branch
    // by noting that the singleton guard should not be set initially
    // (since install-sovits spawns a process that immediately fails in test env)
    it("starts install (SSE response)", async () => {
      const { app } = buildApp();
      // The endpoint writes SSE headers and streams — supertest will get
      // the response once the process closes (which happens quickly in test)
      const res = await request(app).post("/audio/engine/install-sovits");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
    });
  });

  // ── Engine switch to f5tts (clip push branch) ─────────────

  describe("POST /engine/switch (f5tts clip push)", () => {
    it("switches to f5tts and pushes clips to sidecar", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5 Voice', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/ref.wav', 'hello', 0, datetime('now'))`,
      ).run();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ engine: "f5tts" }),
      });

      const res = await request(app).post("/audio/engine/switch").send({ engine: "f5tts" });
      expect(res.status).toBe(200);
      // Should have called sidecar twice: /switch_engine + /f5tts/set-active-clips
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("switches to f5tts but tolerates clip push failure", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5 Voice', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/ref.wav', 'hello', 0, datetime('now'))`,
      ).run();

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ engine: "f5tts" }) });
        }
        // Second call (set-active-clips) fails
        return Promise.reject(new Error("clip push failed"));
      });

      const res = await request(app).post("/audio/engine/switch").send({ engine: "f5tts" });
      // Should still return 200 — clip push failure is non-fatal
      expect(res.status).toBe(200);
    });

    it("switches to f5tts with no f5tts profiles — skips clip push", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ engine: "f5tts" }),
      });

      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/switch").send({ engine: "f5tts" });
      expect(res.status).toBe(200);
      // Only one call: /switch_engine (no clips to push)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("switches to f5tts with profile but no clips — skips push", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5 Voice', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ engine: "f5tts" }),
      });

      const res = await request(app).post("/audio/engine/switch").send({ engine: "f5tts" });
      expect(res.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // ── Engine switch to sovits (no clip push) ────────────────

  describe("POST /engine/switch (sovits)", () => {
    it("switches to sovits without clip push", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ engine: "sovits" }),
      });
      const { app } = buildApp();
      const res = await request(app).post("/audio/engine/switch").send({ engine: "sovits" });
      expect(res.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // ── Profile creation edge cases ───────────────────────────

  describe("POST /profiles (edge cases)", () => {
    it("rejects whitespace-only name", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles").send({
        name: "   ",
        ref_audio_path: "/tmp/test.wav",
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-string ref_audio_path", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles").send({
        name: "Voice",
        ref_audio_path: 12345,
      });
      expect(res.status).toBe(400);
    });

    it("creates profile with all default optional params", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/profiles").send({
        name: "Minimal",
        ref_audio_path: "/tmp/test.wav",
      });
      expect(res.status).toBe(201);
      expect(res.body.language).toBe("en");
      expect(res.body.top_p).toBe(0.8);
      expect(res.body.temperature).toBe(1.0);
      expect(res.body.speed_factor).toBe(1.0);
      expect(res.body.repetition_penalty).toBe(1.35);
      expect(res.body.top_k).toBe(15);
      expect(res.body.sample_steps).toBe(32);
      expect(res.body.text_split_method).toBe("cut5");
    });
  });

  // ── Profile update edge cases ─────────────────────────────

  describe("PUT /profiles/:id (edge cases)", () => {
    it("preserves id and created_at on update", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
      ).run();
      const res = await request(app).put("/audio/profiles/p1").send({ name: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("p1");
      expect(res.body.created_at).toBe("2025-01-01T00:00:00Z");
      expect(res.body.updated_at).not.toBe("2025-01-01T00:00:00Z");
    });

    it("updates ref_audio_path and ref_text", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/old.wav', 'old text', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).put("/audio/profiles/p1").send({
        ref_audio_path: "/new.wav",
        ref_text: "new text",
      });
      expect(res.status).toBe(200);
      expect(res.body.ref_audio_path).toBe("/new.wav");
      expect(res.body.ref_text).toBe("new text");
    });
  });

  // ── Profile test with default text ────────────────────────

  describe("POST /profiles/:id/test (default text)", () => {
    it("uses default text when none provided", async () => {
      const wavBytes = Buffer.from("RIFF....WAVEfmt ", "ascii");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', 'hello', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles/p1/test").send({});
      expect(res.status).toBe(200);
      // Verify default text was sent to sidecar
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.text).toBe("Hello, this is a voice cloning test.");
    });

    it("returns 502 when sidecar is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', 'hello', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles/p1/test").send({});
      expect(res.status).toBe(502);
    });

    it("maps 4xx sidecar error to 400", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve('{"error":"Invalid parameters"}'),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', 'hello', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles/p1/test").send({});
      expect(res.status).toBe(400);
    });

    it("maps 5xx sidecar error to 502", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server Error"),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', 'hello', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles/p1/test").send({});
      expect(res.status).toBe(502);
    });

    it("handles sidecar error with 3-10 second range message", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"detail":"Audio must be in 3-10 second range"}'),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', 'hello', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/profiles/p1/test").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("auto-trimmed");
    });
  });

  // ── F5-TTS profile test edge cases ────────────────────────

  describe("POST /f5tts/profiles/:id/test (edge cases)", () => {
    it("uses default text and clamps speed", async () => {
      const wavBytes = Buffer.from("RIFF....WAVEfmt ", "ascii");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 'hello', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({ speed: 99 });
      expect(res.status).toBe(200);
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      // Speed should be clamped to 2.0
      expect(body.speed).toBe(2.0);
      // Should use default text
      expect(body.text).toBe("Hello, this is a voice cloning test with F5 TTS.");
    });

    it("clamps speed below minimum to 0.25", async () => {
      const wavBytes = Buffer.from("RIFF....WAVEfmt ", "ascii");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 'hello', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({ speed: 0.01 });
      expect(res.status).toBe(200);
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.speed).toBe(0.25);
    });

    it("returns 502 when sidecar is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 'hello', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({});
      expect(res.status).toBe(502);
    });

    it("maps 4xx sidecar error to 400", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve('{"error":"bad clip"}'),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 'hello', 0, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({});
      expect(res.status).toBe(400);
    });

    it("sends multiple clips to sidecar", async () => {
      const wavBytes = Buffer.from("RIFF....WAVEfmt ", "ascii");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c1', 'fp1', 'Regular', '/r.wav', 'hello', 0, datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO f5tts_clips (id, profile_id, emotion, ref_audio_path, ref_text, sort_order, created_at)
         VALUES ('c2', 'fp1', 'Happy', '/h.wav', 'bye', 1, datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/test").send({ text: "Two clips" });
      expect(res.status).toBe(200);
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.clips).toHaveLength(2);
    });
  });

  // ── F5-TTS profile creation edge cases ────────────────────

  describe("POST /f5tts/profiles (edge cases)", () => {
    it("rejects whitespace-only name", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/f5tts/profiles").send({ name: "   " });
      expect(res.status).toBe(400);
    });

    it("rejects non-string name", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/audio/f5tts/profiles").send({ name: 123 });
      expect(res.status).toBe(400);
    });
  });

  // ── F5-TTS clip addition edge cases ───────────────────────

  describe("POST /f5tts/profiles/:id/clips (edge cases)", () => {
    it("rejects whitespace-only emotion", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "   ",
        ref_audio_path: "/ref.wav",
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-string ref_audio_path", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "Regular",
        ref_audio_path: 12345,
      });
      expect(res.status).toBe(400);
    });

    it("assigns incremental sort_order", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', datetime('now'), datetime('now'))`,
      ).run();

      const res1 = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "Regular",
        ref_audio_path: "/r.wav",
      });
      expect(res1.status).toBe(201);
      expect(res1.body.sort_order).toBe(0);

      const res2 = await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "Happy",
        ref_audio_path: "/h.wav",
      });
      expect(res2.status).toBe(201);
      expect(res2.body.sort_order).toBe(1);
    });

    it("updates profile timestamp on clip addition", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('fp1', 'F5', 'f5tts', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
      ).run();

      await request(app).post("/audio/f5tts/profiles/fp1/clips").send({
        emotion: "Regular",
        ref_audio_path: "/r.wav",
      });

      const profile = db.prepare(`SELECT updated_at FROM voice_profiles WHERE id = 'fp1'`).get() as { updated_at: string };
      expect(profile.updated_at).not.toBe("2025-01-01T00:00:00Z");
    });

    it("handles non-existent sovits profile for clip (not f5tts)", async () => {
      const { app, db } = buildApp();
      // Create a sovits profile (not f5tts)
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('sp1', 'SoVITS', 'sovits', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).post("/audio/f5tts/profiles/sp1/clips").send({
        emotion: "Regular",
        ref_audio_path: "/r.wav",
      });
      // Should 404 because profile is not f5tts
      expect(res.status).toBe(404);
    });
  });

  // ── F5-TTS profile GET single (non-f5tts profile) ────────

  describe("GET /f5tts/profiles/:id (non-f5tts)", () => {
    it("returns 404 for sovits profile", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('sp1', 'SoVITS', 'sovits', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).get("/audio/f5tts/profiles/sp1");
      expect(res.status).toBe(404);
    });
  });

  // ── F5-TTS profile DELETE (non-f5tts) ─────────────────────

  describe("DELETE /f5tts/profiles/:id (non-f5tts)", () => {
    it("returns 404 for sovits profile", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, engine_type, created_at, updated_at)
         VALUES ('sp1', 'SoVITS', 'sovits', datetime('now'), datetime('now'))`,
      ).run();
      const res = await request(app).delete("/audio/f5tts/profiles/sp1");
      expect(res.status).toBe(404);
    });
  });

  // ── Profiles listing with data ────────────────────────────

  describe("GET /profiles (with data)", () => {
    it("returns profiles ordered by created_at DESC", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at)
         VALUES ('p1', 'First', '/a.wav', '2025-01-01', '2025-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at)
         VALUES ('p2', 'Second', '/b.wav', '2025-06-01', '2025-06-01')`,
      ).run();
      const res = await request(app).get("/audio/profiles");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.profiles[0].name).toBe("Second");
      expect(res.body.profiles[1].name).toBe("First");
    });
  });

  // ── GET /profiles/:id error path ──────────────────────────

  describe("GET /profiles/:id (error handling)", () => {
    it("returns 500 on DB query error", async () => {
      const { app, db } = buildApp();
      // Close the db to force an error
      db.close();
      const res = await request(app).get("/audio/profiles/p1");
      expect(res.status).toBe(500);
    });
  });

  // ── DELETE /profiles/:id error path ───────────────────────

  describe("DELETE /profiles/:id (error handling)", () => {
    it("returns 500 on DB error", async () => {
      const { app, db } = buildApp();
      db.prepare(
        `INSERT INTO voice_profiles (id, name, ref_audio_path, created_at, updated_at)
         VALUES ('p1', 'Voice1', '/a.wav', datetime('now'), datetime('now'))`,
      ).run();
      // Drop the table to force an error on delete
      db.exec("DROP TABLE f5tts_clips");
      db.exec("DROP TABLE voice_profiles");
      const res = await request(app).delete("/audio/profiles/p1");
      expect(res.status).toBe(500);
    });
  });

  // ── Engine status with sidecar HTTP error ─────────────────

  describe("GET /engine/status (non-ok sidecar)", () => {
    it("returns 503 when sidecar returns non-ok HTTP", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
      const { app } = buildApp();
      const res = await request(app).get("/audio/engine/status");
      expect(res.status).toBe(503);
    });
  });
});
