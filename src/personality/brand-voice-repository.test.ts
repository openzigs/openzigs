import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BrandVoiceRepository } from "./brand-voice-repository.js";
import type { BrandVoiceRulebook } from "./brand-voice-repository.js";

const sampleRulebook: BrandVoiceRulebook = {
  tone: "authoritative but casual, slightly sarcastic",
  sentence_structure: "short punchy sentences, frequent em-dashes",
  vocabulary_level: "B2B professional, zero fluff",
  formatting_quirks: "heavy use of bullet points, bold for key terms",
  banned_words: ["delve", "tapestry", "unlock", "unleash", "dive in"],
};

describe("BrandVoiceRepository", () => {
  let db: Database.Database;
  let repo: BrandVoiceRepository;
  const clock = () => new Date("2026-02-28T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    repo = new BrandVoiceRepository(db, clock);
  });

  it("creates and retrieves a brand voice", () => {
    const voice = repo.create({
      name: "Corporate Voice",
      rulebook: sampleRulebook,
      samples: ["Sample text one", "Sample text two"],
    });

    expect(voice.id).toBeTruthy();
    expect(voice.name).toBe("Corporate Voice");
    expect(voice.rulebook).toEqual(sampleRulebook);
    expect(voice.active).toBe(false);
    expect(voice.samples).toEqual(["Sample text one", "Sample text two"]);
    expect(voice.createdAt).toBe("2026-02-28T12:00:00.000Z");

    const fetched = repo.getById(voice.id);
    expect(fetched).toEqual(voice);
  });

  it("enforces unique names", () => {
    repo.create({ name: "Voice A", rulebook: sampleRulebook, samples: [] });
    expect(() => repo.create({ name: "Voice A", rulebook: sampleRulebook, samples: [] })).toThrow();
  });

  it("lists all voices ordered by created_at DESC", () => {
    let t = 0;
    const tickingClock = () => new Date(`2026-02-28T12:0${t++}:00Z`);
    const timedRepo = new BrandVoiceRepository(db, tickingClock);
    timedRepo.create({ name: "First", rulebook: sampleRulebook, samples: [] });
    timedRepo.create({ name: "Second", rulebook: sampleRulebook, samples: [] });

    const all = timedRepo.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("Second");
    expect(all[1].name).toBe("First");
  });

  it("sets active voice (deactivating others)", () => {
    const v1 = repo.create({ name: "Voice 1", rulebook: sampleRulebook, samples: [], active: true });
    expect(v1.active).toBe(true);

    const v2 = repo.create({ name: "Voice 2", rulebook: sampleRulebook, samples: [], active: true });
    expect(v2.active).toBe(true);

    // v1 should have been deactivated
    const refreshedV1 = repo.getById(v1.id);
    expect(refreshedV1?.active).toBe(false);
  });

  it("getActive returns the active voice", () => {
    repo.create({ name: "Inactive", rulebook: sampleRulebook, samples: [] });
    const active = repo.create({ name: "Active", rulebook: sampleRulebook, samples: [], active: true });

    const result = repo.getActive();
    expect(result?.id).toBe(active.id);
  });

  it("getActive returns null when no active voice", () => {
    repo.create({ name: "Voice", rulebook: sampleRulebook, samples: [] });
    expect(repo.getActive()).toBeNull();
  });

  it("updates a brand voice", () => {
    const voice = repo.create({ name: "Original", rulebook: sampleRulebook, samples: [] });
    const updated = repo.update(voice.id, { name: "Renamed" });

    expect(updated?.name).toBe("Renamed");
    expect(updated?.rulebook).toEqual(sampleRulebook);
  });

  it("setActive activates one and deactivates others", () => {
    const v1 = repo.create({ name: "V1", rulebook: sampleRulebook, samples: [], active: true });
    const v2 = repo.create({ name: "V2", rulebook: sampleRulebook, samples: [] });

    repo.setActive(v2.id);

    expect(repo.getById(v1.id)?.active).toBe(false);
    expect(repo.getById(v2.id)?.active).toBe(true);
    expect(repo.getActive()?.id).toBe(v2.id);
  });

  it("deactivateAll clears all active flags", () => {
    repo.create({ name: "V1", rulebook: sampleRulebook, samples: [], active: true });
    repo.deactivateAll();
    expect(repo.getActive()).toBeNull();
  });

  it("deletes a brand voice", () => {
    const voice = repo.create({ name: "Temp", rulebook: sampleRulebook, samples: [] });
    expect(repo.delete(voice.id)).toBe(true);
    expect(repo.getById(voice.id)).toBeNull();
  });

  it("delete returns false for non-existent id", () => {
    expect(repo.delete("non-existent")).toBe(false);
  });

  it("update returns null for non-existent id", () => {
    expect(repo.update("non-existent", { name: "Nope" })).toBeNull();
  });
});
