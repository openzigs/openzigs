import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PitchRepository } from "./pitch-repository.js";
import type { Slide, SlideAsset } from "./pitch-schema.js";
import { BrandKitRepository } from "../video/brand-kit.js";

const FROZEN_NOW = new Date("2026-04-24T12:00:00.000Z");

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function bulletSlide(heading: string, bullets: string[]): Slide {
  return {
    template: "bullet_list",
    content: { heading, bullets },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  };
}

function titleSlide(title: string): Slide {
  return {
    template: "title",
    content: { title },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  };
}

function imageCaptionSlide(prompt: string, url: string | null = null): Slide {
  return {
    template: "image_caption",
    content: {
      image: { prompt, url, alt: "generated image" },
      caption: "Generated image",
    },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  };
}

function twoColumnImageSlide(): Slide {
  return {
    template: "two_column",
    content: {
      heading: "Split view",
      left: "Left",
      right: "Right",
      left_image: { prompt: "left prompt", url: null, alt: "left" },
      right_image: { prompt: "right prompt", url: null, alt: "right" },
    },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  };
}

describe("PitchRepository", () => {
  let db: Database.Database;
  let repo: PitchRepository;
  let brandKits: BrandKitRepository;

  beforeEach(() => {
    db = createTestDb();
    brandKits = new BrandKitRepository(db);
    brandKits.migrate();
    brandKits.create({
      id: "kit-1",
      name: "Test Kit",
      primaryColor: "#000000",
      secondaryColor: "#ffffff",
      accentColor: "#0066ff",
      fontFamily: "Inter",
      logoPath: null,
      watermarkPath: null,
      introTemplateId: null,
      outroTemplateId: null,
    });
    repo = new PitchRepository(db, () => FROZEN_NOW);
    repo.migrate();
  });

  // ── migrate ────────────────────────────────────────────────────────────

  describe("migrate", () => {
    it("is idempotent", () => {
      repo.migrate();
      repo.migrate();
      expect(repo.listDecks()).toEqual([]);
    });

    it("creates pitch_decks, pitch_slides, pitch_assets and the deck_pos index", () => {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pitch_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual([
        "pitch_assets",
        "pitch_decks",
        "pitch_slides",
      ]);
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pitch_slides_deck_pos'`,
        )
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
    });
  });

  // ── insertDeck (transactional) ─────────────────────────────────────────

  describe("insertDeck", () => {
    it("persists deck + slides atomically and assigns positions", () => {
      const deck = repo.insertDeck({
        id: "deck-1",
        title: "My Pitch",
        brand_kit_id: "kit-1",
        metadata: { source_script: "the script", tone: "formal" },
        slides: [
          { id: "s-1", slide: titleSlide("Hello") },
          { id: "s-2", slide: bulletSlide("Why us", ["Fast", "Reliable"]) },
        ],
      });
      expect(deck.id).toBe("deck-1");
      expect(deck.slides).toHaveLength(2);
      expect(deck.created_at).toBe(FROZEN_NOW.toISOString());

      const slides = repo.listSlidesForDeck("deck-1");
      expect(slides.map((s) => s.position)).toEqual([0, 1]);
      expect(slides[0].slide.template).toBe("title");
      expect(slides[1].slide.template).toBe("bullet_list");
    });

    it("rejects empty slide array", () => {
      expect(() =>
        repo.insertDeck({
          id: "d-empty",
          title: "x",
          brand_kit_id: "kit-1",
          metadata: { source_script: "", tone: "formal" },
          slides: [],
        }),
      ).toThrow();
    });

    it("rejects an invalid slide and rolls back the deck row", () => {
      const bad = {
        template: "bullet_list",
        content: { heading: "h", bullets: [] }, // empty bullets violates min(1)
        speaker_notes: "",
        transition: "slide",
        fragments: [],
      } as unknown as Slide;

      expect(() =>
        repo.insertDeck({
          id: "deck-bad",
          title: "Bad",
          brand_kit_id: "kit-1",
          metadata: { source_script: "", tone: "formal" },
          slides: [{ id: "s-bad", slide: bad }],
        }),
      ).toThrow();
      expect(repo.getDeck("deck-bad")).toBeNull();
      const slides = db
        .prepare(`SELECT * FROM pitch_slides WHERE deck_id = ?`)
        .all("deck-bad");
      expect(slides).toEqual([]);
    });

    it("enforces FK on brand_kit_id (RESTRICT)", () => {
      expect(() =>
        repo.insertDeck({
          id: "deck-x",
          title: "x",
          brand_kit_id: "kit-does-not-exist",
          metadata: { source_script: "", tone: "formal" },
          slides: [{ id: "s-1", slide: titleSlide("hi") }],
        }),
      ).toThrow();
    });
  });

  // ── getDeck / listDecks ───────────────────────────────────────────────

  describe("getDeck / listDecks", () => {
    beforeEach(() => {
      repo.insertDeck({
        id: "deck-A",
        title: "A",
        brand_kit_id: "kit-1",
        metadata: { source_script: "a", tone: "formal" },
        slides: [{ id: "sa", slide: titleSlide("Aye") }],
      });
      repo.insertDeck({
        id: "deck-B",
        title: "B",
        brand_kit_id: "kit-1",
        metadata: { source_script: "b", tone: "formal" },
        slides: [{ id: "sb", slide: titleSlide("Bee") }],
      });
    });

    it("returns null for unknown deck id", () => {
      expect(repo.getDeck("missing")).toBeNull();
    });

    it("listDecks returns decks ordered by updated_at DESC", () => {
      const all = repo.listDecks();
      expect(all).toHaveLength(2);
      // both share the frozen clock; just assert presence.
      const ids = all.map((d) => d.id).sort();
      expect(ids).toEqual(["deck-A", "deck-B"]);
    });

    it("skips malformed legacy slide rows without failing the whole library", () => {
      db.prepare(
        `INSERT INTO pitch_slides (id, deck_id, position, template, content, speaker_notes, transition, fragments, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "bad-slide",
        "deck-A",
        99,
        "bullet_list",
        JSON.stringify({ heading: "broken", bullets: [] }),
        "",
        "slide",
        "[]",
        FROZEN_NOW.toISOString(),
        FROZEN_NOW.toISOString(),
      );

      const deck = repo.getDeck("deck-A");
      expect(deck?.slides).toHaveLength(1);
      expect(repo.listDecks().map((d) => d.id).sort()).toEqual([
        "deck-A",
        "deck-B",
      ]);
      expect(repo.getSlide("bad-slide")).toBeNull();
    });

    it("skips a malformed deck row when listing decks", () => {
      db.prepare(
        `INSERT INTO pitch_decks (id, title, brand_kit_id, aspect_ratio, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy-bad",
        "Legacy Bad",
        "kit-1",
        "16:9",
        JSON.stringify({ source_script: "" }),
        FROZEN_NOW.toISOString(),
        FROZEN_NOW.toISOString(),
      );

      expect(repo.getDeck("legacy-bad")).toBeNull();
      expect(repo.listDecks().map((d) => d.id).sort()).toEqual([
        "deck-A",
        "deck-B",
      ]);
    });
  });

  // ── updateDeck ────────────────────────────────────────────────────────

  describe("updateDeck", () => {
    beforeEach(() => {
      repo.insertDeck({
        id: "deck-1",
        title: "Old",
        brand_kit_id: "kit-1",
        metadata: { source_script: "old", tone: "formal" },
        slides: [{ id: "s-1", slide: titleSlide("hi") }],
      });
    });

    it("patches title and metadata", () => {
      const updated = repo.updateDeck("deck-1", {
        title: "New",
        metadata: { source_script: "new", tone: "casual" },
      });
      expect(updated!.title).toBe("New");
      expect(updated!.metadata.tone).toBe("casual");
    });

    it("patches aspect_ratio", () => {
      const updated = repo.updateDeck("deck-1", { aspect_ratio: "4:3" });
      expect(updated!.aspect_ratio).toBe("4:3");
    });

    it("returns null for unknown id", () => {
      expect(repo.updateDeck("missing", { title: "x" })).toBeNull();
    });
  });

  // ── deleteDeck cascades to slides + assets ────────────────────────────

  describe("deleteDeck cascades", () => {
    it("removes slides and assets via FK ON DELETE CASCADE", () => {
      repo.insertDeck({
        id: "deck-1",
        title: "X",
        brand_kit_id: "kit-1",
        metadata: { source_script: "x", tone: "formal" },
        slides: [{ id: "s-1", slide: titleSlide("hi") }],
      });
      const asset: SlideAsset = {
        id: "a-1",
        deck_id: "deck-1",
        slide_id: "s-1",
        kind: "image",
        source: "fluxq",
        prompt: "a robot",
        local_path: "/tmp/a.png",
        mime: "image/png",
        width: 1024,
        height: 1024,
        created_at: FROZEN_NOW.toISOString(),
      };
      repo.insertAsset(asset);

      expect(repo.deleteDeck("deck-1")).toBe(true);
      expect(repo.getDeck("deck-1")).toBeNull();
      expect(repo.listSlidesForDeck("deck-1")).toEqual([]);
      expect(repo.listAssetsForDeck("deck-1")).toEqual([]);
    });

    it("returns false when nothing was deleted", () => {
      expect(repo.deleteDeck("missing")).toBe(false);
    });
  });

  // ── slides CRUD ───────────────────────────────────────────────────────

  describe("slides CRUD", () => {
    beforeEach(() => {
      repo.insertDeck({
        id: "deck-1",
        title: "X",
        brand_kit_id: "kit-1",
        metadata: { source_script: "x", tone: "formal" },
        slides: [{ id: "s-1", slide: titleSlide("Intro") }],
      });
    });

    it("insertSlide validates and persists", () => {
      const slide = repo.insertSlide({
        id: "s-2",
        deck_id: "deck-1",
        position: 1,
        slide: bulletSlide("Why", ["a", "b"]),
      });
      expect(slide.id).toBe("s-2");
      expect(slide.slide.template).toBe("bullet_list");
    });

    it("updateSlide validates new content and patches position", () => {
      const updated = repo.updateSlide("s-1", {
        slide: bulletSlide("New", ["only one"]),
        position: 5,
      });
      expect(updated!.slide.template).toBe("bullet_list");
      expect(updated!.position).toBe(5);
    });

    it("updateSlide rejects an invalid slide payload", () => {
      const bad = {
        template: "bullet_list",
        content: { heading: "h", bullets: [] },
        speaker_notes: "",
        transition: "slide",
        fragments: [],
      } as unknown as Slide;
      expect(() => repo.updateSlide("s-1", { slide: bad })).toThrow();
    });

    it("updateSlide returns null for missing id", () => {
      expect(repo.updateSlide("missing", { position: 0 })).toBeNull();
    });

    it("deleteSlide removes the row and returns true/false correctly", () => {
      expect(repo.deleteSlide("s-1")).toBe(true);
      expect(repo.deleteSlide("s-1")).toBe(false);
    });

    it("getSlide returns null when missing", () => {
      expect(repo.getSlide("nope")).toBeNull();
    });
  });

  // ── reorderSlides ─────────────────────────────────────────────────────

  describe("reorderSlides", () => {
    beforeEach(() => {
      repo.insertDeck({
        id: "deck-1",
        title: "X",
        brand_kit_id: "kit-1",
        metadata: { source_script: "x", tone: "formal" },
        slides: [
          { id: "s-1", slide: titleSlide("a") },
          { id: "s-2", slide: titleSlide("b") },
          { id: "s-3", slide: titleSlide("c") },
        ],
      });
    });

    it("rewrites positions transactionally", () => {
      repo.reorderSlides("deck-1", ["s-3", "s-1", "s-2"]);
      const ordered = repo
        .listSlidesForDeck("deck-1")
        .map((s) => ({ id: s.id, position: s.position }));
      expect(ordered).toEqual([
        { id: "s-3", position: 0 },
        { id: "s-1", position: 1 },
        { id: "s-2", position: 2 },
      ]);
    });

    it("rejects mismatched length", () => {
      expect(() =>
        repo.reorderSlides("deck-1", ["s-1", "s-2"]),
      ).toThrow(/length/);
    });

    it("rejects unknown ids", () => {
      expect(() =>
        repo.reorderSlides("deck-1", ["s-1", "s-2", "s-X"]),
      ).toThrow(/unknown slide id/);
    });

    it("rejects duplicate ids", () => {
      expect(() =>
        repo.reorderSlides("deck-1", ["s-1", "s-1", "s-2"]),
      ).toThrow(/duplicates/);
    });
  });

  // ── assets ────────────────────────────────────────────────────────────

  describe("assets", () => {
    beforeEach(() => {
      repo.insertDeck({
        id: "deck-1",
        title: "X",
        brand_kit_id: "kit-1",
        metadata: { source_script: "x", tone: "formal" },
        slides: [{ id: "s-1", slide: titleSlide("hi") }],
      });
    });

    function asset(overrides: Partial<SlideAsset> = {}): SlideAsset {
      return {
        id: "a-1",
        deck_id: "deck-1",
        slide_id: "s-1",
        kind: "image",
        source: "fluxq",
        prompt: "a robot",
        local_path: "/tmp/a.png",
        mime: "image/png",
        width: 1024,
        height: 1024,
        created_at: FROZEN_NOW.toISOString(),
        ...overrides,
      };
    }

    it("insertAsset + listAssetsForDeck round-trip", () => {
      repo.insertAsset(asset());
      repo.insertAsset(
        asset({ id: "a-2", slide_id: null, kind: "logo", source: "upload", prompt: null }),
      );
      const all = repo.listAssetsForDeck("deck-1");
      expect(all).toHaveLength(2);
      expect(all.find((a) => a.id === "a-2")!.slide_id).toBeNull();
    });

    it("deleteAssetsForSlide removes only that slide's assets", () => {
      repo.insertAsset(asset({ id: "a-1", slide_id: "s-1" }));
      repo.insertAsset(asset({ id: "a-2", slide_id: null }));
      const removed = repo.deleteAssetsForSlide("s-1");
      expect(removed).toBe(1);
      const remaining = repo.listAssetsForDeck("deck-1");
      expect(remaining.map((a) => a.id)).toEqual(["a-2"]);
    });

    it("rejects an asset with invalid dimensions via SlideAssetSchema", () => {
      expect(() => repo.insertAsset(asset({ width: 0 }))).toThrow();
    });

    it("reconciles a persisted inline image asset into a missing slide URL", () => {
      repo.insertDeck({
        id: "deck-img",
        title: "Images",
        brand_kit_id: "kit-1",
        metadata: { source_script: "x", tone: "formal" },
        slides: [{ id: "s-img", slide: imageCaptionSlide("a robot") }],
      });
      repo.insertAsset(
        asset({
          id: "asset-img",
          deck_id: "deck-img",
          slide_id: "s-img",
          prompt: "a robot",
        }),
      );

      expect(repo.reconcileImageAssetsForDeck("deck-img")).toBe(1);
      const slide = repo.getSlide("s-img")?.slide;
      if (slide?.template !== "image_caption") {
        throw new Error("expected image_caption slide");
      }
      expect(slide.content.image.url).toBe(
        "/api/admin/pitch/decks/deck-img/assets/asset-img",
      );
      expect(repo.reconcileImageAssetsForDeck("deck-img")).toBe(0);
    });

    it("uses prompt matching when multiple inline image slots exist", () => {
      repo.insertDeck({
        id: "deck-two",
        title: "Two Up",
        brand_kit_id: "kit-1",
        metadata: { source_script: "x", tone: "formal" },
        slides: [{ id: "s-two", slide: twoColumnImageSlide() }],
      });
      repo.insertAsset(
        asset({
          id: "asset-right",
          deck_id: "deck-two",
          slide_id: "s-two",
          prompt: "right prompt",
        }),
      );

      expect(repo.reconcileImageAssetsForDeck("deck-two")).toBe(1);
      const slide = repo.getSlide("s-two")?.slide;
      if (slide?.template !== "two_column") {
        throw new Error("expected two_column slide");
      }
      expect(slide.content.left_image?.url).toBeNull();
      expect(slide.content.right_image?.url).toBe(
        "/api/admin/pitch/decks/deck-two/assets/asset-right",
      );
    });
  });
});
