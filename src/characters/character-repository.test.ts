import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { CharacterRepository } from "./character-repository.js";

describe("CharacterRepository", () => {
  let db: Database.Database;
  let repo: CharacterRepository;
  const frozenNow = new Date("2026-03-03T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    repo = new CharacterRepository(db, () => frozenNow);
    repo.migrate();
  });

  it("should create a character with default values", () => {
    const char = repo.create({ name: "Ziggy", triggerWord: "sks dog" });
    expect(char.id).toBeTruthy();
    expect(char.name).toBe("Ziggy");
    expect(char.triggerWord).toBe("sks dog");
    expect(char.referencePhotos).toEqual([]);
    expect(char.loraScale).toBe(0.8);
    expect(char.status).toBe("pending");
    expect(char.trainedLoraPath).toBeNull();
    expect(char.errorMessage).toBeNull();
    expect(char.createdAt).toBe("2026-03-03T12:00:00.000Z");
  });

  it("should create a character with reference photos", () => {
    const photos = ["/path/a.jpg", "/path/b.jpg"];
    const char = repo.create({ name: "Hero", triggerWord: "sks person", referencePhotos: photos });
    expect(char.referencePhotos).toEqual(photos);
  });

  it("should enforce unique name constraint", () => {
    repo.create({ name: "Unique", triggerWord: "sks cat" });
    expect(() => repo.create({ name: "Unique", triggerWord: "sks dog" })).toThrow();
  });

  it("should get by id", () => {
    const created = repo.create({ name: "Test", triggerWord: "sks test" });
    const found = repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Test");
  });

  it("should return null for unknown id", () => {
    expect(repo.getById("nonexistent")).toBeNull();
  });

  it("should get all characters ordered by created_at DESC", () => {
    repo.create({ name: "A", triggerWord: "sks a" });
    repo.create({ name: "B", triggerWord: "sks b" });
    const all = repo.getAll();
    expect(all).toHaveLength(2);
  });

  it("should filter by status", () => {
    const char = repo.create({ name: "Trainable", triggerWord: "sks char" });
    repo.update(char.id, { status: "ready", trainedLoraPath: "/path/lora.safetensors" });
    const ready = repo.getByStatus("ready");
    expect(ready).toHaveLength(1);
    expect(ready[0].name).toBe("Trainable");
    const pending = repo.getByStatus("pending");
    expect(pending).toHaveLength(0);
  });

  it("should update character fields", () => {
    const char = repo.create({ name: "Updatable", triggerWord: "sks up" });
    const updated = repo.update(char.id, {
      name: "Updated",
      status: "training",
      loraScale: 0.5,
    });
    expect(updated!.name).toBe("Updated");
    expect(updated!.status).toBe("training");
    expect(updated!.loraScale).toBe(0.5);
  });

  it("should update to ready with lora path", () => {
    const char = repo.create({ name: "Trained", triggerWord: "sks tr" });
    repo.update(char.id, {
      status: "ready",
      trainedLoraPath: "/models/loras/trained.safetensors",
    });
    const result = repo.getById(char.id)!;
    expect(result.status).toBe("ready");
    expect(result.trainedLoraPath).toBe("/models/loras/trained.safetensors");
  });

  it("should update to failed with error message", () => {
    const char = repo.create({ name: "Failing", triggerWord: "sks f" });
    repo.update(char.id, { status: "failed", errorMessage: "Out of memory" });
    const result = repo.getById(char.id)!;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("Out of memory");
  });

  it("should return null when updating nonexistent id", () => {
    expect(repo.update("fake", { name: "Nope" })).toBeNull();
  });

  it("should delete a character", () => {
    const char = repo.create({ name: "Deletable", triggerWord: "sks d" });
    expect(repo.delete(char.id)).toBe(true);
    expect(repo.getById(char.id)).toBeNull();
  });

  it("should return false when deleting nonexistent id", () => {
    expect(repo.delete("fake")).toBe(false);
  });

  it("should handle training config", () => {
    const config = { learning_rate: 1e-4, steps: 1000 };
    const char = repo.create({ name: "Configured", triggerWord: "sks cfg", trainingConfig: config });
    expect(char.trainingConfig).toEqual(config);
  });

  it("should be idempotent on migrate", () => {
    repo.migrate();
    repo.migrate();
    expect(repo.getAll()).toHaveLength(0);
  });

  // ── WS3-C (#932): base_model column ─────────────────────
  it("should default baseModel to null", () => {
    const char = repo.create({ name: "NoBase", triggerWord: "sks nb" });
    expect(char.baseModel).toBeNull();
  });

  it("should persist baseModel on create", () => {
    const char = repo.create({
      name: "WithBase",
      triggerWord: "sks wb",
      baseModel: "sdxl",
    });
    expect(char.baseModel).toBe("sdxl");
    expect(repo.getById(char.id)!.baseModel).toBe("sdxl");
  });

  it("should update baseModel via update()", () => {
    const char = repo.create({ name: "Updatable", triggerWord: "sks u" });
    const updated = repo.update(char.id, { baseModel: "flux-dev" });
    expect(updated!.baseModel).toBe("flux-dev");
    const cleared = repo.update(char.id, { baseModel: null });
    expect(cleared!.baseModel).toBeNull();
  });

  it("should not clobber baseModel on partial update", () => {
    const char = repo.create({
      name: "Sticky",
      triggerWord: "sks s",
      baseModel: "sdxl",
    });
    const updated = repo.update(char.id, { name: "Renamed" });
    expect(updated!.baseModel).toBe("sdxl");
  });
});
