import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { postActionRegistry } from "./post-action-registry.js";
import { CustomPostActionManager } from "./custom-post-actions.js";
import type { CustomPostActionDefinition, CustomFieldDefinition } from "./custom-post-actions.js";

/* ── Mock fs to avoid hitting disk ── */

const mockFiles = new Map<string, string>();

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (filePath: string) => {
      const content = mockFiles.get(filePath);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }
      return content;
    }),
    writeFile: vi.fn(async (filePath: string, data: string) => {
      mockFiles.set(filePath, data);
    }),
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
  },
}));

/* ── Helpers ── */

function makeWebhookDef(overrides: Partial<CustomPostActionDefinition> = {}): Omit<CustomPostActionDefinition, "createdAt" | "updatedAt"> {
  return {
    type: "custom-test-webhook",
    label: "Test Webhook",
    description: "A test webhook action",
    category: "Testing",
    templateType: "webhook",
    templateConfig: { url: "https://example.com/hook", method: "POST", includeOutput: true },
    ...overrides,
  };
}

function makeScriptDef(overrides: Partial<CustomPostActionDefinition> = {}): Omit<CustomPostActionDefinition, "createdAt" | "updatedAt"> {
  return {
    type: "custom-test-script",
    label: "Test Script",
    description: "A test script action",
    category: "Testing",
    templateType: "script",
    scriptBody: "echo hello",
    scriptTimeout: 5000,
    ...overrides,
  };
}

function makeAdvancedDef(overrides: Partial<CustomPostActionDefinition> = {}): Omit<CustomPostActionDefinition, "createdAt" | "updatedAt"> {
  const fields: CustomFieldDefinition[] = [
    { key: "channel", type: "string", title: "Channel", required: true, placeholder: "#general" },
    { key: "verbose", type: "boolean", title: "Verbose", default: false },
  ];
  return {
    type: "custom-test-advanced",
    label: "Test Advanced",
    description: "A test advanced action",
    category: "Testing",
    customFields: fields,
    scriptBody: 'echo "channel=$OPENZIGS_CONFIG_CHANNEL"',
    scriptTimeout: 10000,
    ...overrides,
  };
}

/* ── Tests ── */

describe("CustomPostActionManager", () => {
  let manager: CustomPostActionManager;

  beforeEach(() => {
    postActionRegistry.clear();
    mockFiles.clear();
    manager = new CustomPostActionManager();
  });

  afterEach(() => {
    postActionRegistry.clear();
  });

  /* ── initialize ── */

  it("initializes with an empty state when no file exists", async () => {
    await manager.initialize();
    expect(manager.size).toBe(0);
    expect(manager.list()).toEqual([]);
  });

  it("loads and registers custom actions from disk", async () => {
    const defs: CustomPostActionDefinition[] = [
      { ...makeWebhookDef(), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    ];
    // Use the exact path the module will look for
    const homeDir = (await import("node:os")).default.homedir();
    const filePath = `${homeDir}/.openzigs/custom-post-actions.json`;
    mockFiles.set(filePath, JSON.stringify(defs));

    await manager.initialize();
    expect(manager.size).toBe(1);
    expect(postActionRegistry.has("custom-test-webhook")).toBe(true);
  });

  /* ── create ── */

  it("creates a webhook template action", async () => {
    await manager.initialize();

    const created = await manager.create(makeWebhookDef());

    expect(created.type).toBe("custom-test-webhook");
    expect(created.label).toBe("Test Webhook");
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
    expect(manager.size).toBe(1);
    expect(postActionRegistry.has("custom-test-webhook")).toBe(true);

    // Verify it shows up in the registry list
    const registryList = postActionRegistry.list();
    const found = registryList.find((a) => a.type === "custom-test-webhook");
    expect(found).toBeDefined();
    expect(found!.label).toBe("Test Webhook");
    expect(found!.category).toBe("Testing");
  });

  it("creates a script template action", async () => {
    await manager.initialize();

    const created = await manager.create(makeScriptDef());

    expect(created.type).toBe("custom-test-script");
    expect(created.templateType).toBe("script");
    expect(manager.size).toBe(1);
    expect(postActionRegistry.has("custom-test-script")).toBe(true);
  });

  it("creates an advanced builder action with custom fields", async () => {
    await manager.initialize();

    const created = await manager.create(makeAdvancedDef());

    expect(created.type).toBe("custom-test-advanced");
    expect(created.customFields).toHaveLength(2);
    expect(manager.size).toBe(1);
    expect(postActionRegistry.has("custom-test-advanced")).toBe(true);

    // Check that registry has a schema with the custom fields
    const def = postActionRegistry.get("custom-test-advanced");
    expect(def).toBeDefined();
    expect(def!.configSchema.properties).toHaveProperty("channel");
    expect(def!.configSchema.properties).toHaveProperty("verbose");
    expect(def!.configSchema.required).toContain("channel");
  });

  it("throws when creating a duplicate type", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());

    await expect(manager.create(makeWebhookDef())).rejects.toThrow(
      'Post-action type "custom-test-webhook" already exists.',
    );
  });

  it("throws when type conflicts with a built-in action", async () => {
    await manager.initialize();

    // Register a built-in action first
    postActionRegistry.register({
      type: "existing-builtin",
      label: "Existing",
      description: "test",
      category: "test",
      configSchema: { type: "object", properties: {}, required: [] },
      handler: async () => "ok",
    });

    await expect(
      manager.create(makeWebhookDef({ type: "existing-builtin" })),
    ).rejects.toThrow('Post-action type "existing-builtin" already exists.');
  });

  /* ── update ── */

  it("updates an existing custom action", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());

    const updated = await manager.update("custom-test-webhook", {
      label: "Updated Webhook",
      description: "Updated description",
    });

    expect(updated.label).toBe("Updated Webhook");
    expect(updated.description).toBe("Updated description");
    expect(updated.type).toBe("custom-test-webhook"); // immutable

    // Check registry was re-registered
    const def = postActionRegistry.get("custom-test-webhook");
    expect(def).toBeDefined();
    expect(def!.label).toBe("Updated Webhook");
  });

  it("throws when updating a nonexistent type", async () => {
    await manager.initialize();
    await expect(
      manager.update("nonexistent", { label: "New" }),
    ).rejects.toThrow('Custom post-action type "nonexistent" not found.');
  });

  /* ── delete ── */

  it("deletes an existing custom action", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());
    expect(manager.size).toBe(1);

    const result = await manager.delete("custom-test-webhook");
    expect(result).toBe(true);
    expect(manager.size).toBe(0);
    expect(postActionRegistry.has("custom-test-webhook")).toBe(false);
  });

  it("returns false when deleting a nonexistent type", async () => {
    await manager.initialize();
    const result = await manager.delete("nonexistent");
    expect(result).toBe(false);
  });

  /* ── getByType ── */

  it("retrieves a custom definition by type", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());

    const found = manager.getByType("custom-test-webhook");
    expect(found).toBeDefined();
    expect(found!.label).toBe("Test Webhook");
  });

  it("returns undefined for unknown type", async () => {
    await manager.initialize();
    expect(manager.getByType("unknown")).toBeUndefined();
  });

  /* ── list ── */

  it("lists all custom definitions", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());
    await manager.create(makeScriptDef());
    await manager.create(makeAdvancedDef());

    const list = manager.list();
    expect(list).toHaveLength(3);
    // Returns copies (not references to internal array)
    expect(list).not.toBe(manager.list());
  });

  /* ── persistence ── */

  it("persists to disk on create", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());

    // Check that writeFile was called
    const fsModule = await import("node:fs/promises");
    expect(fsModule.default.writeFile).toHaveBeenCalled();
  });

  it("persists to disk on update", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());
    const fsModule = await import("node:fs/promises");
    const writeCountAfterCreate = (fsModule.default.writeFile as ReturnType<typeof vi.fn>).mock.calls.length;

    await manager.update("custom-test-webhook", { label: "Updated" });
    expect((fsModule.default.writeFile as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(writeCountAfterCreate);
  });

  it("persists to disk on delete", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());
    const fsModule = await import("node:fs/promises");
    const writeCountAfterCreate = (fsModule.default.writeFile as ReturnType<typeof vi.fn>).mock.calls.length;

    await manager.delete("custom-test-webhook");
    expect((fsModule.default.writeFile as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(writeCountAfterCreate);
  });

  /* ── registry handler integration ── */

  it("webhook handler is callable through registry execute", async () => {
    await manager.initialize();
    await manager.create(makeWebhookDef());

    // We won't actually call fetch — just verify registration allows execute
    // The handler will fail due to mocked fetch, but the structure should work
    const registered = postActionRegistry.has("custom-test-webhook");
    expect(registered).toBe(true);
  });

  it("advanced action schema includes custom fields correctly", async () => {
    await manager.initialize();
    await manager.create(makeAdvancedDef());

    const def = postActionRegistry.get("custom-test-advanced");
    expect(def).toBeDefined();
    const schema = def!.configSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties.channel).toBeDefined();
    expect(schema.properties.channel.type).toBe("string");
    expect(schema.properties.channel.title).toBe("Channel");
    expect(schema.properties.channel.placeholder).toBe("#general");
    expect(schema.properties.verbose).toBeDefined();
    expect(schema.properties.verbose.type).toBe("boolean");
    expect(schema.properties.verbose.default).toBe(false);
    expect(schema.required).toEqual(["channel"]);
  });

  /* ── Handler execution ── */

  describe("webhook handler execution", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("returns error when URL is missing", async () => {
      await manager.initialize();
      await manager.create(makeWebhookDef({ type: "wh-no-url", templateConfig: {} }));
      const def = postActionRegistry.get("wh-no-url");
      const result = await def!.handler("output", {});
      expect(JSON.parse(result).error).toContain("Webhook URL is required");
    });

    it("blocks localhost URLs (SSRF)", async () => {
      await manager.initialize();
      await manager.create(makeWebhookDef({
        type: "wh-ssrf-local",
        templateConfig: { url: "http://localhost:8080/hook" },
      }));
      const def = postActionRegistry.get("wh-ssrf-local");
      const result = await def!.handler("output", {});
      expect(JSON.parse(result).error).toContain("blocked");
    });

    it("blocks private IP URLs (SSRF)", async () => {
      await manager.initialize();
      await manager.create(makeWebhookDef({
        type: "wh-ssrf-private",
        templateConfig: { url: "http://10.0.0.1/hook" },
      }));
      const def = postActionRegistry.get("wh-ssrf-private");
      const result = await def!.handler("output", {});
      expect(JSON.parse(result).error).toContain("blocked");
    });

    it("sends webhook and returns status on success", async () => {
      await manager.initialize();
      await manager.create(makeWebhookDef({ type: "wh-ok" }));
      const def = postActionRegistry.get("wh-ok");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(""),
      }));
      const result = await def!.handler("stage output", {});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe(200);
      expect(parsed.ok).toBe(true);
    });

    it("returns error when fetch throws", async () => {
      await manager.initialize();
      await manager.create(makeWebhookDef({ type: "wh-fail" }));
      const def = postActionRegistry.get("wh-fail");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
      const result = await def!.handler("output", {});
      expect(JSON.parse(result).error).toContain("Network error");
    });
  });

  describe("script handler execution", () => {
    it("executes script and returns stdout", async () => {
      await manager.initialize();
      await manager.create(makeScriptDef({ type: "sh-echo", scriptBody: 'echo "hello"' }));
      const def = postActionRegistry.get("sh-echo");
      const result = await def!.handler("input", {});
      expect(result.trim()).toBe("hello");
    });

    it("passes config values as environment variables", async () => {
      await manager.initialize();
      await manager.create(makeScriptDef({
        type: "sh-env",
        scriptBody: 'echo "$OPENZIGS_CONFIG_MY_KEY"',
      }));
      const def = postActionRegistry.get("sh-env");
      const result = await def!.handler("input", { my_key: "test-value" });
      expect(result.trim()).toBe("test-value");
    });

    it("returns error details when script fails", async () => {
      await manager.initialize();
      await manager.create(makeScriptDef({
        type: "sh-fail",
        scriptBody: "exit 1",
      }));
      const def = postActionRegistry.get("sh-fail");
      const result = await def!.handler("input", {});
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });
  });

  describe("advanced builder schema variants", () => {
    it("handles enum fields in schema", async () => {
      await manager.initialize();
      const fields: CustomFieldDefinition[] = [
        { key: "level", type: "string", title: "Level", enum: ["low", "medium", "high"], enumLabels: ["Low", "Medium", "High"] },
      ];
      await manager.create(makeAdvancedDef({ type: "adv-enum", customFields: fields }));
      const def = postActionRegistry.get("adv-enum");
      expect(def!.configSchema.properties.level.enum).toEqual(["low", "medium", "high"]);
      expect(def!.configSchema.properties.level.enumLabels).toEqual(["Low", "Medium", "High"]);
    });

    it("handles array fields with items in schema", async () => {
      await manager.initialize();
      const fields: CustomFieldDefinition[] = [
        { key: "tags", type: "array", title: "Tags" },
      ];
      await manager.create(makeAdvancedDef({ type: "adv-array", customFields: fields }));
      const def = postActionRegistry.get("adv-array");
      expect(def!.configSchema.properties.tags.type).toBe("array");
      expect(def!.configSchema.properties.tags.items).toEqual({ type: "string" });
    });
  });
});
