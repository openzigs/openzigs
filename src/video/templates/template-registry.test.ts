/**
 * Director Mode — Template Registry Tests
 * Issue #236
 */

import { describe, it, expect } from "vitest";
import { createTemplateRegistry, TEMPLATE_IDS } from "./template-registry.js";

describe("TemplateRegistry", () => {
  const registry = createTemplateRegistry();

  it("returns all 4 built-in templates", () => {
    const all = registry.getAll();
    expect(all).toHaveLength(4);
  });

  it("exposes correct TEMPLATE_IDS constant", () => {
    expect(TEMPLATE_IDS).toEqual(
      expect.arrayContaining(["Minimalist", "ContentCreator", "Corporate", "TechDemo"]),
    );
    expect(TEMPLATE_IDS).toHaveLength(4);
  });

  it("retrieves template by ID", () => {
    const t = registry.get("Minimalist");
    expect(t).toBeDefined();
    expect(t!.id).toBe("Minimalist");
    expect(t!.name).toBe("Minimalist");
    expect(t!.defaultComposition.fps).toBe(30);
  });

  it("returns undefined for unknown template ID", () => {
    expect(registry.get("NonExistent" as never)).toBeUndefined();
  });

  it("returns a default template", () => {
    const d = registry.getDefault();
    expect(d).toBeDefined();
    expect(d.id).toBe("Minimalist");
  });

  it("filters by tag", () => {
    const social = registry.getByTag("social");
    expect(social.length).toBeGreaterThanOrEqual(1);
    for (const t of social) {
      expect(t.tags).toContain("social");
    }
  });

  it("returns empty array for non-matching tag", () => {
    const none = registry.getByTag("nonexistent-tag-1234");
    expect(none).toEqual([]);
  });

  it("ContentCreator is 9:16 vertical", () => {
    const cc = registry.get("ContentCreator");
    expect(cc!.aspectRatio).toBe("9:16");
    expect(cc!.defaultComposition.width).toBe(1080);
    expect(cc!.defaultComposition.height).toBe(1920);
  });

  it("TechDemo uses JetBrains Mono and wipe-left transition", () => {
    const td = registry.get("TechDemo");
    expect(td!.fontFamily).toContain("JetBrains Mono");
    expect(td!.defaultTransition).toBe("wipe-left");
  });

  it("each template has a valid composition with width and height", () => {
    for (const t of registry.getAll()) {
      expect(t.defaultComposition.width).toBeGreaterThan(0);
      expect(t.defaultComposition.height).toBeGreaterThan(0);
      expect(t.defaultComposition.fps).toBeGreaterThan(0);
    }
  });
});
