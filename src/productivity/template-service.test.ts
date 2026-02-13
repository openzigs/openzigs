import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PromptManager } from "./prompt-manager.js";
import { TemplateService, TemplateValidationError, PlaceholderResolutionError, getNestedValue, setNestedValue } from "./template-service.js";
import { postActionRegistry } from "../tasks/post-action-registry.js";

/* ── Helpers ──────────────────────────────────────────────────────── */

const createDb = () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE saved_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      template TEXT NOT NULL,
      description TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      preferred_tools TEXT DEFAULT NULL,
      stages TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
};

const clock = () => new Date("2026-02-13T12:00:00Z");

const makeService = () => {
  const db = createDb();
  const pm = new PromptManager({ db, clock });
  const svc = new TemplateService({
    promptManager: pm,
    postActionRegistry,
    instanceId: "test-instance",
  });
  return { db, pm, svc };
};

/* ── Test fixtures ────────────────────────────────────────────────── */

const simplePrompt = () => ({
  name: "Simple Prompt",
  template: "Hello {{name}}, welcome to {{org}}!",
  description: "Greeting template",
  tags: ["greeting", "simple"],
});

const pipelinePrompt = () => ({
  name: "Release Pipeline",
  template: "Run release checks for {{repo}}",
  description: "Multi-stage release readiness",
  tags: ["release", "ci"],
  stages: [
    {
      name: "code-scan",
      prompt: "Scan code quality",
      tools: ["shell-execute", "read-file"],
      timeoutSeconds: 300,
      postAction: {
        type: "create-github-issues",
        config: {
          owner: "mgcronin",
          repo: "openzigs",
          labels: ["automated"],
          minSeverity: "high",
        },
      },
    },
    {
      name: "notify",
      prompt: "Send notification",
      tools: ["web-search"],
      postAction: {
        type: "send-webhook",
        config: {
          url: "https://hooks.slack.com/services/secret/path",
          method: "POST",
          includeOutput: true,
        },
      },
    },
  ],
});

/* ── Setup: register built-in post-actions ────────────────────────── */

beforeEach(() => {
  postActionRegistry.clear();
  // Register the built-in types with sensitiveFields
  postActionRegistry.register({
    type: "create-github-issues",
    label: "Create GitHub Issues",
    description: "Create issues from findings",
    category: "Integrations",
    sensitiveFields: ["config.owner", "config.repo"],
    configSchema: { type: "object", properties: {}, required: [] },
    handler: async () => "ok",
  });
  postActionRegistry.register({
    type: "send-webhook",
    label: "Send Webhook",
    description: "POST to webhook",
    category: "Notifications",
    sensitiveFields: ["config.url"],
    configSchema: { type: "object", properties: {}, required: [] },
    handler: async () => "ok",
  });
});

/* ── Tests ────────────────────────────────────────────────────────── */

describe("getNestedValue / setNestedValue", () => {
  it("reads shallow and deep paths", () => {
    const obj = { a: 1, b: { c: { d: "deep" } } };
    expect(getNestedValue(obj, "a")).toBe(1);
    expect(getNestedValue(obj, "b.c.d")).toBe("deep");
    expect(getNestedValue(obj, "x.y.z")).toBeUndefined();
  });

  it("sets nested values, creating intermediates", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "a.b.c", 42);
    expect((obj.a as Record<string, unknown>).b).toEqual({ c: 42 });
  });
});

describe("TemplateService.export", () => {
  it("exports a simple prompt with no stages (no placeholders)", () => {
    const { pm, svc } = makeService();
    const saved = pm.create(simplePrompt());

    const result = svc.export(saved.id);

    expect(result.$schema).toBe("openzigs-template-v1");
    expect(result.version).toBe(1);
    expect(result.exportedFrom).toBe("test-instance");
    expect(result.prompt.name).toBe("Simple Prompt");
    expect(result.prompt.template).toBe("Hello {{name}}, welcome to {{org}}!");
    expect(result.prompt.tags).toEqual(["greeting", "simple"]);
    expect(result.prompt.stages).toBeNull();
    expect(result.placeholders).toEqual([]);
  });

  it("tokenizes sensitive fields in pipeline post-actions", () => {
    const { pm, svc } = makeService();
    const saved = pm.create(pipelinePrompt());

    const result = svc.export(saved.id);

    // Should have 3 placeholders: owner, repo, url
    expect(result.placeholders).toHaveLength(3);

    const keys = result.placeholders.map((p) => p.key);
    expect(keys).toContain("stage_0_owner");
    expect(keys).toContain("stage_0_repo");
    expect(keys).toContain("stage_1_url");

    // Sensitive values should NOT appear in stage configs
    const stagesJson = JSON.stringify(result.prompt.stages);
    expect(stagesJson).not.toContain("mgcronin");
    expect(stagesJson).not.toContain('"openzigs"');
    expect(stagesJson).not.toContain("hooks.slack.com");

    // Tokens should appear
    expect(stagesJson).toContain("{{stage_0_owner}}");
    expect(stagesJson).toContain("{{stage_0_repo}}");
    expect(stagesJson).toContain("{{stage_1_url}}");
  });

  it("preserves non-sensitive config values", () => {
    const { pm, svc } = makeService();
    const saved = pm.create(pipelinePrompt());

    const result = svc.export(saved.id);

    // Stage 0: labels and minSeverity should be preserved
    const stage0 = result.prompt.stages![0];
    expect((stage0.postAction!.config as Record<string, unknown>).labels).toEqual(["automated"]);
    expect((stage0.postAction!.config as Record<string, unknown>).minSeverity).toBe("high");

    // Stage 1: method and includeOutput should be preserved
    const stage1 = result.prompt.stages![1];
    expect((stage1.postAction!.config as Record<string, unknown>).method).toBe("POST");
    expect((stage1.postAction!.config as Record<string, unknown>).includeOutput).toBe(true);
  });

  it("throws if prompt not found", () => {
    const { svc } = makeService();
    expect(() => svc.export("nonexistent-id")).toThrow("Prompt not found");
  });

  it("handles stages with no post-actions gracefully", () => {
    const { pm, svc } = makeService();
    const saved = pm.create({
      name: "No Post-Actions",
      template: "test",
      stages: [{ name: "step-1", prompt: "do something", tools: null }],
    });

    const result = svc.export(saved.id);
    expect(result.placeholders).toEqual([]);
    expect(result.prompt.stages).toHaveLength(1);
  });
});

describe("TemplateService.analyze", () => {
  it("returns valid analysis for a well-formed template", () => {
    const { pm, svc } = makeService();
    const saved = pm.create(pipelinePrompt());
    const exported = svc.export(saved.id);

    const analysis = svc.analyze(exported);

    expect(analysis.valid).toBe(true);
    expect(analysis.errors).toEqual([]);
    expect(analysis.prompt?.name).toBe("Release Pipeline");
    expect(analysis.prompt?.stageCount).toBe(2);
    expect(analysis.placeholders).toHaveLength(3);
    expect(analysis.exportedFrom).toBe("test-instance");
  });

  it("rejects malformed JSON with clear errors", () => {
    const { svc } = makeService();

    const analysis = svc.analyze({ invalid: true });

    expect(analysis.valid).toBe(false);
    expect(analysis.errors.length).toBeGreaterThan(0);
    expect(analysis.placeholders).toEqual([]);
  });

  it("rejects wrong schema version", () => {
    const { svc } = makeService();

    const analysis = svc.analyze({
      $schema: "wrong-schema",
      version: 1,
      exportedAt: "2026-01-01",
      prompt: { name: "x", description: "", template: "t", tags: [], preferredTools: null, stages: null },
      placeholders: [],
    });

    expect(analysis.valid).toBe(false);
  });
});

describe("TemplateService.import", () => {
  it("round-trips: export → import produces identical prompt", () => {
    const { pm, svc } = makeService();
    const original = pm.create(pipelinePrompt());
    const exported = svc.export(original.id);

    // Resolve placeholders with the original values
    const resolved: Record<string, string> = {
      stage_0_owner: "mgcronin",
      stage_0_repo: "openzigs",
      stage_1_url: "https://hooks.slack.com/services/secret/path",
    };

    const imported = svc.import(exported, resolved);

    // Name gets "(imported)" suffix since the original exists
    expect(imported.name).toBe("Release Pipeline (imported)");
    expect(imported.template).toBe(original.template);
    expect(imported.description).toBe(original.description);
    expect(imported.tags).toContain("imported");
    expect(imported.tags).toContain("release");

    // Post-action configs should match original values
    const stage0 = imported.stages![0];
    expect((stage0.postAction!.config as Record<string, unknown>).owner).toBe("mgcronin");
    expect((stage0.postAction!.config as Record<string, unknown>).repo).toBe("openzigs");

    const stage1 = imported.stages![1];
    expect((stage1.postAction!.config as Record<string, unknown>).url).toBe("https://hooks.slack.com/services/secret/path");
  });

  it("imports with different environment values (cross-instance)", () => {
    const { pm, svc } = makeService();
    const original = pm.create(pipelinePrompt());
    const exported = svc.export(original.id);

    const resolved: Record<string, string> = {
      stage_0_owner: "different-org",
      stage_0_repo: "different-repo",
      stage_1_url: "https://other-webhook.example.com/hook",
    };

    const imported = svc.import(exported, resolved);

    const stage0 = imported.stages![0];
    expect((stage0.postAction!.config as Record<string, unknown>).owner).toBe("different-org");
    expect((stage0.postAction!.config as Record<string, unknown>).repo).toBe("different-repo");

    const stage1 = imported.stages![1];
    expect((stage1.postAction!.config as Record<string, unknown>).url).toBe("https://other-webhook.example.com/hook");
  });

  it("throws TemplateValidationError for invalid data", () => {
    const { svc } = makeService();

    expect(() => svc.import({ garbage: true }, {})).toThrow(TemplateValidationError);
  });

  it("throws PlaceholderResolutionError for missing required placeholders", () => {
    const { pm, svc } = makeService();
    const saved = pm.create(pipelinePrompt());
    const exported = svc.export(saved.id);

    // Only resolve 1 of 3 required placeholders
    expect(() => svc.import(exported, { stage_0_owner: "val" })).toThrow(PlaceholderResolutionError);
  });

  it("imports simple prompt without stages (no placeholders needed)", () => {
    const { pm, svc } = makeService();
    const saved = pm.create(simplePrompt());
    const exported = svc.export(saved.id);

    const imported = svc.import(exported, {});

    expect(imported.name).toBe("Simple Prompt (imported)");
    expect(imported.template).toBe("Hello {{name}}, welcome to {{org}}!");
    expect(imported.stages).toBeNull();
    expect(imported.tags).toContain("imported");
  });

  it("deduplicates names with incrementing counter", () => {
    const { pm, svc } = makeService();
    pm.create(simplePrompt()); // "Simple Prompt"
    const exported = svc.export(pm.getByName("Simple Prompt")!.id);

    const first = svc.import(exported, {});
    expect(first.name).toBe("Simple Prompt (imported)");

    const second = svc.import(exported, {});
    expect(second.name).toBe("Simple Prompt (imported 2)");

    const third = svc.import(exported, {});
    expect(third.name).toBe("Simple Prompt (imported 3)");
  });

  it("handles post-actions from unknown types gracefully", () => {
    const { pm, svc } = makeService();

    // Create a prompt with an unknown post-action type
    const saved = pm.create({
      name: "Unknown PA",
      template: "test",
      stages: [{
        name: "step",
        prompt: "do thing",
        postAction: { type: "custom:unknown-type", config: { secret: "value" } },
      }],
    });

    // Export — unknown types have no sensitiveFields, so values pass through
    const exported = svc.export(saved.id);
    expect(exported.placeholders).toEqual([]);

    // Import should still work
    const imported = svc.import(exported, {});
    expect(imported.stages![0].postAction!.type).toBe("custom:unknown-type");
    expect((imported.stages![0].postAction!.config as Record<string, unknown>).secret).toBe("value");
  });
});
