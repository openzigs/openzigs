import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { VideoPresetsRepository } from "./video-presets.js";

describe("VideoPresetsRepository", () => {
  let db: Database.Database;
  let repo: VideoPresetsRepository;
  const clock = () => new Date("2026-04-03T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    repo = new VideoPresetsRepository(db, clock);
    repo.migrate();
  });

  describe("migrate", () => {
    it("seeds 3 built-in presets", () => {
      const presets = repo.listPresets();
      expect(presets).toHaveLength(3);
      const names = presets.map((p) => p.name);
      expect(names).toContain("Quick Draft");
      expect(names).toContain("Standard");
      expect(names).toContain("High Quality");
    });

    it("marks built-in presets as isBuiltin=true", () => {
      const presets = repo.listPresets();
      for (const p of presets) {
        expect(p.isBuiltin).toBe(true);
      }
    });

    it("is idempotent — second call does not duplicate presets", () => {
      repo.migrate();
      expect(repo.listPresets()).toHaveLength(3);
    });
  });

  describe("getPreset", () => {
    it("returns a preset by id", () => {
      const preset = repo.getPreset("quick-draft");
      expect(preset).not.toBeNull();
      expect(preset!.name).toBe("Quick Draft");
      expect(preset!.config.width).toBe(512);
    });

    it("returns null for unknown id", () => {
      expect(repo.getPreset("nonexistent")).toBeNull();
    });
  });

  describe("createPreset", () => {
    it("creates a custom preset", () => {
      const preset = repo.createPreset("My Preset", "Test desc", {
        width: 640,
        height: 480,
        numFrames: 33,
        fps: 30,
        pipeline: "distilled",
      });
      expect(preset.name).toBe("My Preset");
      expect(preset.description).toBe("Test desc");
      expect(preset.isBuiltin).toBe(false);
      expect(preset.config.width).toBe(640);
      expect(preset.createdAt).toBe("2026-04-03T12:00:00.000Z");
    });

    it("rejects duplicate name", () => {
      repo.createPreset("Unique Name", null, { width: 512 });
      expect(() =>
        repo.createPreset("Unique Name", null, { width: 768 }),
      ).toThrow();
    });
  });

  describe("updatePreset", () => {
    it("updates a custom preset", () => {
      const created = repo.createPreset("Editable", null, { width: 512 });
      const updated = repo.updatePreset(created.id, {
        name: "Renamed",
        config: { width: 1024 },
      });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Renamed");
      expect(updated!.config.width).toBe(1024);
    });

    it("rejects updates to built-in presets", () => {
      expect(() =>
        repo.updatePreset("quick-draft", { name: "Hacked" }),
      ).toThrow("Cannot update built-in presets");
    });

    it("returns null for unknown id", () => {
      expect(repo.updatePreset("nonexistent", { name: "X" })).toBeNull();
    });
  });

  describe("deletePreset", () => {
    it("deletes a custom preset", () => {
      const created = repo.createPreset("Disposable", null, { fps: 30 });
      expect(repo.deletePreset(created.id)).toBe(true);
      expect(repo.getPreset(created.id)).toBeNull();
    });

    it("rejects deletion of built-in presets", () => {
      expect(() => repo.deletePreset("standard")).toThrow(
        "Cannot delete built-in presets",
      );
    });

    it("returns false for unknown id", () => {
      expect(repo.deletePreset("nonexistent")).toBe(false);
    });
  });

  describe("listPresets", () => {
    it("returns built-in presets first, then custom sorted by name", () => {
      repo.createPreset("Zebra", null, { fps: 24 });
      repo.createPreset("Alpha", null, { fps: 30 });
      const presets = repo.listPresets();
      // 3 built-in + 2 custom
      expect(presets).toHaveLength(5);
      // First 3 should be built-in
      expect(presets[0].isBuiltin).toBe(true);
      expect(presets[1].isBuiltin).toBe(true);
      expect(presets[2].isBuiltin).toBe(true);
      // Custom sorted by name
      const customNames = presets
        .filter((p) => !p.isBuiltin)
        .map((p) => p.name);
      expect(customNames).toEqual(["Alpha", "Zebra"]);
    });
  });
});
