import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BrandKitRepository } from "./brand-kit.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("BrandKitRepository", () => {
  let db: Database.Database;
  let repo: BrandKitRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new BrandKitRepository(db);
    repo.migrate();
  });

  const sampleKit = {
    id: "kit-1",
    name: "My Brand",
    primaryColor: "#ff0000",
    secondaryColor: "#00ff00",
    accentColor: "#0000ff",
    fontFamily: "Roboto",
    logoPath: "/logos/mylogo.png",
    watermarkPath: null,
    introTemplateId: "tmpl-1",
    outroTemplateId: null,
  };

  // ── create ──────────────────────────────────────────────

  describe("create", () => {
    it("creates a brand kit and returns it with timestamps", () => {
      const result = repo.create(sampleKit);
      expect(result.id).toBe("kit-1");
      expect(result.name).toBe("My Brand");
      expect(result.primaryColor).toBe("#ff0000");
      expect(result.createdAt).toBeTruthy();
      expect(result.updatedAt).toBeTruthy();
    });

    it("rejects duplicate names", () => {
      repo.create(sampleKit);
      expect(() => repo.create({ ...sampleKit, id: "kit-2" })).toThrow();
    });
  });

  // ── getById ─────────────────────────────────────────────

  describe("getById", () => {
    it("returns the kit by id", () => {
      repo.create(sampleKit);
      const found = repo.getById("kit-1");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("My Brand");
      expect(found!.fontFamily).toBe("Roboto");
    });

    it("returns null for non-existent id", () => {
      expect(repo.getById("missing")).toBeNull();
    });
  });

  // ── getAll ──────────────────────────────────────────────

  describe("getAll", () => {
    it("returns empty array when no kits", () => {
      expect(repo.getAll()).toEqual([]);
    });

    it("returns all kits ordered by name", () => {
      repo.create({ ...sampleKit, id: "k2", name: "Zebra" });
      repo.create({ ...sampleKit, id: "k1", name: "Alpha" });
      const all = repo.getAll();
      expect(all).toHaveLength(2);
      expect(all[0].name).toBe("Alpha");
      expect(all[1].name).toBe("Zebra");
    });
  });

  // ── update ──────────────────────────────────────────────

  describe("update", () => {
    it("updates specified fields", () => {
      repo.create(sampleKit);
      const updated = repo.update("kit-1", { primaryColor: "#111111", fontFamily: "Arial" });
      expect(updated).not.toBeNull();
      expect(updated!.primaryColor).toBe("#111111");
      expect(updated!.fontFamily).toBe("Arial");
      expect(updated!.secondaryColor).toBe("#00ff00"); // unchanged
    });

    it("returns null for non-existent id", () => {
      expect(repo.update("missing", { name: "x" })).toBeNull();
    });

    it("allows setting nullable fields to null", () => {
      repo.create(sampleKit);
      const updated = repo.update("kit-1", { logoPath: null });
      expect(updated!.logoPath).toBeNull();
    });
  });

  // ── delete ──────────────────────────────────────────────

  describe("delete", () => {
    it("deletes an existing kit", () => {
      repo.create(sampleKit);
      expect(repo.delete("kit-1")).toBe(true);
      expect(repo.getById("kit-1")).toBeNull();
    });

    it("returns false for non-existent id", () => {
      expect(repo.delete("missing")).toBe(false);
    });
  });

  // ── migrate idempotency ────────────────────────────────

  describe("migrate", () => {
    it("is idempotent (CREATE TABLE + ALTER TABLE)", () => {
      // Sub-issue #955: extra ALTER TABLE statements added font_heading,
      // font_body, footer_text. Calling migrate() repeatedly must not throw.
      repo.migrate();
      repo.migrate();
      repo.migrate();
      repo.create(sampleKit);
      expect(repo.getById("kit-1")).not.toBeNull();
    });
  });

  // ── Pitch Brand Kit fields (issue #955) ────────────────

  describe("Pitch Brand Kit columns (font_heading, font_body, footer_text)", () => {
    it("defaults the three new fields to null when omitted on create", () => {
      const created = repo.create(sampleKit);
      expect(created.fontHeading).toBeNull();
      expect(created.fontBody).toBeNull();
      expect(created.footerText).toBeNull();
      const fetched = repo.getById("kit-1")!;
      expect(fetched.fontHeading).toBeNull();
      expect(fetched.fontBody).toBeNull();
      expect(fetched.footerText).toBeNull();
    });

    it("persists new fields on create round-trip", () => {
      repo.create({
        ...sampleKit,
        fontHeading: "Space Grotesk",
        fontBody: "IBM Plex Sans",
        footerText: "© 2026 Acme Corp",
      });
      const fetched = repo.getById("kit-1")!;
      expect(fetched.fontHeading).toBe("Space Grotesk");
      expect(fetched.fontBody).toBe("IBM Plex Sans");
      expect(fetched.footerText).toBe("© 2026 Acme Corp");
    });

    it("update can set new fields without disturbing existing values", () => {
      repo.create(sampleKit);
      const updated = repo.update("kit-1", {
        fontHeading: "Inter",
        fontBody: "Inter",
      })!;
      expect(updated.fontHeading).toBe("Inter");
      expect(updated.fontBody).toBe("Inter");
      expect(updated.fontFamily).toBe("Roboto"); // legacy field untouched
      expect(updated.primaryColor).toBe("#ff0000");
    });

    it("update can clear new fields back to null", () => {
      repo.create({ ...sampleKit, fontHeading: "X", fontBody: "Y", footerText: "Z" });
      const cleared = repo.update("kit-1", {
        fontHeading: null,
        fontBody: null,
        footerText: null,
      })!;
      expect(cleared.fontHeading).toBeNull();
      expect(cleared.fontBody).toBeNull();
      expect(cleared.footerText).toBeNull();
    });

    it("does not break legacy callers that omit the new fields entirely", () => {
      // The original sampleKit shape (pre-#955) — must still create + read OK.
      repo.create(sampleKit);
      const updated = repo.update("kit-1", { name: "Renamed" })!;
      expect(updated.name).toBe("Renamed");
      expect(updated.fontHeading).toBeNull();
    });
  });

  // ── Sub-issue #1047 columns ────────────────────────────

  describe("Pitch Brand Kit columns (default_logo_placement, show_slide_numbers) — #1047", () => {
    it("defaults to null when omitted on create", () => {
      const created = repo.create(sampleKit);
      expect(created.defaultLogoPlacement).toBeNull();
      expect(created.showSlideNumbers).toBeNull();
      const fetched = repo.getById("kit-1")!;
      expect(fetched.defaultLogoPlacement).toBeNull();
      expect(fetched.showSlideNumbers).toBeNull();
    });

    it("persists new fields on create round-trip", () => {
      repo.create({
        ...sampleKit,
        defaultLogoPlacement: "top-right",
        showSlideNumbers: true,
      });
      const fetched = repo.getById("kit-1")!;
      expect(fetched.defaultLogoPlacement).toBe("top-right");
      expect(fetched.showSlideNumbers).toBe(true);
    });

    it("normalizes invalid placement strings on read to null", () => {
      repo.create(sampleKit);
      // Force a bad value via raw SQL (simulates legacy/corrupt rows).
      db.prepare(
        `UPDATE brand_kits SET default_logo_placement = 'middle-of-the-road' WHERE id = 'kit-1'`,
      ).run();
      const fetched = repo.getById("kit-1")!;
      expect(fetched.defaultLogoPlacement).toBeNull();
    });

    it("update can set and later clear both fields", () => {
      repo.create(sampleKit);
      const set = repo.update("kit-1", {
        defaultLogoPlacement: "bottom-left",
        showSlideNumbers: true,
      })!;
      expect(set.defaultLogoPlacement).toBe("bottom-left");
      expect(set.showSlideNumbers).toBe(true);

      const cleared = repo.update("kit-1", {
        defaultLogoPlacement: null,
        showSlideNumbers: null,
      })!;
      expect(cleared.defaultLogoPlacement).toBeNull();
      expect(cleared.showSlideNumbers).toBeNull();
    });

    it("ALTER TABLE migration is idempotent", () => {
      repo.migrate();
      repo.migrate();
      repo.create({
        ...sampleKit,
        defaultLogoPlacement: "none",
        showSlideNumbers: false,
      });
      const fetched = repo.getById("kit-1")!;
      expect(fetched.defaultLogoPlacement).toBe("none");
      expect(fetched.showSlideNumbers).toBe(false);
    });
  });
});
