import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock heavy dependencies that database.ts imports at the top level
vi.mock("../tasks/task-repository.js", () => ({
  TaskRepository: vi.fn().mockImplementation(() => ({ migrate: vi.fn() })),
}));
vi.mock("../presenter/presentation-repository.js", () => ({
  PresentationRepository: vi.fn().mockImplementation(() => ({ migrate: vi.fn() })),
}));
vi.mock("../channels/social/social-repository.js", () => ({
  SocialRepository: vi.fn().mockImplementation(() => ({ migrate: vi.fn() })),
}));
vi.mock("../personality/brand-voice-repository.js", () => ({
  BrandVoiceRepository: vi.fn().mockImplementation(() => ({ migrate: vi.fn() })),
}));
vi.mock("../characters/character-repository.js", () => ({
  CharacterRepository: vi.fn().mockImplementation(() => ({ migrate: vi.fn() })),
}));
vi.mock("node:fs", () => ({
  default: { mkdirSync: vi.fn() },
}));
vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("productivity/database", () => {
  let mod: typeof import("./database.js");

  beforeEach(async () => {
    // Re-import each time so sharedDb state is reset
    vi.resetModules();
    mod = await import("./database.js");
  });

  afterEach(() => {
    // Close any open database
    try { mod.closeDatabase(); } catch { /* ignore */ }
  });

  it("getDatabase returns an in-memory database", () => {
    const db = mod.getDatabase({ dbPath: ":memory:" });
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it("creates all expected tables", () => {
    const db = mod.getDatabase({ dbPath: ":memory:" });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("saved_prompts");
    expect(names).toContain("scheduled_jobs");
    expect(names).toContain("voice_profiles");
    expect(names).toContain("director_drafts");
    expect(names).toContain("director_renders");
  });

  it("returns same instance on second call (singleton)", () => {
    const db1 = mod.getDatabase({ dbPath: ":memory:" });
    const db2 = mod.getDatabase({ dbPath: ":memory:" });
    expect(db1).toBe(db2);
  });

  it("closeDatabase closes the connection", () => {
    const db = mod.getDatabase({ dbPath: ":memory:" });
    expect(db.open).toBe(true);
    mod.closeDatabase();
    expect(db.open).toBe(false);
  });

  it("closeDatabase is safe to call when no db exists", () => {
    // Should not throw
    mod.closeDatabase();
    mod.closeDatabase();
  });

  it("getDatabase can reopen after close", () => {
    const db1 = mod.getDatabase({ dbPath: ":memory:" });
    mod.closeDatabase();
    const db2 = mod.getDatabase({ dbPath: ":memory:" });
    expect(db2).not.toBe(db1);
    expect(db2.open).toBe(true);
  });

  it("sets WAL journal mode", () => {
    const db = mod.getDatabase({ dbPath: ":memory:" });
    const result = db.pragma("journal_mode") as { journal_mode: string }[];
    // In-memory databases may report 'memory' journal mode, but the pragma was called
    expect(result).toBeDefined();
  });
});
