import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PersonalityManager, DEFAULT_PERSONALITY } from "./personality-manager.js";

const createTestDb = (): Database.Database => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

describe("PersonalityManager", () => {
  let db: Database.Database;
  let manager: PersonalityManager;
  const clock = () => new Date("2026-02-08T12:00:00Z");

  beforeEach(() => {
    db = createTestDb();
    manager = new PersonalityManager({ db, clock });
  });

  it("returns the default personality on first access", () => {
    const config = manager.getConfig();
    expect(config.systemInstruction).toBe(DEFAULT_PERSONALITY.systemInstruction);
    expect(config.prePrompt).toBe(DEFAULT_PERSONALITY.prePrompt);
    expect(config.postPrompt).toBe("");
    expect(config.enabled).toBe(true);
  });

  it("updates a subset of fields while preserving others", () => {
    manager.update({ systemInstruction: "Be terse." });
    const config = manager.getConfig();
    expect(config.systemInstruction).toBe("Be terse.");
    expect(config.prePrompt).toBe(DEFAULT_PERSONALITY.prePrompt);
    expect(config.enabled).toBe(true);
  });

  it("toggles enabled state", () => {
    manager.update({ enabled: false });
    expect(manager.getConfig().enabled).toBe(false);

    manager.update({ enabled: true });
    expect(manager.getConfig().enabled).toBe(true);
  });

  it("updates all fields at once", () => {
    manager.update({
      systemInstruction: "Custom system",
      prePrompt: "Custom pre",
      postPrompt: "Custom post",
      enabled: false,
    });

    const config = manager.getConfig();
    expect(config.systemInstruction).toBe("Custom system");
    expect(config.prePrompt).toBe("Custom pre");
    expect(config.postPrompt).toBe("Custom post");
    expect(config.enabled).toBe(false);
  });

  it("resets to defaults", () => {
    manager.update({
      systemInstruction: "something else",
      prePrompt: "override",
      postPrompt: "also changed",
      enabled: false,
    });

    const config = manager.reset();
    expect(config.systemInstruction).toBe(DEFAULT_PERSONALITY.systemInstruction);
    expect(config.prePrompt).toBe(DEFAULT_PERSONALITY.prePrompt);
    expect(config.postPrompt).toBe("");
    expect(config.enabled).toBe(true);
  });

  it("persists across multiple PersonalityManager instances on the same db", () => {
    manager.update({ systemInstruction: "Persistent!" });

    const manager2 = new PersonalityManager({ db, clock });
    expect(manager2.getConfig().systemInstruction).toBe("Persistent!");
  });

  it("sets updatedAt timestamp on update", () => {
    const customClock = () => new Date("2026-06-15T10:30:00Z");
    const m = new PersonalityManager({ db, clock: customClock });
    m.update({ prePrompt: "new" });
    expect(m.getConfig().updatedAt).toBe("2026-06-15T10:30:00.000Z");
  });
});
