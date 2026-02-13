import { describe, it, expect, beforeEach, vi } from "vitest";
import { postActionRegistry } from "./post-action-registry.js";
import type {
  PostActionDefinition,
  PostActionTypeInfo,
  ConfigSchema,
} from "./post-action-registry.js";

/* ── Helpers ── */

const dummySchema: ConfigSchema = {
  type: "object",
  properties: {
    url: { type: "string", title: "URL", placeholder: "https://..." },
    retries: {
      type: "number",
      title: "Retries",
      default: 3,
      minimum: 0,
      maximum: 10,
    },
  },
  required: ["url"],
};

function makeDef(overrides: Partial<PostActionDefinition> = {}): PostActionDefinition {
  return {
    type: "test-action",
    label: "Test Action",
    description: "A test action for specs",
    category: "Testing",
    configSchema: dummySchema,
    handler: vi.fn(async () => "handler-result"),
    ...overrides,
  };
}

/* ── Tests ── */

describe("PostActionRegistry", () => {
  beforeEach(() => {
    postActionRegistry.clear();
  });

  /* ── register ── */

  it("registers a new action type", () => {
    postActionRegistry.register(makeDef());
    expect(postActionRegistry.size).toBe(1);
    expect(postActionRegistry.has("test-action")).toBe(true);
  });

  it("throws when registering a duplicate type", () => {
    postActionRegistry.register(makeDef());
    expect(() => postActionRegistry.register(makeDef())).toThrow(
      'Post-action type "test-action" is already registered.',
    );
  });

  /* ── unregister ── */

  it("unregisters an existing type and returns true", () => {
    postActionRegistry.register(makeDef());
    expect(postActionRegistry.unregister("test-action")).toBe(true);
    expect(postActionRegistry.has("test-action")).toBe(false);
    expect(postActionRegistry.size).toBe(0);
  });

  it("returns false when unregistering an unknown type", () => {
    expect(postActionRegistry.unregister("nope")).toBe(false);
  });

  /* ── get ── */

  it("returns a registered definition by type", () => {
    const def = makeDef();
    postActionRegistry.register(def);
    expect(postActionRegistry.get("test-action")).toBe(def);
  });

  it("returns undefined for an unknown type", () => {
    expect(postActionRegistry.get("missing")).toBeUndefined();
  });

  /* ── list ── */

  it("lists all types without handlers", () => {
    postActionRegistry.register(makeDef({ type: "a", label: "A" }));
    postActionRegistry.register(makeDef({ type: "b", label: "B", icon: "🔔" }));

    const result: PostActionTypeInfo[] = postActionRegistry.list();
    expect(result).toHaveLength(2);

    // handler must be stripped
    for (const item of result) {
      expect(item).not.toHaveProperty("handler");
    }

    expect(result[0]!.type).toBe("a");
    expect(result[1]!.type).toBe("b");
    expect(result[1]!.icon).toBe("🔔");
    // configSchema should be present
    expect(result[0]!.configSchema).toEqual(dummySchema);
  });

  it("returns an empty array when nothing is registered", () => {
    expect(postActionRegistry.list()).toEqual([]);
  });

  /* ── execute ── */

  it("calls the handler with output and config", async () => {
    const handler = vi.fn(async (output: string, config: Record<string, unknown>) =>
      JSON.stringify({ output, config }),
    );
    postActionRegistry.register(makeDef({ handler }));

    const result = await postActionRegistry.execute(
      { type: "test-action", config: { url: "https://example.com" } },
      "stage output",
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("stage output", { url: "https://example.com" });
    const parsed = JSON.parse(result);
    expect(parsed.output).toBe("stage output");
    expect(parsed.config.url).toBe("https://example.com");
  });

  it("returns an error JSON for unknown types", async () => {
    const result = await postActionRegistry.execute(
      { type: "nonexistent", config: {} },
      "some output",
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Unknown post-action type: nonexistent");
  });

  it("passes an empty config when config is undefined", async () => {
    const handler = vi.fn(async (_out: string, cfg: Record<string, unknown>) =>
      JSON.stringify(cfg),
    );
    postActionRegistry.register(makeDef({ handler }));

    // config is undefined in the action — cast to satisfy TS while testing fallback
    await postActionRegistry.execute(
      { type: "test-action" } as unknown as import("./types.js").PipelinePostAction,
      "output",
    );
    expect(handler).toHaveBeenCalledWith("output", {});
  });

  /* ── has / size / clear ── */

  it("reports has correctly", () => {
    expect(postActionRegistry.has("x")).toBe(false);
    postActionRegistry.register(makeDef({ type: "x" }));
    expect(postActionRegistry.has("x")).toBe(true);
  });

  it("clear removes everything", () => {
    postActionRegistry.register(makeDef({ type: "a" }));
    postActionRegistry.register(makeDef({ type: "b" }));
    expect(postActionRegistry.size).toBe(2);
    postActionRegistry.clear();
    expect(postActionRegistry.size).toBe(0);
  });
});
