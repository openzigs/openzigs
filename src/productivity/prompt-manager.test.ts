import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "./database.js";
import {
  PromptManager,
  interpolateTemplate,
  extractVariables,
} from "./prompt-manager.js";

describe("interpolateTemplate", () => {
  it("interpolates simple variables", () => {
    expect(interpolateTemplate("Hello {{name}}!", { name: "World" })).toBe(
      "Hello World!"
    );
  });

  it("leaves missing variables as-is", () => {
    expect(interpolateTemplate("Hi {{name}}, {{greeting}}", { name: "Alice" })).toBe(
      "Hi Alice, {{greeting}}"
    );
  });

  it("handles templates with no variables", () => {
    expect(interpolateTemplate("No vars here", {})).toBe("No vars here");
  });

  it("handles multiple occurrences of same variable", () => {
    expect(
      interpolateTemplate("{{x}} and {{x}}", { x: "42" })
    ).toBe("42 and 42");
  });
});

describe("extractVariables", () => {
  it("extracts unique variable names", () => {
    expect(extractVariables("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  it("returns empty array for no variables", () => {
    expect(extractVariables("plain text")).toEqual([]);
  });
});

describe("PromptManager", () => {
  let db: Database.Database;
  let pm: PromptManager;
  const fixedNow = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    db = createTestDatabase();
    pm = new PromptManager({ db, clock: () => fixedNow });
  });

  afterEach(() => {
    db.close();
  });

  it("creates and retrieves a prompt", () => {
    const prompt = pm.create({
      name: "greeting",
      template: "Hello {{name}}!",
      description: "A greeting",
      tags: ["social"],
    });

    expect(prompt.name).toBe("greeting");
    expect(prompt.template).toBe("Hello {{name}}!");
    expect(prompt.tags).toEqual(["social"]);

    const found = pm.getById(prompt.id);
    expect(found).toEqual(prompt);
  });

  it("retrieves by name", () => {
    pm.create({ name: "test-prompt", template: "body" });
    const found = pm.getByName("test-prompt");
    expect(found?.name).toBe("test-prompt");
  });

  it("lists all prompts", () => {
    pm.create({ name: "a", template: "one" });
    pm.create({ name: "b", template: "two" });
    expect(pm.list()).toHaveLength(2);
  });

  it("searches prompts by name", () => {
    pm.create({ name: "linkedin-post", template: "Post about {{topic}}" });
    pm.create({ name: "email-reply", template: "Reply to {{name}}" });
    const results = pm.search("linkedin");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("linkedin-post");
  });

  it("updates a prompt", () => {
    const prompt = pm.create({ name: "old", template: "old template" });
    const updated = pm.update(prompt.id, {
      name: "new",
      template: "new template",
    });
    expect(updated.name).toBe("new");
    expect(updated.template).toBe("new template");
  });

  it("throws when updating nonexistent prompt", () => {
    expect(() => pm.update("nonexistent", { name: "x" })).toThrow(
      "Prompt not found"
    );
  });

  it("deletes a prompt", () => {
    const prompt = pm.create({ name: "deleteme", template: "bye" });
    expect(pm.delete(prompt.id)).toBe(true);
    expect(pm.getById(prompt.id)).toBeNull();
  });

  it("returns false when deleting nonexistent prompt", () => {
    expect(pm.delete("nonexistent")).toBe(false);
  });

  it("resolves a prompt with variables", () => {
    pm.create({ name: "greet", template: "Hi {{name}}, welcome to {{place}}!" });
    const resolved = pm.resolve("greet", { name: "Alice", place: "Wonderland" });
    expect(resolved).toBe("Hi Alice, welcome to Wonderland!");
  });

  it("returns null when resolving unknown prompt", () => {
    expect(pm.resolve("unknown")).toBeNull();
  });

  it("enforces unique names", () => {
    pm.create({ name: "unique", template: "a" });
    expect(() => pm.create({ name: "unique", template: "b" })).toThrow();
  });
});
