import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  SetupStateRepository,
  DEFAULT_WIZARD_STATE,
} from "./setup-state-repository.js";

describe("SetupStateRepository", () => {
  let db: Database.Database;
  let repo: SetupStateRepository;
  const now = new Date("2026-02-09T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    repo = new SetupStateRepository(db, () => now);
    repo.migrate();
  });

  it("returns DEFAULT_WIZARD_STATE before any save", () => {
    const state = repo.get();
    expect(state.currentStep).toBe(DEFAULT_WIZARD_STATE.currentStep);
    expect(state.completedSteps).toEqual([]);
    expect(state.data).toEqual({});
  });

  it("persists currentStep and updatedAt", () => {
    const saved = repo.save({ currentStep: "sidecars" });
    expect(saved.currentStep).toBe("sidecars");
    expect(saved.updatedAt).toBe(now.toISOString());
    expect(repo.get().currentStep).toBe("sidecars");
  });

  it("merges data on partial updates", () => {
    repo.save({ data: { a: 1 } });
    repo.save({ data: { b: 2 } });
    expect(repo.get().data).toEqual({ a: 1, b: 2 });
  });

  it("preserves completedSteps when not provided", () => {
    repo.save({ completedSteps: ["welcome", "prereqs"] });
    repo.save({ currentStep: "social" });
    expect(repo.get().completedSteps).toEqual(["welcome", "prereqs"]);
    expect(repo.get().currentStep).toBe("social");
  });

  it("upserts the single row (does not create duplicates)", () => {
    repo.save({ currentStep: "byok" });
    repo.save({ currentStep: "recipes" });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM wizard_state").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("reset() removes the row and returns defaults afterward", () => {
    repo.save({ currentStep: "complete" });
    repo.reset();
    expect(repo.get().currentStep).toBe(DEFAULT_WIZARD_STATE.currentStep);
  });

  it("survives a second migrate() call (idempotent)", () => {
    repo.save({ currentStep: "byok" });
    repo.migrate();
    expect(repo.get().currentStep).toBe("byok");
  });
});
