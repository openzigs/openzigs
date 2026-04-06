import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  BUILT_IN_TEMPLATES,
  getBuiltInTemplate,
  getBuiltInTemplatesByType,
  BrandTemplateRepository,
} from "./brand-templates.js";

describe("Brand Templates", () => {
  describe("Built-in templates", () => {
    it("has at least 3 intros", () => {
      const intros = getBuiltInTemplatesByType("intro");
      expect(intros.length).toBeGreaterThanOrEqual(3);
    });

    it("has at least 2 outros", () => {
      const outros = getBuiltInTemplatesByType("outro");
      expect(outros.length).toBeGreaterThanOrEqual(2);
    });

    it("has at least 2 lower-thirds", () => {
      const lts = getBuiltInTemplatesByType("lower-third");
      expect(lts.length).toBeGreaterThanOrEqual(2);
    });

    it("getBuiltInTemplate retrieves by ID", () => {
      const t = getBuiltInTemplate("intro-logo-fade");
      expect(t).toBeDefined();
      expect(t!.type).toBe("intro");
      expect(t!.style).toBe("logo-fade");
    });

    it("returns undefined for unknown ID", () => {
      expect(getBuiltInTemplate("nonexistent")).toBeUndefined();
    });

    it("all templates have valid animation config", () => {
      for (const t of BUILT_IN_TEMPLATES) {
        expect(t.animationConfig.fadeInFrames).toBeGreaterThan(0);
        expect(t.animationConfig.fadeOutFrames).toBeGreaterThan(0);
        expect(["ease-in", "ease-out", "ease-in-out", "spring"]).toContain(
          t.animationConfig.easing,
        );
      }
    });
  });

  describe("BrandTemplateRepository", () => {
    let db: Database.Database;
    let repo: BrandTemplateRepository;

    beforeEach(() => {
      db = new Database(":memory:");
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      repo = new BrandTemplateRepository(db);
      repo.migrate();
    });

    it("creates and retrieves a template", () => {
      const saved = repo.create({
        brandKitId: "bk-1",
        templateDefId: "intro-logo-fade",
        customTitle: "My Intro",
      });
      expect(saved.id).toBeTruthy();
      expect(saved.brandKitId).toBe("bk-1");
      expect(saved.customTitle).toBe("My Intro");

      const retrieved = repo.getById(saved.id);
      expect(retrieved).toEqual(saved);
    });

    it("lists by brand kit", () => {
      repo.create({ brandKitId: "bk-1", templateDefId: "intro-logo-fade" });
      repo.create({ brandKitId: "bk-1", templateDefId: "outro-subscribe" });
      repo.create({ brandKitId: "bk-2", templateDefId: "lt-bar" });

      const bk1 = repo.listByBrandKit("bk-1");
      expect(bk1).toHaveLength(2);

      const bk2 = repo.listByBrandKit("bk-2");
      expect(bk2).toHaveLength(1);
    });

    it("lists auto-apply templates", () => {
      repo.create({
        brandKitId: "bk-1",
        templateDefId: "intro-logo-fade",
        autoApply: true,
      });
      repo.create({
        brandKitId: "bk-1",
        templateDefId: "outro-subscribe",
        autoApply: false,
      });

      const autoApply = repo.listAutoApply("bk-1");
      expect(autoApply).toHaveLength(1);
      expect(autoApply[0].autoApply).toBe(true);
    });

    it("updates a template", () => {
      const saved = repo.create({
        brandKitId: "bk-1",
        templateDefId: "intro-logo-fade",
        customTitle: "Old Title",
      });

      const updated = repo.update(saved.id, {
        customTitle: "New Title",
        autoApply: true,
      });
      expect(updated).not.toBeNull();
      expect(updated!.customTitle).toBe("New Title");
      expect(updated!.autoApply).toBe(true);
    });

    it("returns null when updating nonexistent", () => {
      expect(repo.update("missing", { customTitle: "X" })).toBeNull();
    });

    it("deletes a template", () => {
      const saved = repo.create({
        brandKitId: "bk-1",
        templateDefId: "intro-logo-fade",
      });
      expect(repo.delete(saved.id)).toBe(true);
      expect(repo.getById(saved.id)).toBeNull();
    });

    it("returns false when deleting nonexistent", () => {
      expect(repo.delete("missing")).toBe(false);
    });
  });
});
