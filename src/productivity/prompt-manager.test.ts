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

  it("creates a prompt with preferredTools", () => {
    const prompt = pm.create({
      name: "scoped-prompt",
      template: "Analyze {{file}}",
      preferredTools: ["read-file", "shell-execute"],
    });

    expect(prompt.preferredTools).toEqual(["read-file", "shell-execute"]);

    const found = pm.getById(prompt.id);
    expect(found!.preferredTools).toEqual(["read-file", "shell-execute"]);
  });

  it("creates a prompt without preferredTools (null by default)", () => {
    const prompt = pm.create({ name: "no-tools", template: "plain" });
    expect(prompt.preferredTools).toBeNull();
  });

  it("updates preferredTools on a prompt", () => {
    const prompt = pm.create({ name: "updatable", template: "text" });

    const updated = pm.update(prompt.id, {
      preferredTools: ["web-search", "browser-navigate"],
    });
    expect(updated.preferredTools).toEqual(["web-search", "browser-navigate"]);
  });

  it("clears preferredTools by setting null", () => {
    const prompt = pm.create({
      name: "clearable",
      template: "text",
      preferredTools: ["web-search"],
    });
    expect(prompt.preferredTools).toEqual(["web-search"]);

    const updated = pm.update(prompt.id, { preferredTools: null });
    expect(updated.preferredTools).toBeNull();
  });

  it("resolveWithTools returns text and preferredTools", () => {
    pm.create({
      name: "tooled",
      template: "Search for {{query}}",
      preferredTools: ["web-search"],
    });

    const result = pm.resolveWithTools("tooled", { query: "AI news" });
    expect(result).toEqual({
      text: "Search for AI news",
      preferredTools: ["web-search"],
    });
  });

  it("resolveWithTools returns null preferredTools when not set", () => {
    pm.create({ name: "plain", template: "Hello" });

    const result = pm.resolveWithTools("plain");
    expect(result).toEqual({
      text: "Hello",
      preferredTools: null,
    });
  });

  it("resolveWithTools returns null for unknown prompt", () => {
    expect(pm.resolveWithTools("nonexistent")).toBeNull();
  });

  // ── Stages (pipeline) CRUD ──

  it("creates a prompt with stages", () => {
    const stages = [
      { name: "research", prompt: "Search for {{topic}}", tools: ["web-search"] },
      { name: "report", prompt: "Write a report on {{topic}}", timeoutSeconds: 600 },
    ];
    const prompt = pm.create({
      name: "staged-prompt",
      template: "Pipeline: {{topic}}",
      stages,
    });

    expect(prompt.stages).toHaveLength(2);
    expect(prompt.stages![0].name).toBe("research");
    expect(prompt.stages![0].tools).toEqual(["web-search"]);
    expect(prompt.stages![1].timeoutSeconds).toBe(600);

    const found = pm.getById(prompt.id);
    expect(found!.stages).toEqual(stages);
  });

  it("creates a prompt without stages (null by default)", () => {
    const prompt = pm.create({ name: "no-stages", template: "plain" });
    expect(prompt.stages).toBeNull();
  });

  it("updates stages on a prompt", () => {
    const prompt = pm.create({ name: "updatable-stages", template: "text" });
    const newStages = [
      { name: "step-1", prompt: "Do step 1" },
      { name: "step-2", prompt: "Do step 2" },
    ];

    const updated = pm.update(prompt.id, { stages: newStages });
    expect(updated.stages).toHaveLength(2);
    expect(updated.stages![0].name).toBe("step-1");
  });

  it("clears stages by setting null", () => {
    const stages = [{ name: "ephemeral", prompt: "Will be removed" }];
    const prompt = pm.create({
      name: "clearable-stages",
      template: "text",
      stages,
    });
    expect(prompt.stages).toHaveLength(1);

    const updated = pm.update(prompt.id, { stages: null });
    expect(updated.stages).toBeNull();
  });

  it("creates a prompt with stages containing postAction", () => {
    const stages = [
      {
        name: "review",
        prompt: "Review code",
        postAction: {
          type: "create-github-issues",
          config: { owner: "acme", repo: "app", minSeverity: "medium" },
        },
      },
    ];
    const prompt = pm.create({
      name: "postaction-prompt",
      template: "Pipeline with post-action",
      stages,
    });

    expect(prompt.stages![0].postAction).toEqual({
      type: "create-github-issues",
      config: { owner: "acme", repo: "app", minSeverity: "medium" },
    });

    const found = pm.getById(prompt.id);
    expect(found!.stages![0].postAction!.type).toBe("create-github-issues");
  });

  it("creates a prompt with stages containing autoApproveTools", () => {
    const stages = [
      {
        name: "auto-stage",
        prompt: "Run tasks",
        autoApproveTools: ["shell-execute", "write-file"],
      },
    ];
    const prompt = pm.create({
      name: "autoapprove-prompt",
      template: "Auto approve test",
      stages,
    });

    expect(prompt.stages![0].autoApproveTools).toEqual(["shell-execute", "write-file"]);
  });

  // ── resolveWithStages ──

  it("resolveWithStages returns text, preferredTools, and stages", () => {
    pm.create({
      name: "full-resolve",
      template: "Analyze {{topic}}",
      preferredTools: ["web-search"],
      stages: [
        { name: "research", prompt: "Find info about {{topic}}" },
        { name: "report", prompt: "Compile findings" },
      ],
    });

    const result = pm.resolveWithStages("full-resolve", { topic: "AI" });
    expect(result).toEqual({
      text: "Analyze AI",
      preferredTools: ["web-search"],
      stages: [
        { name: "research", prompt: "Find info about AI" },
        { name: "report", prompt: "Compile findings" },
      ],
    });
  });

  it("resolveWithStages interpolates variables in stage prompts", () => {
    pm.create({
      name: "interpolated-stages",
      template: "Pipeline for {{project}}",
      stages: [
        { name: "init", prompt: "Set up {{project}} repo" },
        { name: "test", prompt: "Test {{project}} code" },
      ],
    });

    const result = pm.resolveWithStages("interpolated-stages", { project: "acme" });
    expect(result!.stages![0].prompt).toBe("Set up acme repo");
    expect(result!.stages![1].prompt).toBe("Test acme code");
  });

  it("resolveWithStages returns null stages when not set", () => {
    pm.create({ name: "stageless", template: "No pipeline" });

    const result = pm.resolveWithStages("stageless");
    expect(result).toEqual({
      text: "No pipeline",
      preferredTools: null,
      stages: null,
    });
  });

  it("resolveWithStages returns null for unknown prompt", () => {
    expect(pm.resolveWithStages("ghost")).toBeNull();
  });

  // ── Combined stages + preferredTools ──

  it("creates a prompt with both stages and preferredTools", () => {
    const prompt = pm.create({
      name: "combo",
      template: "Multi-feature prompt",
      stages: [{ name: "s1", prompt: "Step one" }],
      preferredTools: ["read-file", "web-search"],
    });

    expect(prompt.stages).toHaveLength(1);
    expect(prompt.preferredTools).toEqual(["read-file", "web-search"]);
  });

  it("updates stages and preferredTools independently", () => {
    const prompt = pm.create({
      name: "independent-update",
      template: "text",
      stages: [{ name: "original", prompt: "original prompt" }],
      preferredTools: ["web-search"],
    });

    // Update only stages
    const u1 = pm.update(prompt.id, {
      stages: [{ name: "new-stage", prompt: "new prompt" }],
    });
    expect(u1.stages![0].name).toBe("new-stage");
    expect(u1.preferredTools).toEqual(["web-search"]); // unchanged

    // Update only preferredTools
    const u2 = pm.update(prompt.id, {
      preferredTools: ["shell-execute"],
    });
    expect(u2.stages![0].name).toBe("new-stage"); // unchanged
    expect(u2.preferredTools).toEqual(["shell-execute"]);
  });

  // ── suggestedSkill ──

  it("creates a prompt with suggestedSkill", () => {
    const prompt = pm.create({
      name: "skill-prompt",
      template: "Generate a video about {{topic}}",
      suggestedSkill: "media-director",
    });

    expect(prompt.suggestedSkill).toBe("media-director");

    const found = pm.getById(prompt.id);
    expect(found!.suggestedSkill).toBe("media-director");
  });

  it("creates a prompt without suggestedSkill (null by default)", () => {
    const prompt = pm.create({ name: "no-skill", template: "plain" });
    expect(prompt.suggestedSkill).toBeNull();
  });

  it("updates suggestedSkill on a prompt", () => {
    const prompt = pm.create({ name: "updatable-skill", template: "text" });
    expect(prompt.suggestedSkill).toBeNull();

    const updated = pm.update(prompt.id, { suggestedSkill: "remix-engineer" });
    expect(updated.suggestedSkill).toBe("remix-engineer");
  });

  it("clears suggestedSkill by setting null", () => {
    const prompt = pm.create({
      name: "clearable-skill",
      template: "text",
      suggestedSkill: "platform-manager",
    });
    expect(prompt.suggestedSkill).toBe("platform-manager");

    const updated = pm.update(prompt.id, { suggestedSkill: null });
    expect(updated.suggestedSkill).toBeNull();
  });

  it("creates a prompt with suggestedSkill, preferredTools, and stages together", () => {
    const prompt = pm.create({
      name: "full-combo",
      template: "Full featured prompt",
      suggestedSkill: "content-creator",
      preferredTools: ["manage-brand-voice", "synthesize-speech"],
      stages: [{ name: "s1", prompt: "Step one" }],
    });

    expect(prompt.suggestedSkill).toBe("content-creator");
    expect(prompt.preferredTools).toEqual(["manage-brand-voice", "synthesize-speech"]);
    expect(prompt.stages).toHaveLength(1);
  });

  it("updates suggestedSkill independently of other fields", () => {
    const prompt = pm.create({
      name: "independent-skill",
      template: "text",
      preferredTools: ["web-search"],
      suggestedSkill: "media-director",
    });

    const updated = pm.update(prompt.id, { suggestedSkill: "system-operator" });
    expect(updated.suggestedSkill).toBe("system-operator");
    expect(updated.preferredTools).toEqual(["web-search"]);
  });
});
