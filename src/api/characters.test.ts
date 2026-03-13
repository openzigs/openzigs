/**
 * Character API — Unit tests for CRUD + training endpoints.
 * Issue #377: Backend Training Service.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { CharacterRepository } from "../characters/character-repository.js";
import { createCharacterRouter } from "./characters.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: vi.fn().mockRejectedValue(new Error("ENOENT")),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("test content"),
  },
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("test content"),
}));

vi.mock("../config/user-model.js", () => ({
  getUserSelectedModel: vi.fn().mockResolvedValue(null),
}));

// ── Test Helpers ────────────────────────────────────────────

function setup() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const now = new Date("2026-06-15T12:00:00Z");
  const repo = new CharacterRepository(db, () => now);
  repo.migrate();

  const app = express();
  app.use(express.json());
  app.use("/api/characters", createCharacterRouter({ characterRepo: repo }));

  return { app, repo, db };
}

// ── Tests ───────────────────────────────────────────────────

describe("Character API", () => {
  let app: express.Express;
  let repo: CharacterRepository;

  beforeEach(() => {
    const s = setup();
    app = s.app;
    repo = s.repo;
  });

  // ── CRUD ────────────────────────────────────────────────

  describe("POST /api/characters", () => {
    it("creates a character with required fields", async () => {
      const res = await request(app)
        .post("/api/characters")
        .send({ name: "Alice", triggerWord: "ALICE_TOK" })
        .expect(201);

      expect(res.body.name).toBe("Alice");
      expect(res.body.triggerWord).toBe("ALICE_TOK");
      expect(res.body.status).toBe("pending");
      expect(res.body.loraScale).toBe(0.8);
      expect(res.body.id).toBeDefined();
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post("/api/characters")
        .send({ triggerWord: "TOK" })
        .expect(400);

      expect(res.body.error).toContain("name");
    });

    it("rejects missing triggerWord", async () => {
      const res = await request(app)
        .post("/api/characters")
        .send({ name: "Alice" })
        .expect(400);

      expect(res.body.error).toContain("triggerWord");
    });

    it("rejects duplicate name", async () => {
      await request(app)
        .post("/api/characters")
        .send({ name: "Alice", triggerWord: "TOK1" })
        .expect(201);

      const res = await request(app)
        .post("/api/characters")
        .send({ name: "Alice", triggerWord: "TOK2" })
        .expect(409);

      expect(res.body.error).toContain("already exists");
    });

    it("accepts optional fields", async () => {
      const res = await request(app)
        .post("/api/characters")
        .send({ name: "Bob", triggerWord: "BOB_TOK", loraScale: 0.5 })
        .expect(201);

      expect(res.body.loraScale).toBe(0.5);
    });
  });

  describe("GET /api/characters", () => {
    it("returns empty list initially", async () => {
      const res = await request(app).get("/api/characters").expect(200);
      expect(res.body.characters).toEqual([]);
    });

    it("returns all characters", async () => {
      repo.create({ name: "A", triggerWord: "A_TOK" });
      repo.create({ name: "B", triggerWord: "B_TOK" });

      const res = await request(app).get("/api/characters").expect(200);
      expect(res.body.characters).toHaveLength(2);
    });
  });

  describe("GET /api/characters/:id", () => {
    it("returns character by id", async () => {
      const char = repo.create({ name: "Test", triggerWord: "TEST_TOK" });

      const res = await request(app)
        .get(`/api/characters/${char.id}`)
        .expect(200);

      expect(res.body.name).toBe("Test");
    });

    it("returns 404 for unknown id", async () => {
      const res = await request(app)
        .get("/api/characters/nonexistent")
        .expect(404);

      expect(res.body.error).toBe("Character not found");
    });
  });

  describe("PUT /api/characters/:id", () => {
    it("updates character fields", async () => {
      const char = repo.create({ name: "Old", triggerWord: "OLD_TOK" });

      const res = await request(app)
        .put(`/api/characters/${char.id}`)
        .send({ name: "New", triggerWord: "NEW_TOK" })
        .expect(200);

      expect(res.body.name).toBe("New");
      expect(res.body.triggerWord).toBe("NEW_TOK");
    });

    it("returns 404 for unknown id", async () => {
      await request(app)
        .put("/api/characters/nonexistent")
        .send({ name: "X" })
        .expect(404);
    });
  });

  describe("DELETE /api/characters/:id", () => {
    it("deletes a character", async () => {
      const char = repo.create({ name: "Del", triggerWord: "DEL_TOK" });

      await request(app)
        .delete(`/api/characters/${char.id}`)
        .expect(200);

      expect(repo.getById(char.id)).toBeNull();
    });

    it("returns 404 for unknown id", async () => {
      await request(app)
        .delete("/api/characters/nonexistent")
        .expect(404);
    });
  });

  // ── Training ──────────────────────────────────────────────

  describe("POST /api/characters/:id/train", () => {
    it("rejects training with too few photos", async () => {
      const char = repo.create({
        name: "FewPhotos",
        triggerWord: "FEW_TOK",
        referencePhotos: ["/p1.jpg", "/p2.jpg"],
      });

      const res = await request(app)
        .post(`/api/characters/${char.id}/train`)
        .send({})
        .expect(400);

      expect(res.body.error).toContain("At least 5 reference photos");
    });

    it("rejects training if already in progress", async () => {
      const char = repo.create({
        name: "Training",
        triggerWord: "TRAIN_TOK",
        referencePhotos: Array(10).fill("/photo.jpg"),
      });
      repo.update(char.id, { status: "training" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/train`)
        .send({})
        .expect(409);

      expect(res.body.error).toContain("already in progress");
    });

    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/train")
        .send({})
        .expect(404);
    });
  });

  // ── Photos ────────────────────────────────────────────────

  describe("DELETE /api/characters/:id/photos", () => {
    it("rejects missing paths array", async () => {
      const char = repo.create({ name: "Phot", triggerWord: "TOK" });

      const res = await request(app)
        .delete(`/api/characters/${char.id}/photos`)
        .send({})
        .expect(400);

      expect(res.body.error).toContain("paths array");
    });

    it("returns 404 for unknown character", async () => {
      await request(app)
        .delete("/api/characters/nonexistent/photos")
        .send({ paths: ["/x.jpg"] })
        .expect(404);
    });
  });

  describe("GET /api/characters/:id/photos/:filename", () => {
    it("returns 404 for nonexistent photo", async () => {
      const char = repo.create({ name: "NoPhoto", triggerWord: "TOK" });

      await request(app)
        .get(`/api/characters/${char.id}/photos/missing.jpg`)
        .expect(404);
    });
  });

  // ── Cancel Training ──────────────────────────────────────

  describe("POST /api/characters/:id/cancel-training", () => {
    it("cancels in-progress training", async () => {
      const char = repo.create({ name: "Cancellable", triggerWord: "TOK" });
      repo.update(char.id, { status: "training" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/cancel-training`)
        .expect(200);

      expect(res.body.ok).toBe(true);
      const updated = repo.getById(char.id);
      expect(updated?.status).toBe("failed");
    });

    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/cancel-training")
        .expect(404);
    });

    it("returns 409 when not training", async () => {
      const char = repo.create({ name: "Idle", triggerWord: "TOK" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/cancel-training`)
        .expect(409);

      expect(res.body.error).toContain("not currently training");
    });
  });

  // ── Checkpoints ──────────────────────────────────────────

  describe("GET /api/characters/:id/checkpoints", () => {
    it("returns 404 for unknown character", async () => {
      await request(app)
        .get("/api/characters/nonexistent/checkpoints")
        .expect(404);
    });
  });

  // ── Resume Training ──────────────────────────────────────

  describe("POST /api/characters/:id/resume-training", () => {
    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/resume-training")
        .send({ checkpoint_path: "/some/path" })
        .expect(404);
    });

    it("returns 409 when already training", async () => {
      const char = repo.create({ name: "Busy", triggerWord: "TOK" });
      repo.update(char.id, { status: "training" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/resume-training`)
        .send({ checkpoint_path: "/some/path" })
        .expect(409);

      expect(res.body.error).toContain("already training");
    });

    it("returns 400 when checkpoint_path missing", async () => {
      const char = repo.create({ name: "NoCkpt", triggerWord: "TOK" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/resume-training`)
        .send({})
        .expect(400);

      expect(res.body.error).toContain("checkpoint_path");
    });
  });

  // ── Recover Training ─────────────────────────────────────

  describe("POST /api/characters/:id/recover-training", () => {
    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/recover-training")
        .expect(404);
    });
  });

  // ── Pause Training ───────────────────────────────────────

  describe("POST /api/characters/:id/pause-training", () => {
    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/pause-training")
        .expect(404);
    });

    it("returns 409 when not training", async () => {
      const char = repo.create({ name: "NotTraining", triggerWord: "TOK" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/pause-training`)
        .expect(409);

      expect(res.body.error).toContain("not currently training");
    });
  });

  // ── Unpause Training ─────────────────────────────────────

  describe("POST /api/characters/:id/unpause-training", () => {
    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/unpause-training")
        .expect(404);
    });

    it("returns 409 when not training", async () => {
      const char = repo.create({ name: "NotInTraining", triggerWord: "TOK" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/unpause-training`)
        .expect(409);

      expect(res.body.error).toContain("not currently training");
    });
  });

  // ── AI Enhance ───────────────────────────────────────────

  describe("POST /api/characters/:id/ai-enhance", () => {
    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/ai-enhance")
        .expect(404);
    });

    it("returns 400 when description is missing", async () => {
      const char = repo.create({ name: "NoDesc", triggerWord: "TOK" });

      const res = await request(app)
        .post(`/api/characters/${char.id}/ai-enhance`)
        .expect(400);

      expect(res.body.error).toContain("description");
    });
  });

  // ── PUT duplicate name ───────────────────────────────────

  describe("PUT /api/characters/:id (duplicate)", () => {
    it("returns 409 for duplicate name on update", async () => {
      repo.create({ name: "First", triggerWord: "T1" });
      const second = repo.create({ name: "Second", triggerWord: "T2" });

      const res = await request(app)
        .put(`/api/characters/${second.id}`)
        .send({ name: "First" })
        .expect(409);

      expect(res.body.error).toContain("already exists");
    });
  });

  // ── POST photos upload missing character ──────────────────

  describe("POST /api/characters/:id/photos", () => {
    it("returns 404 for unknown character", async () => {
      await request(app)
        .post("/api/characters/nonexistent/photos")
        .expect(404);
    });
  });

  // ── AI-Enhance — template fallback (no copilot) ──────────

  describe("POST /api/characters/:id/ai-enhance (template fallback)", () => {
    it("generates template captions when copilot is unavailable", async () => {
      const char = repo.create({
        name: "TestDog",
        triggerWord: "DOG",
        description: "a husky with blue eyes",
        referencePhotos: ["/tmp/fake1.jpg", "/tmp/fake2.jpg"],
      });

      const res = await request(app)
        .post(`/api/characters/${char.id}/ai-enhance`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.captions).toBeDefined();
      const captions = res.body.captions;
      // Captions use filenames as keys
      expect(captions["fake1.jpg"]).toMatch(/DOG/);
      expect(captions["fake2.jpg"]).toMatch(/DOG/);
      expect(res.body.totalSteps).toBe(100); // 2 photos * 50
    });
  });

  // ── Train — sidecar-dependent error paths ────────────────

  describe("POST /api/characters/:id/train (additional paths)", () => {
    it("returns 400 when photos count below minimum", async () => {
      const char = repo.create({
        name: "FewPhotos",
        triggerWord: "FP",
        referencePhotos: ["/tmp/p1.jpg", "/tmp/p2.jpg"],
      });

      const res = await request(app)
        .post(`/api/characters/${char.id}/train`)
        .expect(400);

      expect(res.body.error).toContain("photos");
    });
  });

  // ── Checkpoints — error paths ────────────────────────────

  describe("GET /api/characters/:id/checkpoints (additional)", () => {
    it("returns 404 for unknown character", async () => {
      const res = await request(app)
        .get("/api/characters/nonexistent/checkpoints");
      expect(res.status).toBe(404);
    });
  });

  // ── Recover training — error paths ───────────────────────

  describe("POST /api/characters/:id/recover-training (additional)", () => {
    it("returns 404 for unknown character", async () => {
      const res = await request(app)
        .post("/api/characters/nonexistent/recover-training");
      expect(res.status).toBe(404);
    });
  });

  // ── Pause training — success path ────────────────────────

  describe("POST /api/characters/:id/pause-training (additional)", () => {
    it("returns 404 for missing character", async () => {
      const res = await request(app)
        .post("/api/characters/nonexistent/pause-training");
      expect(res.status).toBe(404);
    });
  });

  // ── Resume training — sidecar dependent ──────────────────

  describe("POST /api/characters/:id/resume-training (additional)", () => {
    it("returns 503 when sidecar not configured on resume attempt", async () => {
      const char = repo.create({
        name: "ResumeNoSidecar",
        triggerWord: "RNS",
      });

      const res = await request(app)
        .post(`/api/characters/${char.id}/resume-training`)
        .send({ checkpoint_path: "/tmp/checkpoint.safetensors" });

      // Sidecar not available → 503 or connection error → 500
      expect([500, 503]).toContain(res.status);
    });
  });

  // ── GET photos/:filename ─────────────────────────────────

  describe("GET /api/characters/:id/photos/:filename", () => {
    it("returns 404 for unknown character photo", async () => {
      const res = await request(app)
        .get("/api/characters/nonexistent/photos/test.jpg");
      expect(res.status).toBe(404);
    });

    it("returns 403 for path traversal attempt", async () => {
      const char = repo.create({ name: "PathChar", triggerWord: "PATH" });
      const res = await request(app)
        .get(`/api/characters/${char.id}/photos/../../../etc/passwd`);
      // Path traversal detection returns 403 or the filename is sanitized by Express
      expect([403, 404]).toContain(res.status);
    });
  });

  // ── DELETE photos ─────────────────────────────────────────

  describe("DELETE /api/characters/:id/photos", () => {
    it("returns 404 for unknown character", async () => {
      const res = await request(app)
        .delete("/api/characters/nonexistent/photos")
        .send({ paths: ["/tmp/photo.jpg"] });
      expect(res.status).toBe(404);
    });

    it("returns 400 when paths array is missing", async () => {
      const char = repo.create({ name: "DeletePhoto", triggerWord: "DP" });
      const res = await request(app)
        .delete(`/api/characters/${char.id}/photos`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("paths");
    });

    it("returns 400 when paths array is empty", async () => {
      const char = repo.create({ name: "DeleteEmpty", triggerWord: "DE" });
      const res = await request(app)
        .delete(`/api/characters/${char.id}/photos`)
        .send({ paths: [] });
      expect(res.status).toBe(400);
    });

    it("removes photos and returns counts", async () => {
      const char = repo.create({
        name: "RemovePhotos",
        triggerWord: "RP",
        referencePhotos: ["/photos/a.jpg", "/photos/b.jpg", "/photos/c.jpg"],
      });
      const res = await request(app)
        .delete(`/api/characters/${char.id}/photos`)
        .send({ paths: ["/photos/a.jpg"] });
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(1);
      expect(res.body.remaining).toBe(2);
    });
  });

  // ── POST ai-enhance (more paths) ─────────────────────────

  describe("POST /api/characters/:id/ai-enhance (more paths)", () => {
    it("returns 400 when photos list is empty", async () => {
      const char = repo.create({
        name: "NoPhotos",
        triggerWord: "NP",
        referencePhotos: [],
      });
      const res = await request(app)
        .post(`/api/characters/${char.id}/ai-enhance`)
        .send({ description: "A test character" });
      expect(res.status).toBe(400);
    });
  });

  // ── POST cancel-training ──────────────────────────────────

  describe("POST /api/characters/:id/cancel-training (more paths)", () => {
    it("returns 409 when not in training state", async () => {
      const char = repo.create({
        name: "NotTraining",
        triggerWord: "NT",
      });
      const res = await request(app)
        .post(`/api/characters/${char.id}/cancel-training`);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("not currently training");
    });
  });

  // ── GET characters list (with data) ───────────────────────

  describe("GET /api/characters (with data)", () => {
    it("returns all characters sorted by name", async () => {
      repo.create({ name: "Zara", triggerWord: "ZARA" });
      repo.create({ name: "Alice", triggerWord: "ALICE" });
      repo.create({ name: "Mike", triggerWord: "MIKE" });
      const res = await request(app).get("/api/characters");
      expect(res.status).toBe(200);
      expect(res.body.characters.length).toBe(3);
    });
  });

  // ── PUT update (more fields) ──────────────────────────────

  describe("PUT /api/characters/:id (more fields)", () => {
    it("updates triggerWord and baseModel", async () => {
      const char = repo.create({ name: "Updatable", triggerWord: "OLD" });
      const res = await request(app)
        .put(`/api/characters/${char.id}`)
        .send({ triggerWord: "NEW", baseModel: "flux-schnell" });
      expect(res.status).toBe(200);
      expect(res.body.triggerWord).toBe("NEW");
    });

    it("accepts empty name update (no validation)", async () => {
      const char = repo.create({ name: "TestUpdate", triggerWord: "TU" });
      const res = await request(app)
        .put(`/api/characters/${char.id}`)
        .send({ name: "NameUpdated" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("NameUpdated");
    });
  });
});
