import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BrandKitRepository } from "../video/brand-kit.js";
import {
  STARTER_BRAND_KITS,
  seedStarterBrandKits,
} from "./starter-brand-kits.js";

function createRepo(): { db: Database.Database; repo: BrandKitRepository } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new BrandKitRepository(db);
  repo.migrate();
  return { db, repo };
}

describe("STARTER_BRAND_KITS catalog", () => {
  it("contains 6–8 kits with unique starter-* ids", () => {
    expect(STARTER_BRAND_KITS.length).toBeGreaterThanOrEqual(6);
    expect(STARTER_BRAND_KITS.length).toBeLessThanOrEqual(8);
    const ids = STARTER_BRAND_KITS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^starter-/);
    }
  });

  it("every kit has heading + body fonts and valid hex colors", () => {
    for (const kit of STARTER_BRAND_KITS) {
      expect(kit.fontHeading).toBeTruthy();
      expect(kit.fontBody).toBeTruthy();
      expect(kit.primaryColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(kit.secondaryColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(kit.accentColor).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("every kit has a unique display name", () => {
    const names = STARTER_BRAND_KITS.map((k) => k.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("seedStarterBrandKits", () => {
  let repo: BrandKitRepository;

  beforeEach(() => {
    repo = createRepo().repo;
  });

  it("inserts every starter kit on a fresh DB", () => {
    const result = seedStarterBrandKits(repo);
    expect(result.inserted).toHaveLength(STARTER_BRAND_KITS.length);
    expect(result.skipped).toEqual([]);
    expect(repo.getAll()).toHaveLength(STARTER_BRAND_KITS.length);
  });

  it("is idempotent — second run skips all kits, no duplicates", () => {
    seedStarterBrandKits(repo);
    const second = seedStarterBrandKits(repo);
    expect(second.inserted).toEqual([]);
    expect(second.skipped).toHaveLength(STARTER_BRAND_KITS.length);
    expect(repo.getAll()).toHaveLength(STARTER_BRAND_KITS.length);
  });

  it("preserves user edits to a starter kit on re-seed", () => {
    seedStarterBrandKits(repo);
    repo.update("starter-modern-minimal", { primaryColor: "#abcdef" });
    seedStarterBrandKits(repo);
    expect(repo.getById("starter-modern-minimal")!.primaryColor).toBe(
      "#abcdef",
    );
  });

  it("only inserts kits missing from the DB (partial seed)", () => {
    // Pre-insert one of the starters by hand so the seed has to skip it.
    const kit = STARTER_BRAND_KITS[0];
    repo.create(kit);
    const result = seedStarterBrandKits(repo);
    expect(result.skipped).toContain(kit.id);
    expect(result.inserted).toHaveLength(STARTER_BRAND_KITS.length - 1);
  });
});
