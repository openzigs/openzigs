/**
 * Character API — Unit tests for CRUD + training endpoints.
 * Issue #377: Backend Training Service.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { CharacterRepository } from "../characters/character-repository.js";
import { createCharacterRouter } from "./characters.js";

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
});
