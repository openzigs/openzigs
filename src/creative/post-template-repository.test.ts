import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { PostTemplateRepository } from "./post-template-repository.js";

describe("PostTemplateRepository", () => {
  let db: Database.Database;
  let repo: PostTemplateRepository;
  const clock = () => new Date("2026-04-01T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Create brand_kits table (FK dependency)
    db.exec(`
      CREATE TABLE IF NOT EXISTS brand_kits (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        primary_color TEXT NOT NULL DEFAULT '#000000',
        secondary_color TEXT NOT NULL DEFAULT '#ffffff',
        accent_color TEXT NOT NULL DEFAULT '#0066ff',
        font_family TEXT NOT NULL DEFAULT 'Inter',
        logo_path TEXT,
        watermark_path TEXT,
        intro_template_id TEXT,
        outro_template_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    repo = new PostTemplateRepository(db, clock);
    repo.migrate();
  });

  afterEach(() => {
    db.close();
  });

  it("should create a post template", () => {
    const template = repo.create({
      name: "Product Launch",
      description: "Template for product announcements",
      platform: "twitter",
      layout: "default",
      contentTemplate:
        "🚀 Introducing {{product_name}}! {{description}} #launch",
      tags: ["launch", "product"],
    });

    expect(template.id).toBeTruthy();
    expect(template.name).toBe("Product Launch");
    expect(template.platform).toBe("twitter");
    expect(template.contentTemplate).toContain("{{product_name}}");
    expect(template.tags).toEqual(["launch", "product"]);
    expect(template.createdAt).toBe("2026-04-01T12:00:00.000Z");
  });

  it("should get template by ID", () => {
    const created = repo.create({
      name: "Test",
      platform: "instagram",
      layout: "image-top",
      contentTemplate: "Hello {{name}}",
    });

    const found = repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Test");
    expect(found!.platform).toBe("instagram");
  });

  it("should return null for non-existent ID", () => {
    expect(repo.getById("nonexistent")).toBeNull();
  });

  it("should list all templates", () => {
    repo.create({
      name: "T1",
      platform: "twitter",
      layout: "default",
      contentTemplate: "a",
    });
    repo.create({
      name: "T2",
      platform: "linkedin",
      layout: "default",
      contentTemplate: "b",
    });
    repo.create({
      name: "T3",
      platform: "twitter",
      layout: "default",
      contentTemplate: "c",
    });

    const all = repo.list();
    expect(all).toHaveLength(3);
  });

  it("should filter templates by platform", () => {
    repo.create({
      name: "T1",
      platform: "twitter",
      layout: "default",
      contentTemplate: "a",
    });
    repo.create({
      name: "T2",
      platform: "linkedin",
      layout: "default",
      contentTemplate: "b",
    });

    const filtered = repo.list({ platform: "twitter" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].platform).toBe("twitter");
  });

  it("should filter templates by brand kit ID", () => {
    // Insert a brand kit to reference
    db.prepare(
      "INSERT INTO brand_kits (id, name, primary_color, secondary_color, accent_color, font_family, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "bk-1",
      "Brand A",
      "#000",
      "#fff",
      "#00f",
      "Inter",
      "2026-01-01",
      "2026-01-01",
    );

    repo.create({
      name: "T1",
      platform: "twitter",
      layout: "default",
      contentTemplate: "a",
      brandKitId: "bk-1",
    });
    repo.create({
      name: "T2",
      platform: "twitter",
      layout: "default",
      contentTemplate: "b",
    });

    const filtered = repo.list({ brandKitId: "bk-1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].brandKitId).toBe("bk-1");
  });

  it("should update a template", () => {
    const created = repo.create({
      name: "Original",
      platform: "twitter",
      layout: "default",
      contentTemplate: "old",
    });
    const updated = repo.update(created.id, {
      name: "Updated",
      contentTemplate: "new content",
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated");
    expect(updated!.contentTemplate).toBe("new content");
    expect(updated!.platform).toBe("twitter"); // unchanged
  });

  it("should return null when updating non-existent template", () => {
    expect(repo.update("nonexistent", { name: "X" })).toBeNull();
  });

  it("should delete a template", () => {
    const created = repo.create({
      name: "ToDelete",
      platform: "twitter",
      layout: "default",
      contentTemplate: "x",
    });
    expect(repo.delete(created.id)).toBe(true);
    expect(repo.getById(created.id)).toBeNull();
  });

  it("should return false when deleting non-existent template", () => {
    expect(repo.delete("nonexistent")).toBe(false);
  });

  it("should apply template with variable substitution", () => {
    const created = repo.create({
      name: "Launch",
      platform: "twitter",
      layout: "default",
      contentTemplate: "🚀 {{product}} is now live! Check it out: {{url}}",
    });

    const result = repo.applyTemplate(created.id, {
      product: "OpenZigs 2.0",
      url: "https://openzigs.dev",
    });

    expect(result).not.toBeNull();
    expect(result!.content).toBe(
      "🚀 OpenZigs 2.0 is now live! Check it out: https://openzigs.dev",
    );
    expect(result!.platform).toBe("twitter");
  });

  it("should return null when applying non-existent template", () => {
    expect(repo.applyTemplate("nonexistent", {})).toBeNull();
  });

  it("should handle variable keys with regex metacharacters safely", () => {
    const created = repo.create({
      name: "Meta",
      platform: "twitter",
      layout: "default",
      contentTemplate: "Hello {{user.name}} and {{price$}}!",
    });
    const result = repo.applyTemplate(created.id, {
      "user.name": "Alice",
      price$: "99",
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Hello Alice and 99!");
  });

  it("should set brand_kit_id to null when referenced kit is deleted", () => {
    db.prepare(
      "INSERT INTO brand_kits (id, name, primary_color, secondary_color, accent_color, font_family, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "bk-del",
      "ToDelete",
      "#000",
      "#fff",
      "#00f",
      "Inter",
      "2026-01-01",
      "2026-01-01",
    );

    const created = repo.create({
      name: "Linked",
      platform: "twitter",
      layout: "default",
      contentTemplate: "test",
      brandKitId: "bk-del",
    });
    expect(created.brandKitId).toBe("bk-del");

    db.prepare("DELETE FROM brand_kits WHERE id = ?").run("bk-del");
    const after = repo.getById(created.id);
    expect(after!.brandKitId).toBeNull();
  });
});
